// Files in a project's boxes are written by its agent and served from the dashboard's own origin.
// HTML/SVG/XML can carry script, and served inline they would run with the signed-in user's
// session — able to act as that person on any route. They are served with a CSP sandbox, which
// gives them an opaque origin; other types (a PDF the browser's viewer must render) are not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withCockpit } from './cockpit-instance-fixture.mjs';

test('agent-written HTML in a box is served sandboxed; a PDF is not; nothing is sniffed', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, dir }) => {
    const inbox = path.join(dir, 'workspaces', name, '_inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'evil.html'), '<script>fetch("/api/promote/requests")</script>');
    fs.writeFileSync(path.join(inbox, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    fs.writeFileSync(path.join(inbox, 'doc.pdf'), '%PDF-1.4\n');
    for (const f of ['evil.html', 'pic.svg']) {
      const r = await fetch(`${base}/file/${encodeURIComponent(name)}/${f}`);
      assert.equal(r.status, 200, f);
      assert.match(r.headers.get('content-security-policy') || '', /^sandbox;/, `${f} is sandboxed`);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
    const pdf = await fetch(`${base}/file/${encodeURIComponent(name)}/doc.pdf`);
    assert.equal(pdf.status, 200);
    assert.doesNotMatch(pdf.headers.get('content-security-policy') || '', /sandbox/, 'the PDF viewer still works');
    assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff');
  });
});
