import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19)));
  }
  if (isIP(address) === 6) return /^2[0-9a-f]{3}:/i.test(address) && !/^2001:(db8|0|2):/i.test(address);
  return false;
}
export async function validateUrl(raw: string, allowed = process.env.ROVE_ALLOWED_HOSTS): Promise<URL> {
  const url = new URL(raw);
  if (!['http:','https:'].includes(url.protocol)||url.username||url.password||(url.port&&!['80','443'].includes(url.port))) throw new Error('Only public HTTP(S) URLs on standard ports are supported.');
  const host = url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  const hosts = (allowed??'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  if (process.env.NODE_ENV==='production' && !hosts.length) throw new Error('Set ROVE_ALLOWED_HOSTS before production use.');
  if (hosts.length && !hosts.includes(host)) throw new Error('This hostname is outside the configured allowlist.');
  const addresses = isIP(host) ? [{address:host}] : await lookup(host,{all:true});
  if (!addresses.length||addresses.some(x=>!publicAddress(x.address))) throw new Error('Private and reserved network targets are blocked.');
  return url;
}
