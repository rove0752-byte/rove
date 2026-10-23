// AI Gateway auth: an AI_GATEWAY_API_KEY, or Vercel OIDC (no key). On Vercel Functions the OIDC token
// arrives per request in the `x-vercel-oidc-token` header rather than in env; @vercel/oidc (used by the
// AI Gateway provider) falls back to process.env.VERCEL_OIDC_TOKEN, so mirror the header there.
export function syncOidcToken(req: Request, env: NodeJS.ProcessEnv = process.env): void {
  const token = req.headers.get('x-vercel-oidc-token');
  if (token) env.VERCEL_OIDC_TOKEN = token;
}

export function aiConfigured(req?: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  if (req) syncOidcToken(req, env);
  return !!(env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN);
}
