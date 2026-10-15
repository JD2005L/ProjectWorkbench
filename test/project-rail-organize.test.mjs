// Organizing the project rail (2026-10-15): a managed, ordered list of CATEGORIES that group the
// rail into collapsible sections (one per project, `p.categoryId`), TAGS that filter it across
// categories (still stored as `p.categories`), and a name search.
//
// These pin the server half on a real dashboard process: the category list API, the per-project
// category endpoint (a registry edit only — the live session survives it), deletion clearing every
// project that pointed at a category, the Manage form refusing an unknown category BEFORE it stops
// the terminal, and the rail markup the client groups from. The client behaviour — grouping,
// collapse, search, the tag badges — compiles under test/cockpit-client-script.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCockpit, tmux } from './cockpit-instance-fixture.mjs';

const json = (base, path, method, body) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const form = (base, path, fields) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: new URLSearchParams(fields),
}).then((r) => r.json());
const configOf = async (base, name) => {
  const cfg = await fetch(`${base}/api/projects/config`).then((r) => r.json());
  return { cfg, project: cfg.projects.find((x) => x.name === name) };
};
const cockpit = (base, name) => fetch(`${base}/term/${encodeURIComponent(name)}/`).then((r) => r.text());
const groupsOf = (html) => JSON.parse(html.match(/data-groups="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
const rowOf = (html, name) => html.match(new RegExp(`<li class="pkeyRow"[^>]*>(?=<a class="pkey[^"]*" href="[^"]*" data-project="${name}")`))?.[0];

test('the category list: ids are assigned, names cleaned, order kept, duplicates and blanks refused', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base }) => {
    assert.deepEqual((await json(base, '/api/project-categories', 'GET')).body.categories, [], 'starts empty');

    const saved = await json(base, '/api/project-categories', 'PUT', { categories: [{ name: '  Client   Work ' }, { name: 'Internal' }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.categories.map((c) => c.name), ['Client Work', 'Internal'], 'cleaned, in the order given');
    for (const c of saved.body.categories) assert.match(c.id, /^[a-z0-9]{1,24}$/, 'each new entry gets an id');

    // A rename and a reorder keep the ids.
    const [client, internal] = saved.body.categories;
    const renamed = await json(base, '/api/project-categories', 'PUT', { categories: [{ id: internal.id, name: 'Internal Tools' }, { id: client.id, name: 'Clients' }] });
    assert.deepEqual(renamed.body.categories, [{ id: internal.id, name: 'Internal Tools' }, { id: client.id, name: 'Clients' }]);
    assert.deepEqual((await json(base, '/api/project-categories', 'GET')).body.categories, renamed.body.categories, 'persisted');

    const dup = await json(base, '/api/project-categories', 'PUT', { categories: [{ name: 'A' }, { name: 'a' }] });
    assert.equal(dup.status, 400, 'names are unique case-insensitively');
    const blank = await json(base, '/api/project-categories', 'PUT', { categories: [{ name: '   ' }] });
    assert.equal(blank.status, 400, 'every category needs a name');
    assert.deepEqual((await json(base, '/api/project-categories', 'GET')).body.categories, renamed.body.categories, 'a refused save changes nothing');
  });
});

