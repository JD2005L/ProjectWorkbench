// Deployment CSS must be fully contained: every rule scoped to the standalone
// deploy page (.deploy-page) or the deployment modal (#deployBackdrop), so
// enabling Deploy Centre cannot restyle unrelated cockpit UI (.button, .badge,
// .version, .muted, a, ...).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

async function getDeployCss() {
  try {
    const m = await import('../app/deploy-css.js');
    if (m.deployCss) return m.deployCss;
  } catch {}
  // Fallback (pre-fix layout): extract the inline template literal from server.js
  // so this test demonstrates the defect on the unfixed tree too.
  const src = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');
  const m = src.match(/const deployCss = `\n?([\s\S]*?)`;\n/);
  assert.ok(m, 'deployCss not found in app/deploy-css.js or app/server.js');
  return m[1];
}

// Minimal walker for this stylesheet: yields every top-level selector,
// descending into @media blocks. (No nesting/comments in this CSS.)
function collectSelectors(css) {
  const out = [];
  let buf = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      const sel = buf.trim();
      buf = '';
      if (sel.startsWith('@media')) continue; // descend into the block
      let j = i + 1;
      while (j < css.length && css[j] !== '}') j++;
      if (sel) out.push(...splitTopLevel(sel));
      i = j;
    } else if (ch === '}') {
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

function splitTopLevel(sel) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

const SCOPED = /^(body\.deploy-page|\.deploy-page(?![\w-])|#deployBackdrop(?![\w-])|:is\(\s*\.deploy-page\s*,\s*#deployBackdrop\s*\))/;

test('every deployment CSS selector is scoped to .deploy-page or #deployBackdrop', async () => {
  const css = await getDeployCss();
  const selectors = collectSelectors(css);
  assert.ok(selectors.length > 10, `expected a real stylesheet, got ${selectors.length} selectors`);
  const unscoped = selectors.filter((s) => !SCOPED.test(s));
  assert.deepEqual(unscoped, [], `unscoped deployment selectors leak into cockpit scope: ${unscoped.join(' | ')}`);
});

test('previously-leaking global selectors are no longer present bare', async () => {
  const css = await getDeployCss();
  const selectors = collectSelectors(css);
  for (const bare of ['.button', '.badge', '.version', '.muted', 'a', '.top', '.subtitle', '.project-card']) {
    assert.ok(!selectors.includes(bare), `bare global selector still injected: ${bare}`);
  }
});

test('deploy styling itself is preserved (classes still targeted, media query kept)', async () => {
  const css = await getDeployCss();
  for (const cls of ['.button', '.badge', '.version', '.muted', '.target-card', '.deploy-output', '.log-table']) {
    assert.ok(css.includes(cls), `deploy stylesheet lost its ${cls} styling`);
  }
  assert.ok(css.includes('@media'), 'responsive @media block lost');
});
