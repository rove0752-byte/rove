import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { defaultAllowStore, isHostAllowed, type AllowStore } from './allowlist.ts';
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19)));
  }
  if (isIP(address) === 6) return /^2[0-9a-f]{3}:/i.test(address) && !/^2001:(db8|0|2):/i.test(address);
  return false;
}
export class HostNotAllowedError extends Error {
  readonly code = 'host_not_allowed';
  readonly host: string;
  constructor(host: string) { super('This hostname is outside the configured allowlist.'); this.host = host; }
}
export function errorBody(e: unknown, fallback: string): { error: string; code?: string; host?: string } {
  if (e instanceof HostNotAllowedError) return { error: e.message, code: e.code, host: e.host };
  return { error: e instanceof Error ? e.message : fallback };
}
export async function validateUrl(raw: string, allowed = process.env.ROVE_ALLOWED_HOSTS, store: AllowStore | null = defaultAllowStore(),
  resolve: (host: string) => Promise<{ address: string }[]> = h => lookup(h, { all: true })): Promise<URL> {
  const url = new URL(raw);
  if (!['http:','https:'].includes(url.protocol)||url.username||url.password||(url.port&&!['80','443'].includes(url.port))) throw new Error('Only public HTTP(S) URLs on standard ports are supported.');
  const host = url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  const hosts = (allowed??'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  if (process.env.NODE_ENV==='production' && !hosts.length) throw new Error('Set ROVE_ALLOWED_HOSTS before production use.');
  // Configured ∪ Redis allowlist (exact host); the DNS/private-address check below always still applies.
  if (hosts.length && !(await isHostAllowed(host, hosts, store))) throw new HostNotAllowedError(host);
  const addresses = isIP(host) ? [{address:host}] : await resolve(host);
  if (!addresses.length||addresses.some(x=>!publicAddress(x.address))) throw new Error('Private and reserved network targets are blocked.');
  return url;
}
