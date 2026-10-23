import { defineChannel, GET } from 'eve/channels';
import { HOME_PAGE_HTML } from '../lib/home-page.ts';
import { DEVELOPERS_PAGE_HTML } from '../lib/developers-page.ts';

const FALLBACK_HTML = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Rove</title><p>Rove is temporarily unavailable.</p></html>';
const headers = { 'content-type': 'text/html; charset=utf-8' };

export function homeResponse(getHtml: () => string = () => HOME_PAGE_HTML): Response {
  try {
    return new Response(getHtml(), { headers });
  } catch (error) {
    console.error('Home page render failed:', error);
    return new Response(FALLBACK_HTML, { status: 503, headers });
  }
}

export default defineChannel({
  routes: [
    GET('/', async () => homeResponse()),
    GET('/developers', async () => homeResponse(() => DEVELOPERS_PAGE_HTML)),
  ],
});
