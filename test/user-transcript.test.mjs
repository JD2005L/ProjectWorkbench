import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readUserClaudeTranscript } from '../app/user-credentials.js';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-transcript-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const username = 'kevin.test';
  const projectPath = '/opt/project-workbench/workspaces/Demo';
  const dir = path.join(base, 'kevin%2Etest', 'claude', 'projects', projectPath.replace(/\//g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return { base, username, projectPath, dir };
}

test('the credential-owner helper returns a bounded Claude transcript', async (t) => {
  const { base, username, projectPath, dir } = fixture(t);
  const session = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(dir, `${session}.jsonl`), [
    JSON.stringify({ timestamp: '2026-09-26T01:00:00Z', message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ timestamp: '2026-09-26T01:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'world' }, { type: 'tool_use', name: 'Read' }] } }),
  ].join('\n') + '\n');

  const out = await readUserClaudeTranscript({ fsp, base, username, projectPath, sessionIdHint: session, messages: 20 });
  assert.equal(out.session_id, session);
  assert.equal(out.resolved_by, 'window-marker');
  assert.deepEqual(out.messages.map((m) => [m.role, m.text]), [
    ['user', 'hello'],
    ['assistant', 'world\n[tool: Read]'],
  ]);
});

test('the helper refuses a transcript symlink instead of following it', async (t) => {
  const { base, username, projectPath, dir } = fixture(t);
  const outside = path.join(base, 'root-readable.jsonl');
  fs.writeFileSync(outside, JSON.stringify({ message: { role: 'assistant', content: 'outside secret' } }) + '\n');
  const session = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  fs.symlinkSync(outside, path.join(dir, `${session}.jsonl`));

  const out = await readUserClaudeTranscript({ fsp, base, username, projectPath, sessionIdHint: session, messages: 20 });
  assert.equal(out, null, 'a pane-controlled link is never a transcript source');
});

test('the helper refuses a transcript directory symlink instead of leaving the authorized project tree', async (t) => {
  const { base, username, projectPath, dir } = fixture(t);
  const original = `${dir}.original`;
  const outside = path.join(base, 'unrelated-project');
  fs.renameSync(dir, original);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'stolen.jsonl'), JSON.stringify({ message: { role: 'assistant', content: 'STOLEN' } }) + '\n');
  fs.symlinkSync(outside, dir, 'dir');

  const out = await readUserClaudeTranscript({ fsp, base, username, projectPath, sessionIdHint: 'stolen', messages: 20 });
  assert.equal(out, null, 'no component of the pane-owned transcript path may redirect the read');
});

test('a root dashboard delegates transcript reads instead of touching the credential tree', async () => {
  const jobs = [];
  const poisoned = new Proxy({}, { get() { return async () => assert.fail('dashboard filesystem access'); } });
  const marker = { session_id: 'delegated', resolved_by: 'window-marker', messages: [] };
  const out = await readUserClaudeTranscript({
    fsp: poisoned,
    base: '/credential-base',
    username: 'kevin.test',
    projectPath: '/workspace/demo',
    sessionIdHint: 'delegated',
    messages: 12,
    owner: { user: 'admin', uid: 1000, gid: 1000 },
    currentUid: 0,
    runJob: async (job, plan) => { jobs.push({ job, plan }); return marker; },
  });
  assert.equal(out, marker);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].job, {
    action: 'transcript', base: '/credential-base', username: 'kevin.test',
    projectPath: '/workspace/demo', sessionIdHint: 'delegated', messages: 12,
  });
  assert.equal(jobs[0].plan.drop, true);
});

test('most-recent selection considers regular jsonl files only', async (t) => {
  const { base, username, projectPath, dir } = fixture(t);
  const older = path.join(dir, 'older.jsonl');
  const newer = path.join(dir, 'newer.jsonl');
  fs.writeFileSync(older, JSON.stringify({ message: { role: 'assistant', content: 'old' } }) + '\n');
  fs.writeFileSync(newer, JSON.stringify({ message: { role: 'assistant', content: 'new' } }) + '\n');
  const now = new Date();
  fs.utimesSync(older, new Date(now.getTime() - 10000), new Date(now.getTime() - 10000));
  fs.utimesSync(newer, now, now);

  const out = await readUserClaudeTranscript({ fsp, base, username, projectPath, sessionIdHint: '', messages: 1 });
  assert.equal(out.session_id, 'newer');
  assert.equal(out.resolved_by, 'most-recent');
  assert.equal(out.messages[0].text, 'new');
});
