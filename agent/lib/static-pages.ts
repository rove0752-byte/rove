// DRAFT legal/support pages. Every [PLACEHOLDER: ...] must be replaced and reviewed before launch.
// Inlined (like home-page.ts) so they work on Vercel without reading public/ from the function filesystem.

export type StaticPage = { title: string; body: string };

const P = (what: string) => `<mark>[PLACEHOLDER: ${what}]</mark>`;
const SUPPORT_EMAIL = P('support email, e.g. support@rovezi.com');
const COMPANY = P('company / legal entity name and ABN');

export const STATIC_PAGES: Record<string, StaticPage> = {
  '/pricing': {
    title: 'Pricing',
    body: `
<h1>Pricing</h1>
<h2>Free</h2>
<p>50 page extractions per calendar month (UTC). The allowance resets at 00:00 UTC on the 1st of each month. No card required.</p>
<h2>Paid</h2>
<p>${P('price, e.g. A$__ per month incl. GST')} per month, billed monthly through Stripe.
Paid API keys are not limited to 50 extractions per month, subject to ${P('fair-use limit, if any')}.</p>
<p>Upgrade by calling <code>POST /v1/checkout</code> with your API key. Cancel anytime; see <a href="/refund">Cancel &amp; refunds</a>.</p>
<p>AI task runs (<code>/v1/agent/run</code>) are ${P('included / billed separately / not yet available')}.</p>`,
  },
  '/terms': {
    title: 'Terms of service',
    body: `
<h1>Terms of service</h1>
<p><strong>Draft. Not yet in effect.</strong> Last updated ${P('date')}.</p>
<p>These terms are between you and ${COMPANY} ("Rove", "we").</p>
<h2>Using Rove</h2>
<ul>
<li>Rove reads public web pages only. Do not use it against sites you are not permitted to access, to bypass paywalls, logins or robots rules, or to break any law.</li>
<li>Keep your API key secret. You are responsible for activity on your key.</li>
<li>We may suspend keys that are abused or that harm the service.</li>
</ul>
<h2>Service</h2>
<p>Rove is a developer preview and is provided "as is", without uptime guarantees. Nothing in these terms excludes rights you have under the Australian Consumer Law.</p>
<h2>Liability</h2>
<p>To the extent permitted by law, our total liability is limited to ${P('cap, e.g. fees you paid in the last 3 months')}.</p>
<h2>Governing law</h2>
<p>${P('jurisdiction, e.g. Queensland, Australia')}.</p>
<p>Questions: ${SUPPORT_EMAIL}.</p>`,
  },
  '/privacy': {
    title: 'Privacy policy',
    body: `
<h1>Privacy policy</h1>
<p><strong>Draft. Not yet in effect.</strong> Last updated ${P('date')}. Operated by ${COMPANY}.</p>
<h2>What we collect</h2>
<ul>
<li>A one-way hash of your API key (never the key itself in our usage store).</li>
<li>Monthly usage counts per key.</li>
<li>Stripe customer and subscription identifiers. Card details are handled by Stripe, not us.</li>
<li>Request logs: URLs you submit, extracted page text, links and screenshots, timestamps and IP addresses.</li>
</ul>
<h2>Retention</h2>
<p>Usage counters expire about a week after each month ends. Request logs and extraction results are kept for ${P('data retention period')}.</p>
<h2>Who processes it</h2>
<p>Vercel (hosting and logs), Upstash (usage storage), Stripe (payments) and ${P('AI gateway / model provider for agent runs')}. Data may be processed outside Australia. We do not sell personal information.</p>
<h2>Your choices</h2>
<p>To access, correct or delete your data, email ${SUPPORT_EMAIL}.</p>`,
  },
  '/refund': {
    title: 'Cancel & refunds',
    body: `
<h1>Cancel &amp; refunds</h1>
<h2>Cancelling</h2>
<p>To cancel, ${P('cancel method: Stripe customer portal link and/or email')}. When the subscription ends, your key returns to the free tier of 50 extractions per month.
Your existing data is not deleted on cancellation.</p>
<h2>Refunds</h2>
<p>${P('refund policy, e.g. pro-rata refund on request within 14 days of a charge')}. Your rights under the Australian Consumer Law are not affected.</p>
<p>Contact ${SUPPORT_EMAIL} with your Stripe receipt number.</p>`,
  },
  '/support': {
    title: 'Support',
    body: `
<h1>Support</h1>
<p>Email ${SUPPORT_EMAIL}. We aim to reply within ${P('response target, e.g. 2 business days, AEST')}.</p>
<p>Please include the time of the request, the endpoint, the HTTP status and any <code>errorId</code> or <code>evidenceId</code> from the response. Never send your API key.</p>
<p>Check <a href="/status">Status</a> first if requests are failing.</p>`,
  },
  '/status': {
    title: 'Status',
    body: `
<h1>Status</h1>
<p>Live status: ${P('status page URL, e.g. a hosted status page')}.</p>
<p>Developers can check service health with <code>GET /v1/health</code> and an API key.</p>
<p>Rove is a developer preview with no uptime guarantee. Incidents are announced ${P('where: status page / email / X account')}.</p>`,
  },
};

export function renderStaticPage(page: StaticPage): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${page.title} · Rove</title>
<style>body{margin:0;background:#f5f6f2;color:#182724;font:15px/1.6 system-ui,sans-serif}main{max-width:760px;margin:48px auto;padding:0 25px}a{color:#234e3b}mark{background:#fff1b8;padding:0 3px}header,footer{max-width:760px;margin:0 auto;padding:24px 25px;font-size:13px;color:#5d6c65}</style>
<header><a href="/"><strong>rove.</strong></a></header>
<main>${page.body}
</main>
<footer><a href="/pricing">Pricing</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/refund">Cancel &amp; refunds</a> · <a href="/support">Support</a> · <a href="/status">Status</a></footer>
</html>
`;
}
