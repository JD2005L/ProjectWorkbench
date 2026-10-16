// The dashboard installs as an app on a phone (James, 2026-10-16: Android's "install as app" said
// it could not be done for this site — no page named a manifest or an icon), and the on-screen
// keyboard shrinks the cockpit instead of covering the line being typed.
//
// The installability half needs a real browser, which is not part of the canonical CI image, so it
// runs only when both are provided (see test/cockpit-tabs-browser.test.mjs):
//   PW_PLAYWRIGHT_CORE  directory of a playwright-core package
//   PW_CHROMIUM         a Chromium executable that package can drive
// Without them it is reported as SKIPPED with that reason, never as passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withCockpit } from './cockpit-instance-fixture.mjs';

const PLAYWRIGHT = process.env.PW_PLAYWRIGHT_CORE || '';
const CHROMIUM = process.env.PW_CHROMIUM || '';
const skip = PLAYWRIGHT && CHROMIUM && fs.existsSync(PLAYWRIGHT) && fs.existsSync(CHROMIUM)
  ? false
  : 'needs PW_PLAYWRIGHT_CORE and PW_CHROMIUM; a browser is not part of the canonical CI image';

const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

test('the manifest and its icons are public, and the cockpit names them', { timeout: 60000 }, async () => {
  await withCockpit(async ({ base, name }) => {
    // No session cookie anywhere below: the browser fetches these on its own.
    const res = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/manifest\+json/);
    const m = await res.json();
    assert.equal(m.name, 'Project Workbench');
    assert.equal(m.short_name, 'Workbench');
    assert.equal(m.start_url, '/');
    assert.equal(m.scope, '/');
    assert.equal(m.display, 'standalone');
    const want = { 'any:192': true, 'any:512': true, 'maskable:512': true };
    for (const icon of m.icons) {
      const r = await fetch(`${base}${icon.src}`);
      assert.equal(r.status, 200, icon.src);
      assert.equal(r.headers.get('content-type'), 'image/png');
      const { width, height } = pngSize(Buffer.from(await r.arrayBuffer()));
      assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} is the size it claims`);
      delete want[`${icon.purpose}:${width}`];
    }
    assert.deepEqual(want, {}, 'a 192 and a 512 icon, and a maskable one for Android launchers');
    assert.equal((await fetch(`${base}/icons/server.js`)).status, 404, 'only the named icon files are served');
    assert.equal((await fetch(`${base}/icons/..%2fserver.js`)).status, 404);

    const html = await fetch(`${base}/term/${encodeURIComponent(name)}/`).then((r) => r.text());
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials">/,
      'use-credentials: behind Cloudflare Access a cookieless manifest fetch gets its sign-in page instead');
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content">/,
      'the on-screen keyboard shrinks the cockpit, so the line being typed stays above it');
  });
});

test('BROWSER: Chromium finds the cockpit installable', { skip, timeout: 120000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(PLAYWRIGHT, 'index.mjs')).href);
  // A persistent profile: the default context counts as incognito, where nothing installs.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-install-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, args: ['--no-sandbox'], viewport: { width: 390, height: 760 } });
  try {
    await withCockpit(async ({ base, name }) => {
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${base}/term/${encodeURIComponent(name)}/`);
      await page.waitForSelector('#railKeys .pkey');
      const cdp = await ctx.newCDPSession(page);
      const manifest = await cdp.send('Page.getAppManifest');
      assert.deepEqual(manifest.errors, []);
      let installability = [];
      for (let i = 0; i < 20; i++) {
        ({ installabilityErrors: installability } = await cdp.send('Page.getInstallabilityErrors'));
        if (installability.length === 0) break;
        await page.waitForTimeout(250);
      }
      assert.deepEqual(installability, []);
      assert.deepEqual(errors, []);
    });
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
