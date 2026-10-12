import { chromium, type Browser, type Page } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import bundledChromium from '@sparticuz/chromium';
import { validateUrl } from './policy.ts';

export async function launchBrowser(): Promise<Browser> {
  const options = { headless: true, timeout: 10_000 };
  if (existsSync(chromium.executablePath()) || process.platform !== 'linux') {
    return chromium.launch(options);
  }
  return chromium.launch({ ...options, args: bundledChromium.args,
    executablePath: await bundledChromium.executablePath() });
}

// Dependencies are injectable by local tests only; tools never accept policy overrides.
export function createBrowserTools(dependencies: {
  launch?: () => Promise<Browser>;
  validate?: (url: string) => Promise<URL>;
  timeoutMs?: number;
  navigationTimeoutMs?: number;
} = {}) {
  const launch = dependencies.launch ?? launchBrowser;
  const validate = dependencies.validate ?? validateUrl;
  const timeoutMs = dependencies.timeoutMs ?? 30_000;
  const navigationTimeoutMs = dependencies.navigationTimeoutMs ?? 20_000;

  async function visit<T>(raw: string, capture: (page: Page, status: number) => Promise<T>): Promise<T> {
    let browser: Browser | undefined;
    let expired = false;
    let closing: Promise<void> | undefined;
    const close = () => browser ? (closing ??= browser.close()) : Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error('Browser operation timed out.'));
        void close().catch(() => {});
      }, timeoutMs);
    });
    const work = async () => {
      if (raw.length > 2048) throw new Error('URL exceeds 2048 characters.');
      await validate(raw);
      if (expired) throw new Error('Browser operation timed out.');
      browser = await launch();
      // A startup that finishes after the deadline must not leak a process.
      if (expired) { await close(); throw new Error('Browser operation timed out.'); }
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block',
        acceptDownloads: false, viewport: { width: 1280, height: 900 } });
      context.setDefaultTimeout(5000);
      context.setDefaultNavigationTimeout(navigationTimeoutMs);
      let count = 0;
      let redirect: string | undefined;
      const page = await context.newPage();
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      page.on('download', download => { void download.cancel().catch(() => {}); });
      await context.route('**/*', async route => {
        const request = route.request();
        try {
          if (expired || ++count > 80 || !['GET', 'HEAD'].includes(request.method()) ||
              !['document', 'stylesheet', 'image', 'font'].includes(request.resourceType())) {
            await route.abort(); return;
          }
          // Only explicit main-frame navigations are permitted (no frames, popups or refresh).
          if (request.isNavigationRequest() && (request.frame() !== page.mainFrame() || request.url() !== target)) {
            await route.abort(); return;
          }
          await validate(request.url());
          // Fetch redirects explicitly: route.continue would allow redirect targets to bypass validation.
          const response = await route.fetch({ maxRedirects: 0, timeout: navigationTimeoutMs });
          const status = response.status();
          if (status >= 300 && status < 400) {
            if (request.isNavigationRequest() && response.headers().location) {
              redirect = new URL(response.headers().location, request.url()).href;
            }
            await route.fulfill({ status: 200, contentType: 'text/html', body: '' });
          } else if (/attachment/i.test(response.headers()['content-disposition'] ?? '')) {
            await route.abort();
          } else {
            await route.fulfill({ response, headers: { ...response.headers(),
              'content-security-policy': "script-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'",
            } });
          }
          await response.dispose();
        } catch { await route.abort().catch(() => {}); }
      });
      const initial = new URL(raw);
      initial.hash = '';
      let target = initial.href;
      for (let hop = 0; hop <= 5; hop++) {
        await validate(target);
        redirect = undefined;
        const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
        if (redirect) {
          if (hop === 5) throw new Error('Navigation exceeded five redirects.');
          const next = new URL(redirect);
          next.hash = '';
          target = next.href;
          continue;
        }
        if (!response || response.status() >= 400) throw new Error(`Website returned HTTP ${response?.status() ?? 'unknown'}.`);
        await validate(page.url());
        return capture(page, response.status());
      }
      throw new Error('Navigation failed.');
    };
    try { return await Promise.race([work(), deadline]); }
    finally { expired = true; clearTimeout(timer); await close(); }
  }

  async function inspectPage(raw: string) {
    const started = Date.now();
    return visit(raw, async (page, status) => {
      const content = await page.locator('body').innerText();
      // Fixed extraction only; no caller-provided JavaScript or selectors.
      const links = await page.locator('a[href]').evaluateAll(nodes => nodes.slice(0, 60).map(node => ({
        text: (node.textContent ?? '').trim().slice(0, 150), url: (node as HTMLAnchorElement).href,
      })).filter(link => /^https?:/.test(link.url)));
      const screenshot = await page.screenshot({ type: 'png', timeout: 5000 });
      return { evidenceId: randomUUID(), url: page.url(), title: await page.title(), httpStatus: status,
        capturedAt: new Date().toISOString(), text: content.slice(0, 18_000), truncated: content.length > 18_000,
        links, screenshotBase64: screenshot.toString('base64'),
        screenshotSha256: createHash('sha256').update(screenshot).digest('hex'), durationMs: Date.now() - started,
        mode: 'read_only_no_javascript' };
    });
  }

  async function navigate(raw: string) {
    return visit(raw, async (page, status) => {
      const roles = ['link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
        'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'searchbox'] as const;
      const elements: { role: string; accessibility: string; disabled: boolean }[] = [];
      let truncated = false;
      for (const role of roles) {
        const matches = page.getByRole(role);
        const count = await matches.count();
        for (let index = 0; index < count; index++) {
          if (elements.length === 60) { truncated = true; break; }
          const element = matches.nth(index);
          if (!(await element.isVisible())) continue;
          elements.push({ role, accessibility: (await element.ariaSnapshot({ timeout: 1000 })).slice(0, 1000),
            disabled: await element.isDisabled() });
        }
      }
      return { evidenceId: randomUUID(), url: page.url(), title: await page.title(), httpStatus: status,
        capturedAt: new Date().toISOString(), elements, truncated, mode: 'read_only_no_javascript' };
    });
  }
  return { inspectPage, navigate };
}

export const { inspectPage, navigate } = createBrowserTools();
