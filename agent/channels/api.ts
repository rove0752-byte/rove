import { defineChannel, GET, POST } from 'eve/channels';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { z } from 'zod';
import Stripe from 'stripe';
import { inspectPage } from '../lib/browser';
import { validateUrl } from '../lib/policy';
import { aiConfigured } from '../lib/ai-config.ts';
import {
  claimExtractSlot,
  hashApiKey,
  isKvConfigured,
  applySubscriptionStatus,
  recordCompletedCheckout,
  refundExtractSlot,
  isPaidHash,
  visitorEntitlementHash,
} from '../lib/kv-store';
import { consumeTrial, cookieHeader, defaultStore, deriveSecret, newVisitorId, peekTrial, returnOrigin, readCookie, signVisitor, verifyVisitor, type TrialResult } from '../lib/trial.ts';

const runSchema = z.object({
  url: z.string().url().max(2048),
  task: z.string().min(3).max(3000),
  outputFormat: z.string().max(2000).optional(),
}).strict();

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

function authorized(req: Request) {
  const key = process.env.ROVE_API_KEY;
  if (!key) return process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(req.url).hostname);
  const actual = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function getApiKey(req: Request): string | null {
  const auth = req.headers.get('authorization');
  return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
}

async function body(req: Request) {
  const raw = await req.text();
  if (Buffer.byteLength(raw) > 10000) throw new Error('Request too large');
  return JSON.parse(raw);
}

const denied = () => Response.json({ error: 'API key required' }, { status: 401 });

let extracting = false;

// Anonymous website trial (see agent/lib/trial.ts). Only used when the request carries NO Authorization header;
// a wrong key is still rejected exactly as before.
type Trial = TrialResult & { refund: () => Promise<void>; paid?: boolean };
const hasAuthHeader = (req: Request) => req.headers.has('authorization');
const trialSecret = () => deriveSecret(process.env.ROVE_API_KEY);

function withTrial(res: Response, t: TrialResult & { paid?: boolean }): Response {
  if (t.setCookie) res.headers.append('set-cookie', t.setCookie);
  if (!t.paid) res.headers.set('x-rove-trial-remaining', String(t.remaining));
  res.headers.set('cache-control', 'no-store');
  return res;
}

const trialInfo = (t: Trial) => (t.paid ? { paid: true } : { remaining: t.remaining, resetsAt: t.resetsAt });

/** Paid visitors (upgraded via Checkout) use the paid entitlement instead of the daily trial. */
async function paidVisitorRun(req: Request): Promise<Trial | null> {
  const secret = trialSecret();
  const id = secret ? verifyVisitor(secret, readCookie(req)) : null;
  if (!id || !isKvConfigured()) return null;
  const hash = visitorEntitlementHash(id);
  if (!(await isPaidHash(hash))) return null;
  const usageKey = await claimExtractSlot(`visitor:${id}`);
  if (!usageKey) return null;
  return { ok: true, paid: true, remaining: 0, limit: 0, resetsAt: '', refund: () => refundExtractSlot(usageKey) };
}

async function startTrial(req: Request): Promise<Trial | Response> {
  const secret = trialSecret();
  if (!secret) return denied();
  let t: Trial;
  try {
    const paidRun = await paidVisitorRun(req);
    if (paidRun) return paidRun;
    t = await consumeTrial(defaultStore(), secret, req);
  } catch { return Response.json({ code: 'trial_unavailable', error: 'Free runs are temporarily unavailable. Try again shortly.' }, { status: 503 }); }
  if (!t.ok) {
    return withTrial(Response.json({ code: 'trial_exhausted', error: "You've used today's free runs.", limit: t.limit, remaining: 0, resetsAt: t.resetsAt }, { status: 402 }), t);
  }
  return t;
}

function trialCookieValid(req: Request): boolean {
  const secret = trialSecret();
  return !!secret && !!verifyVisitor(secret, readCookie(req));
}



