// A terminal page loads app/terminal-preload.js through nginx's sub_filter. After the swipe-scroll
// fix shipped, James's phone still ran the old script ("Did we not fix thumb scrolling on
// mobile?", 2026-10-16): the URL never changed and the response said nothing about caching, so
// Cloudflare, or the browser behind it, kept answering with a copy from the night before and the
// server never saw a request for it. The URL now carries the release, and both terminal scripts
// say no-cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withCockpit } from './cockpit-instance-fixture.mjs';

const VERSION = fs.readFileSync(new URL('../app/VERSION', import.meta.url), 'utf8').trim();

test('REGRESSION: a terminal page asks for this release\'s preload, and the terminal scripts are never served stale', { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-preload-cache-'));
  const nginxConf = path.join(tmp, 'project-workbench.conf');
  try {
    await withCockpit(async ({ base, name }) => {
      let conf = '';
      for (let i = 0; i < 40 && !conf.includes(`/pty/${name}/`); i++) {
        try { conf = fs.readFileSync(nginxConf, 'utf8'); } catch { /* not written yet */ }
        if (!conf.includes(`/pty/${name}/`)) await new Promise((r) => setTimeout(r, 150));
      }
      const tag = `<script src="/terminal-preload.js?v=${VERSION}"></script></head>`;
      const block = conf.slice(conf.indexOf(`location /pty/${name}/ {`));
      assert.ok(block.includes(`sub_filter '</head>' '${tag}';`), `the project's terminal page gets this release's preload:\n${block.slice(0, 400)}`);
      assert.doesNotMatch(conf, /terminal-preload\.js"/, 'no unversioned preload tag is left anywhere');

      for (const file of ['terminal-preload.js', 'terminal-paste.js']) {
        const res = await fetch(`${base}/${file}`);
        assert.equal(res.status, 200, file);
        assert.equal(res.headers.get('cache-control'), 'no-cache', `${file} may be kept only if it is asked for again`);
        assert.equal(await res.text(), fs.readFileSync(new URL(`../app/${file}`, import.meta.url), 'utf8'), `${file} is the copy beside server.js`);
      }
      assert.equal((await fetch(`${base}/terminal-preload.js?v=${VERSION}`)).status, 200, 'the versioned URL is the same script');
    }, { env: { PW_NGINX_CONF: nginxConf, PW_NGINX_TEST_CMD: 'true', PW_NGINX_RELOAD_CMD: 'true' } });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
