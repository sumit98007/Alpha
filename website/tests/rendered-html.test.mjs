import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

async function render(pathname = '/', headers = {}) {
  const workerUrl = new URL('../dist/server/index.js', import.meta.url);
  workerUrl.searchParams.set('test', `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: 'text/html', ...headers }
    }),
    { ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} }
  );
}

test('server-renders the production landing page', async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/i);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

  const html = await response.text();
  assert.match(html, /<title>Better prompts, right where you type \| Alpha<\/title>/i);
  assert.match(html, /Think rough\./);
  assert.match(html, /Ask sharp\./);
  assert.match(html, /ChatGPT/);
  assert.match(html, /Claude/);
  assert.match(html, /Gemini/);
  assert.match(html, /Preview hosted account/);
  assert.doesNotMatch(html, /Sign in to Alpha|Open your account/);
  assert.match(html, /Skip to content/);
  assert.match(
    html,
    /property="og:image" content="https:\/\/alpha-prompt-optimizer\.sumit-512\.chatgpt\.site\/og\.png"/
  );
  assert.doesNotMatch(html, /contact details/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test('publishes privacy and trust disclosures', async () => {
  const response = await render('/privacy');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Privacy is part of the prompt pipeline/);
  assert.match(html, /Chat history is excluded unless/);
  assert.match(html, /not written to persistent Chrome storage/);
  assert.match(html, /Server-side semantic similarity caching is rejected in production/);
  assert.match(html, /Google(?:.{0,20})Gemini API/s);
  assert.match(html, /source field, request identifier, and occurrence count/);
  assert.match(html, /detection category, and placeholder-to-value map do not leave the extension/);
  assert.match(html, /host service may process composer drafts and inserted results/);
  assert.match(html, /source IP, and the authenticated account subject identifier/);
  assert.match(html, /secret-keyed HMAC identifiers/);
  assert.match(html, /quota entries[^<]*expire within 24 hours/);
  assert.match(html, /supported-site identifier: ChatGPT, Claude, or Gemini/);
  assert.match(html, /Custom guidance is stored without at-rest redaction/);
  assert.match(html, /Chrome Web Store User Data Policy/);
  assert.match(html, /Limited Use requirements/);
  assert.match(html, /does not sell user data or use it for advertising/);
});

test('supports anonymous and authenticated account states', async () => {
  const anonymous = await render('/account');
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.headers.get('cache-control'), 'private, no-store');
  const anonymousHtml = await anonymous.text();
  assert.match(anonymousHtml, /Continue with ChatGPT/);
  assert.match(anonymousHtml, /This does not sign the extension in/);

  const authenticated = await render('/account', {
    'oai-authenticated-user-email': 'person@example.com',
    'oai-authenticated-user-full-name': 'Alpha%20Tester',
    'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8'
  });
  assert.equal(authenticated.status, 200);
  const html = await authenticated.text();
  assert.match(html, /Alpha Tester/);
  assert.match(html, /person@example\.com/);
  assert.match(html, /Identity verified/);
});

test('keeps the brand font and policy routes in source', async () => {
  const [layout, css] = await Promise.all([
    readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8')
  ]);

  assert.match(layout, /SiteHeader/);
  assert.match(layout, /SiteFooter/);
  assert.match(css, /Boldonse-Regular\.ttf/);
  assert.match(css, /#fe7f2d/i);
  assert.match(css, /#233d4d/i);
  await access(new URL('../app/privacy/page.tsx', import.meta.url));
  await access(new URL('../app/terms/page.tsx', import.meta.url));
  await access(new URL('../app/security/page.tsx', import.meta.url));
  await access(new URL('../app/support/page.tsx', import.meta.url));
  await access(new URL('../app/account/page.tsx', import.meta.url));
  await access(new URL('../public/fonts/Boldonse-Regular.ttf', import.meta.url));
  await access(new URL('../public/fonts/OFL.txt', import.meta.url));
});
