import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { prepareAgentPasteFile, pasteFileOwnership } from '../app/agent-paste-file.js';

test('host mode hands the private paste file to the tmux owner', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-agent-paste-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const wrapped = {
    ...fsp,
    chown: async (file, uid, gid) => { calls.push([path.basename(file), uid, gid]); },
  };
  const owner = { uid: 1000, gid: 1000, user: 'admin' };
  const out = await prepareAgentPasteFile({ fsp: wrapped, tmpRoot: root, text: 'secret prompt', ownership: pasteFileOwnership({ deployMode: 'host', owner, currentUid: 0 }) });
  t.after(out.cleanup);

  assert.equal((await fsp.stat(out.file)).mode & 0o777, 0o600, 'prompt bytes stay private');
  assert.equal((await fsp.stat(out.dir)).mode & 0o777, 0o700, 'the handoff directory stays private');
  assert.deepEqual(calls, [[path.basename(out.file), 1000, 1000], [path.basename(out.dir), 1000, 1000]],
    'the file is handed over before its directory, so the terminal owner can traverse and read it');
  assert.equal(await fsp.readFile(out.file, 'utf8'), 'secret prompt');
});

test('container mode and an already-matching uid need no ownership handoff', () => {
  const owner = { uid: 1000, gid: 1000, user: 'admin' };
  assert.equal(pasteFileOwnership({ deployMode: 'container', owner, currentUid: 0 }), null);
  assert.equal(pasteFileOwnership({ deployMode: 'host', owner, currentUid: 1000 }), null);
  assert.deepEqual(pasteFileOwnership({ deployMode: 'host', owner, currentUid: 0 }), { uid: 1000, gid: 1000 });
});

test('cleanup removes both prompt bytes and the private directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-agent-paste-clean-'));
  const out = await prepareAgentPasteFile({ fsp, tmpRoot: root, text: 'erase me', ownership: null });
  await out.cleanup();
  assert.equal(fs.existsSync(out.file), false);
  assert.equal(fs.existsSync(out.dir), false);
  fs.rmSync(root, { recursive: true, force: true });
});