test('a project\'s category is set, rendered for grouping, and cleared — without touching its live session', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, sock }) => {
    const { body: { categories: [cat, other] } } = await json(base, '/api/project-categories', 'PUT', { categories: [{ name: 'Clients' }, { name: 'Internal' }] });
    const sessionBefore = (await tmux(sock, ['display-message', '-p', '-t', `pw_${name}`, '#{session_id}'])).trim();

    const set = await json(base, `/api/projects/${encodeURIComponent(name)}/category`, 'PUT', { categoryId: cat.id });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal((await configOf(base, name)).project.categoryId, cat.id, 'stored on the project');

    const html = await cockpit(base, name);
    assert.deepEqual(groupsOf(html), [cat, other], 'the rail is handed the ordered list to group by');
    assert.match(rowOf(html, name), new RegExp(`data-category="${cat.id}"`), 'and the row its category');
    assert.match(html, /id="railSearch"[^>]*aria-label="Search projects by name or tag"/, 'with the search box');
    assert.match(html, /const searchHit=\(row,q\)=>!q\|\|rowName\(row\)\.toLowerCase\(\)\.includes\(q\)\|\|rowTags\(row\)\.some\(/,
      'which matches a project by its name or any of its tags');

    const unknown = await json(base, `/api/projects/${encodeURIComponent(name)}/category`, 'PUT', { categoryId: 'nosuchcat' });
    assert.equal(unknown.status, 400, 'an id that is not in the list is refused');
    assert.equal((await configOf(base, name)).project.categoryId, cat.id, 'and changes nothing');
    const missing = await json(base, '/api/projects/does-not-exist/category', 'PUT', { categoryId: cat.id });
    assert.equal(missing.status, 404, 'unknown projects are not created by a category edit');

    const cleared = await json(base, `/api/projects/${encodeURIComponent(name)}/category`, 'PUT', { categoryId: null });
    assert.equal(cleared.status, 200);
    assert.equal((await configOf(base, name)).project.categoryId, '', 'null clears it');

    const sessionAfter = (await tmux(sock, ['display-message', '-p', '-t', `pw_${name}`, '#{session_id}'])).trim();
    assert.equal(sessionAfter, sessionBefore, 'category edits never restart or replace the project session');
  });
});

test('deleting a category moves its projects to Uncategorized in the same save', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name }) => {
    const { body: { categories: [doomed, kept] } } = await json(base, '/api/project-categories', 'PUT', { categories: [{ name: 'Doomed' }, { name: 'Kept' }] });
    await json(base, `/api/projects/${encodeURIComponent(name)}/category`, 'PUT', { categoryId: doomed.id });

    const after = await json(base, '/api/project-categories', 'PUT', { categories: [kept] });
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.cleared, [name], 'the save reports which projects it moved');
    assert.equal((await configOf(base, name)).project.categoryId, '', 'the project no longer points at it');
    assert.match(rowOf(await cockpit(base, name), name), /data-category=""/, 'and the rail shows it Uncategorized');
  });
});

test('the Manage form sets the category, leaves it alone when omitted, and refuses an unknown one before stopping anything', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, sock }) => {
    const { body: { categories: [cat] } } = await json(base, '/api/project-categories', 'PUT', { categories: [{ name: 'Clients' }] });
    const { cfg, project } = await configOf(base, name);
    assert.deepEqual(cfg.projectCategories, [cat], 'the form is handed the list to offer');

    const viaForm = await form(base, `/manage/update/${encodeURIComponent(name)}`, { name, repo: '', port: String(project.port), categoryId: cat.id });
    assert.equal(viaForm.ok, true, JSON.stringify(viaForm));
    assert.equal((await configOf(base, name)).project.categoryId, cat.id);

    const omitted = await form(base, `/manage/update/${encodeURIComponent(name)}`, { name, repo: '', port: String(project.port) });
    assert.equal(omitted.ok, true, JSON.stringify(omitted));
    assert.equal((await configOf(base, name)).project.categoryId, cat.id, 'a client that does not send the field cannot clear it');

    const refused = await form(base, `/manage/update/${encodeURIComponent(name)}`, { name, repo: '', port: String(project.port), categoryId: 'nosuchcat' });
    assert.equal(refused.ok, false, 'an unknown category is refused');
    assert.match(refused.error, /Unknown category/);
    const alive = await tmux(sock, ['has-session', '-t', `pw_${name}`]).then(() => true, () => false);
    assert.equal(alive, true, 'the refusal came before the terminal was stopped');
    assert.equal((await configOf(base, name)).project.categoryId, cat.id, 'and changed nothing');

    const blanked = await form(base, `/manage/update/${encodeURIComponent(name)}`, { name, repo: '', port: String(project.port), categoryId: '' });
    assert.equal(blanked.ok, true);
    assert.equal((await configOf(base, name)).project.categoryId, '', 'an explicit empty value clears it');
  });
});