export default defineChannel({
  routes: [
    GET('/v1/health', async (req) => {
      if (!authorized(req)) return denied();
      return Response.json({
        service: 'rove',
        version: '0.1.0',
        browserInstalled: (existsSync(chromium.executablePath()) || process.platform === 'linux'),
        aiConfigured: aiConfigured(req),
        mode: 'read_only_no_javascript',
      });
    }),

    POST('/v1/extract', async (req) => {
      const keyed = authorized(req);
      if (!keyed && hasAuthHeader(req)) return denied();
      if (extracting) return Response.json({ error: 'An extraction is running. Try again shortly.' }, { status: 429 });
      if (!keyed) {
        let input: { url: string };
        try {
          input = z.object({ url: z.string().url().max(2048) }).strict().parse(await body(req));
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : 'Invalid request' }, { status: 422 });
        }
        const t = await startTrial(req);
        if (t instanceof Response) return t;
        try {
          extracting = true;
          const result = await inspectPage(input.url);
          return withTrial(Response.json({ ...result, trial: trialInfo(t) }), t);
        } catch (e) {
          await t.refund().catch(() => {});
          return withTrial(Response.json({ error: e instanceof Error ? e.message : 'Extraction failed' }, { status: 422 }), t);
        } finally {
          extracting = false;
        }
      }

      // Parse before reserving quota so invalid payloads do not consume a slot.
      let input: { url: string };
      try {
        input = z.object({ url: z.string().url().max(2048) }).strict().parse(await body(req));
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : 'Invalid request' }, { status: 422 });
      }

      const apiKey = getApiKey(req) ?? 'anonymous';
      let usageKey: string | null;
      try {
        usageKey = await claimExtractSlot(apiKey);
      } catch (error) {
        console.error('KV quota check failed:', error);
        return Response.json({ error: 'Usage storage unavailable' }, { status: 503 });
      }
      if (!usageKey) {
        return Response.json({ error: 'Free limit reached (50/month). Upgrade via POST /v1/checkout' }, { status: 402 });
      }

      try {
        extracting = true;
        const result = await inspectPage(input.url);
        return Response.json(result);
      } catch (e) {
        // Refund failed extractions, but a process crash can leave a reservation counted.
        try {
          await refundExtractSlot(usageKey);
        } catch (refundError) {
          console.error('KV quota refund failed:', refundError);
        }
        return Response.json({ error: e instanceof Error ? e.message : 'Extraction failed' }, { status: 422 });
      } finally {
        extracting = false;
      }
    }),

    POST('/v1/checkout', async (req) => {
      const keyed = authorized(req);
      if (!keyed && hasAuthHeader(req)) return denied();
      if (!keyed) {
        // Website visitor upgrade: entitlement is tied to the signed trial cookie, never to a key.
        const secret = trialSecret();
        if (!secret) return denied();
        if (!stripe || !process.env.STRIPE_PRICE_ID) return Response.json({ error: 'Stripe not configured' }, { status: 503 });
        if (!isKvConfigured()) return Response.json({ error: 'Usage storage unavailable' }, { status: 503 });
        let id = verifyVisitor(secret, readCookie(req));
        let setCookie: string | undefined;
        if (!id) { id = newVisitorId(); setCookie = cookieHeader(signVisitor(secret, id)); }
        const hash = visitorEntitlementHash(id);
        const origin = returnOrigin(req);
        try {
          const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
            success_url: `${origin}/?success=true`,
            cancel_url: `${origin}/?canceled=true`,
            metadata: { apiKeyHash: hash, entitlement: 'visitor' },
            subscription_data: { metadata: { apiKeyHash: hash, entitlement: 'visitor' } },
          });
          const res = Response.json({ url: session.url });
          if (setCookie) res.headers.append('set-cookie', setCookie);
          res.headers.set('cache-control', 'no-store');
          return res;
        } catch (error) {
          console.error('Visitor checkout failed:', error instanceof Error ? error.message : 'unknown');
          return Response.json({ error: 'Checkout unavailable' }, { status: 503 });
        }
      }
      if (!stripe || !process.env.STRIPE_PRICE_ID) {
        return Response.json({ error: 'Stripe not configured' }, { status: 503 });
      }

      if (!isKvConfigured()) {
        return Response.json({ error: 'Usage storage unavailable' }, { status: 503 });
      }

      const apiKey = getApiKey(req);
      if (!apiKey) return denied();
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
        success_url: 'https://rovezi.com/?success=true',
        cancel_url: 'https://rovezi.com/?canceled=true',
        // Do not expose the API bearer token to Stripe metadata.
        metadata: { apiKeyHash: hashApiKey(apiKey) },
        // Copied onto the subscription so cancel/reactivate events can find the entitlement.
        subscription_data: { metadata: { apiKeyHash: hashApiKey(apiKey) } },
      });

      return Response.json({ url: session.url });
    }),

    POST('/v1/webhook', async (req) => {
      if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
        console.log('Webhook error: Stripe not configured');
        return new Response('Stripe not configured', { status: 503 });
      }

      const sig = req.headers.get('stripe-signature');
      const raw = await req.text();

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(raw, sig!, process.env.STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        console.log('Webhook signature error:', err instanceof Error ? err.message : err);
        return new Response(`Webhook signature verification failed: ${err instanceof Error ? err.message : 'unknown'}`, { status: 400 });
      }

      console.log('Webhook received:', event.type);
      if (event.type === 'checkout.session.completed') {
        const metadata = event.data.object.metadata;
        // Old Checkout Sessions used raw apiKey metadata; continue to accept them.
        const apiKeyHash = metadata?.apiKeyHash || (metadata?.apiKey ? hashApiKey(metadata.apiKey) : null);
        if (!apiKeyHash) {
          console.error('Checkout webhook missing API key metadata:', event.id);
          return new Response('Missing checkout metadata', { status: 400 });
        }
        try {
          const session = event.data.object;
          const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
          const fresh = await recordCompletedCheckout(event.id, apiKeyHash, subscriptionId);
          console.log(fresh ? 'Checkout entitlement recorded' : 'Duplicate checkout ignored', event.id);
        } catch (error) {
          console.error('KV entitlement write failed:', error);
          // Non-2xx tells Stripe to retry; never acknowledge an unwritten entitlement.
          return new Response('Entitlement storage unavailable', { status: 503 });
        }
      }

      if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
        const subscription = event.data.object;
        // A deleted subscription is always revoked, whatever status it reports.
        const status = event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status;
        try {
          const result = await applySubscriptionStatus(event.id, subscription.id, status, subscription.metadata?.apiKeyHash);
          console.log(`Subscription ${status}: ${result}`, event.id);
        } catch (error) {
          console.error('KV subscription update failed:', error);
          return new Response('Entitlement storage unavailable', { status: 503 });
        }
      }

      return Response.json({ received: true });
    }),

    POST('/v1/agent/run', async (req, { from }) => {
      const keyed = authorized(req);
      if (!keyed && hasAuthHeader(req)) return denied();
      if (!aiConfigured(req)) {
        return Response.json({ error: 'Configure AI_GATEWAY_API_KEY to enable AI tasks.' }, { status: 503 });
      }
      if (!(existsSync(chromium.executablePath()) || process.platform === 'linux')) {
        return Response.json({ error: 'Install the browser with npx playwright install chromium.' }, { status: 503 });
      }
      let trial: Trial | null = null;
      if (!keyed) {
        const t = await startTrial(req);
        if (t instanceof Response) return t;
        trial = t;
      }
      try {
        const input = runSchema.parse(await body(req));
        await validateUrl(input.url);
        const runId = randomUUID();
        const session = await from(runId).send(
          JSON.stringify({ task: input.task, startUrl: input.url, outputFormat: input.outputFormat ?? 'JSON' }),
          { auth: null }
        );
        const accepted = { runId, sessionId: session.id, status: 'accepted', streamUrl: `/v1/agent/runs/${session.id}/stream` };
        if (trial) return withTrial(Response.json({ ...accepted, trial: trialInfo(trial) }, { status: 202 }), trial);
        return Response.json(accepted, { status: 202 });
      } catch (e) {
        const res = Response.json({ error: e instanceof Error ? e.message : 'Invalid task' }, { status: 422 });
        if (trial) { await trial.refund().catch(() => {}); return withTrial(res, trial); }
        return res;
      }
    }),

    GET('/v1/trial', async (req) => {
      const secret = trialSecret();
      if (!secret) return Response.json({ code: 'trial_unavailable' }, { status: 503 });
      try {
        const id = verifyVisitor(secret, readCookie(req));
        if (id && isKvConfigured() && await isPaidHash(visitorEntitlementHash(id))) {
          return withTrial(Response.json({ paid: true }), { ok: true, paid: true, remaining: 0, limit: 0, resetsAt: '' });
        }
        const t = await peekTrial(defaultStore(), secret, req);
        return withTrial(Response.json({ remaining: t.remaining, limit: t.limit, resetsAt: t.resetsAt }), t);
      } catch {
        return Response.json({ code: 'trial_unavailable' }, { status: 503 });
      }
    }),

    GET('/v1/agent/runs/:id/stream', async (req, { attachSession, params }) => {
      // Keyed callers as before; website trial visitors may attach with their signed cookie (session ids are random UUIDs).
      if (!authorized(req) && (hasAuthHeader(req) || !trialCookieValid(req))) return denied();
      aiConfigured(req);
      const events = (await attachSession(params.id).getEventStream()) as ReadableStream<unknown>;
      const enc = new TextEncoder();
      const ndjson = events.pipeThrough(new TransformStream<unknown, Uint8Array>({
        transform(ev, ctl) {
          if (ev instanceof Uint8Array) ctl.enqueue(ev);
          else ctl.enqueue(enc.encode((typeof ev === 'string' ? ev : JSON.stringify(ev)) + '\n'));
        },
      }));
      return new Response(ndjson, {
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      });
    }),
  ],
});
