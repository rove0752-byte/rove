import { defineChannel, GET } from 'eve/channels';
import { readFileSync } from 'node:fs';

export default defineChannel({
  routes: [GET('/', async () => new Response(readFileSync('public/index.html', 'utf8'), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }))],
});
