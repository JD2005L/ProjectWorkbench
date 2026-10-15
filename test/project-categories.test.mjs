// Project categories: tags assigned in Manage Projects, and a category filter dropdown at the top
// of the project rail that shows or hides the rail's projects by tag.
//
// These pin the full round trip on a real dashboard process: the manage form stores sanitized
// tags, /api/projects/config returns them, and the cockpit renders both halves the client filter
// depends on — the rows' pipe-joined data attribute and the dropdown's checkbox per category.
// The dropdown itself renders unconditionally — "Pinned only" applies with or without tags — but
// a setup with no tags gets no category options, only that one.
//
// The compile-coverage for the filter's inline JS rides on test/cockpit-client-script.test.mjs,
// which compiles every inline script of this same page; the user-visible click flow is
// test/project-categories-browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCockpit, tmux } from './cockpit-instance-fixture.mjs';

const form = (base, path, fields) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: new URLSearchParams(fields),
}).then((r) => r.json());

const configOf = async (base, name) => {
  const cfg = await fetch(`${base}/api/projects/config`).then((r) => r.json());
  assert.equal(cfg.ok, true, 'config must load');
  const p = cfg.projects.find((x) => x.name === name);
  assert.ok(p, `project ${name} must be in the config`);
  return p;
};

const cockpitHtml = async (base, name) => {
  const res = await fetch(`${base}/term/${encodeURIComponent(name)}/`);
  assert.equal(res.status, 200, 'the cockpit must render');
  return res.text();
};

test('categories round-trip: manage form → sanitized registry → config → rail markup', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name }) => {
    // Untagged baseline: config reports an empty list, and the dropdown still renders — with
    // exactly one option, "Pinned only", which applies whether or not any tags exist.
    const before = await configOf(base, name);
    assert.deepEqual(before.categories, [], 'a project starts with no categories');
    const htmlBefore = await cockpitHtml(base, name);
    assert.match(htmlBefore, /id="railFilter"/, 'the dropdown renders even with no tags');
    assert.match(htmlBefore, /id="railPinToggle"/, 'the quick toggle sits next to the dropdown');
    // The options themselves (Pinned only, one per tag, No tags) are built in the browser from the
    // rows' data-cats, so an in-place tag edit is offered at once; the server renders the frame.
    assert.match(htmlBefore, /id="railFilterOpts"/, 'the option list the client fills is rendered');
    assert.match(htmlBefore, /opt\('\|pinned','📌 Pinned only'/, 'Pinned only is always offered by the client builder');
    assert.match(htmlBefore, /id="railSearch"[^>]*type="search"/, 'the name search box renders');
    assert.match(htmlBefore, /class="pkeyRow"[^>]*data-cats=""/, 'rows carry an empty data attribute');

    // Tagging through the same form the Manage modal posts. The raw value exercises every
    // sanitization rule at once: trim, inner-whitespace collapse, case-insensitive dedup with
    // first casing kept, '|' stripped (it is the data-attribute separator), 40-char cap.
    const raw = ' Client Sites ,client sites,  Internal   Tools , we|ird , ' + 'X'.repeat(60) + ' ,,';
    const upd = await form(base, `/manage/update/${encodeURIComponent(name)}`, {
      name, repo: '', port: String(before.port), categories: raw,
    });
    assert.equal(upd.ok, true, `update must succeed: ${JSON.stringify(upd)}`);

    const after = await configOf(base, name);
    assert.deepEqual(after.categories,
      ['Client Sites', 'Internal Tools', 'weird', 'X'.repeat(40)],
      'stored categories are trimmed, collapsed, deduped case-insensitively, de-piped, capped');

    const html = await cockpitHtml(base, name);
    assert.match(html, /data-cats="Client Sites\|Internal Tools\|weird\|X{40}"/,
      'the rail row serializes the tags pipe-joined for the client filter');
    assert.match(html, /if\(tags\.length&&untagged\)opt\('\|none','No tags'/,
      'No tags is offered only when some projects are tagged and some are not');

    // A second, untagged project makes the set mixed: Uncategorized appears with its count.
    const twin = `${name}b`;
    const added = await form(base, '/manage/add', { name: twin, port: String(before.port + 1) });
    assert.equal(added.ok, true, `second project must be created: ${JSON.stringify(added)}`);
    const mixed = await cockpitHtml(base, name);
    assert.equal([...mixed.matchAll(/class="pkeyRow"[^>]*data-cats=""/g)].length, 1,
      'the mixed set is visible to the client builder: exactly one untagged row');

    // Clearing the field removes the stored key entirely (config returns [] again); the category
    // options leave with the last tag, but the dropdown itself stays for Pinned only.
    const clear = await form(base, `/manage/update/${encodeURIComponent(name)}`, {
      name, repo: '', port: String(before.port), categories: '  ,  ',
    });
    assert.equal(clear.ok, true, `clearing must succeed: ${JSON.stringify(clear)}`);
    assert.deepEqual((await configOf(base, name)).categories, [], 'clearing the field clears the tags');
    const cleared = await cockpitHtml(base, name);
    assert.doesNotMatch(cleared, /data-cats="[^"]*Client Sites/, 'the tag leaves the row, so the client no longer offers it');
    assert.match(cleared, /id="railFilter"/, 'the filter stays for Pinned only');
  });
});

