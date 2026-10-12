import { defineEvalConfig } from 'eve/evals';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';

export default defineEvalConfig({
  async setup() {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><title>Eve isolated fixture</title><body>
        <a href="/next">Next page</a><label for="name">Your name</label><input id="name">
        <button aria-label="Accessible action">Visual label</button><button disabled>Unavailable</button>
        <button hidden>Hidden control</button><input type="checkbox" aria-label="Consent">
        <form action="/submit" method="post"><button>Submit</button></form>
        <script src="/script"></script><script>document.title='UNSAFE';</script>
      </body>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    const origin = `http://127.0.0.1:${address.port}`;
    try { await writeFile('fixture-origin.json', JSON.stringify(origin)); }
    catch (error) { server.close(); throw error; }
    return { origin, requests, server };
  },
  async teardown(context) {
    if (!context) return;
    context.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => context.server.close(error => error ? reject(error) : resolve()));
  },
});
