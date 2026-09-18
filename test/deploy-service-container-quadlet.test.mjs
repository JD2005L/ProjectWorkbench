import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const generator = '/usr/lib/systemd/system-generators/podman-system-generator';

test('the installed rootless Quadlet generator accepts the packaged unit without starting it', {
  skip: process.platform !== 'linux',
}, async t => {
  try { await fs.access(generator); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('This Linux environment has no installed Quadlet generator');
    return;
  }
  const root = await fs.mkdtemp(path.join(directory, '.container-quadlet-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const template = await fs.readFile(path.join(directory, '..', 'deploy', 'container', 'pw-deploy.container.example'), 'utf8');
  const image = `sha256:${'a'.repeat(64)}`;
  await fs.writeFile(path.join(root, 'pw-deploy.container'),
    template.replace('sha256:REPLACE_WITH_REVIEWED_IMAGE_ID', image), { mode: 0o600 });
  const { stdout, stderr } = await run(generator, ['--dryrun', '--user'], {
    env: { ...process.env, QUADLET_UNIT_DIRS: root }, timeout: 15000, maxBuffer: 1024 * 1024,
  });
  assert.doesNotMatch(stderr, /unsupported key|failed|invalid|error:/i);
  assert.match(stdout, /pw-deploy\.service/);
  assert.match(stdout, /ExecStart=.*podman.*run/);
  assert.ok(stdout.includes(image));
  assert.match(stdout, /--cap-drop(?:=| )all/);
  assert.match(stdout, /--security-opt(?:=| )no-new-privileges/);
  assert.doesNotMatch(stdout, /--privileged|--network(?:=| )host|--pid(?:=| )host|label=disable/);
});