test('right-click category management updates only tags and preserves the live project session', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, sock }) => {
    const html = await cockpitHtml(base, name);
    assert.match(html, /id="railCategoryMenu"/, 'admins receive the project context menu');
    assert.match(html, /addEventListener\('contextmenu'/, 'the rail opens it on right click');
    assert.match(html, /e\.key!=='ContextMenu'/, 'the keyboard ContextMenu key opens the menu');
    assert.match(html, /e\.shiftKey&&e\.key==='F10'/, 'Shift+F10 opens the same menu');
    assert.match(html, /aria-label="Organize project"/, 'the menu is labelled for what it does');
    assert.match(html, /id="railCatSelect"/, 'it offers the category');
    assert.match(html, /id="railTagChips"/, 'and the tags as badges');
    assert.match(html, /aria-label','Remove tag '\+t/, 'each badge has its own labelled remove button');
    const organize = html.slice(html.indexOf('Organizing the rail'), html.indexOf('layoutGroups();rebuildTagMenu();'));
    assert.ok(organize.length > 1000, 'sanity: the rail organize code is on the page');
    assert.doesNotMatch(organize, /location\.reload\(\)/, 'no edit reloads the page (the terminal view would restart)');

    const before = await configOf(base, name);
    const sessionBefore = (await tmux(sock, ['display-message', '-p', '-t', `pw_${name}`, '#{session_id}'])).trim();
    const response = await fetch(`${base}/api/projects/${encodeURIComponent(name)}/categories`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ categories: [' Client Sites ', 'client sites', ' Internal   Tools ', 'we|ird'] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.categories, ['Client Sites', 'Internal Tools', 'weird']);
    const after = await configOf(base, name);
    assert.deepEqual(after.categories, body.categories, 'the registry is updated');
    assert.deepEqual([after.port, after.path, after.repo], [before.port, before.path, before.repo],
      'tag-only changes preserve unrelated project fields');
    const sessionAfter = (await tmux(sock, ['display-message', '-p', '-t', `pw_${name}`, '#{session_id}'])).trim();
    assert.equal(sessionAfter, sessionBefore, 'tag-only changes do not restart or replace the project session');

    const malformed = await fetch(`${base}/api/projects/${encodeURIComponent(name)}/categories`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories: 'not-an-array' }),
    });
    assert.equal(malformed.status, 400, 'the narrow API requires an explicit string array');
    const missing = await fetch(`${base}/api/projects/does-not-exist/categories`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories: [] }),
    });
    assert.equal(missing.status, 404, 'unknown projects are not created by a tag edit');
  });
});

test('the Manage modal carries the categories field through both save paths', async () => {
  // Source seam: the modal must read the field, send it on add and on update, and refill it from
  // config — otherwise a tag assigned once would be silently erased by the next unrelated save.
  const fs = await import('node:fs');
  const server = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');
  assert.match(server, /id="pmCategories"/, 'the General pane has the input');
  const script = server.slice(server.indexOf('const manageModalScript'), server.indexOf('app.get(BASE + \'/\''));
  assert.match(script, /fCategories\.value=p&&Array\.isArray\(p\.categories\)\?p\.categories\.join\(', '\):''/,
    'fillForm restores the stored tags into the field');
  const saves = [...script.matchAll(/new URLSearchParams\(\{[^}]*categories:fCategories\.value[^}]*\}\)/g)];
  assert.equal(saves.length, 2, 'both the add and the update save paths must post the field');
});
