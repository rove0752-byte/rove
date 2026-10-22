import { defineChannel, GET, POST } from 'eve/channels';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { z } from 'zod';
import Stripe from 'stripe';
import { inspectPage } from '../lib/browser';
import { validateUrl } from '../lib/policy';
import {
  claimExtractSlot,
  hashApiKey,
  isKvConfigured,
  applySubscriptionStatus,
  recordCompletedCheckout,
  refundExtractSlot,
} from '../lib/kv-store';

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

export default defineChannel({
  routes: [
    GET('/v1/health', async (req) => {
      if (!authorized(req)) return denied();
      return Response.json({
        service: 'rove',
        version: '0.1.0',
        browserInstalled: (existsSync(chromium.executablePath()) || process.platform === 'linux'),
        aiConfigured: !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN),
        mode: 'read_only_no_javascript',
      });
    }),

    POST('/v1/extract', async (req) => {
      if (!authorized(req)) return denied();
      if (extracting) return Response.json({ error: 'An extraction is running. Try again shortly.' }, { status: 429 });

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
      if (!authorized(req)) return denied();
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
      if (!authorized(req)) return denied();
      if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
        return Response.json({ error: 'Configure AI_GATEWAY_API_KEY to enable AI tasks.' }, { status: 503 });
      }
      if (!(existsSync(chromium.executablePath()) || process.platform === 'linux')) {
        return Response.json({ error: 'Install the browser with npx playwright install chromium.' }, { status: 503 });
      }
      try {
        const input = runSchema.parse(await body(req));
        await validateUrl(input.url);
        const runId = randomUUID();
        const session = await from(runId).send(
          JSON.stringify({ task: input.task, startUrl: input.url, outputFormat: input.outputFormat ?? 'JSON' }),
          { auth: null }
        );
        return Response.json(
          { runId, sessionId: session.id, status: 'accepted', streamUrl: `/v1/agent/runs/${session.id}/stream` },
          { status: 202 }
        );
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : 'Invalid task' }, { status: 422 });
      }
    }),

    GET('/v1/agent/runs/:id/stream', async (req, { attachSession, params }) => {
      if (!authorized(req)) return denied();
      return new Response(await attachSession(params.id).getEventStream(), {
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      });
    }),
  ],
});
