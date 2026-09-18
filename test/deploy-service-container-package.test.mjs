import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateContainerConfig } from '../app/deployment/container-config.js';

const run = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, '..');
const packaging = path.join(repo, 'deploy', 'container');
const read = file => fs.readFile(path.join(packaging, file), 'utf8');

test('container example config uses separate mounted credentials, pinned image and immutable runtime authority', async () => {
  const config = validateContainerConfig(JSON.parse(await read('config.example.json')));
  assert.equal(config.mode, 'container');
  assert.equal(config.listen.host, '0.0.0.0');
  assert.notEqual(config.tokenFile, config.ui.tokenFile);
  assert.equal(config.container.runtime.user, 'app-runtime');
  assert.equal(config.defaults.maxConcurrent, 1);
  assert.match(config.container.workerImage, /^sha256:[a-f0-9]{64}$/);
});

test('image contains engine, web console and job tools without PW or host runtime installation', async () => {
  const file = await read('Containerfile');
  assert.match(file, /^FROM docker\.io\/library\/node:20-bookworm-slim/m);
  assert.match(file, /PW_DOTNET_CHANNELS="8\.0 10\.0"/);
  for (const dependency of ['openssh-client', 'python3', 'smbclient', 'krb5-user', 'util-linux', 'pywinrm', 'powershell']) {
    assert.ok(file.includes(dependency), dependency);
  }
  assert.match(file, /PODMAN_VERSION=5\.8\.2/);
  assert.match(file, /PODMAN_SHA256=88f7c21e8399a8f5edd1ef7b5c2e12b29706d0a4f24463f264a0e88d887ebbbf/);
  assert.match(file, /sha256sum --check --status/);
  const [tools, application] = file.split(/\r?\nFROM deploy-tools\r?\n/);
  assert.doesNotMatch(tools, /PW_DEPLOY_REVISION/);
  assert.match(application, /ARG PW_DEPLOY_REVISION/);
  assert.match(application, /COPY deploy\/container\/runtime-relay\.py \.\/runtime-relay\.py/);
  assert.match(file, /ENTRYPOINT \["node", "\/opt\/pw-deploy\/app\/deployment\/container-service\.js"\]/);
  assert.doesNotMatch(file, /nsenter|--privileged|systemctl|systemd-run|entrypoint\.sh/);
});

test('Quadlet uses rootless runtime facilities and separate namespace-owned secrets without broad grants', async () => {
  const file = await read('pw-deploy.container.example');
  for (const line of ['PublishPort=127.0.0.1:3800:3800', 'ReadOnly=true',
    'NoNewPrivileges=true', 'DropCapability=all', 'WantedBy=default.target']) {
    assert.ok(file.includes(line), line);
  }
  assert.equal((file.match(/^Secret=.*uid=0,gid=0,mode=0400$/gm) || []).length, 5);
  assert.doesNotMatch(file, /SecurityLabelDisable|Privileged=|Network=host|Pid=host|\/run\/podman\/podman\.sock|CapDrop=/);
  assert.match(file, /^Volume=%t\/podman\/podman\.sock:\/run\/pw-deploy\/podman\.sock:ro$/m);
});

test('proxy streams credential-bearing input and build helper exports only committed package source', async () => {
  const proxy = await read('nginx.example.conf');
  assert.equal((proxy.match(/proxy_request_buffering off;/g) || []).length, 2);
  assert.equal((proxy.match(/proxy_http_version 1\.1;/g) || []).length, 2);
  assert.doesNotMatch(proxy, /proxy_set_header Authorization|client_body_in_file_only on|access_log.*request_body/);
  const build = await read('build.sh');
  assert.match(build, /git status --porcelain=v1/);
  assert.match(build, /git archive --format=tar "\$revision"/);
  assert.match(build, /podman build --format=docker --pull=missing/);
  assert.match(build, /app\/deployment app\/atomic-file\.js app\/lifecycle-lock\.js app\/VERSION deploy\/container/);
  assert.doesNotMatch(build, /sudo|dnf |apt-get|npm install|systemctl|--privileged|git reset/);
});

test('the image COPY layout resolves the standalone entrypoint without PW or node_modules', async t => {
  const root = await fs.mkdtemp(path.join(directory, '.contained-package-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'app', 'deployment'), { recursive: true });
  for (const entry of await fs.readdir(path.join(repo, 'app', 'deployment'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) {
      await fs.copyFile(path.join(repo, 'app', 'deployment', entry.name), path.join(root, 'app', 'deployment', entry.name));
    }
  }
  for (const name of ['atomic-file.js', 'lifecycle-lock.js', 'VERSION']) {
    await fs.copyFile(path.join(repo, 'app', name), path.join(root, 'app', name));
  }
  await fs.copyFile(path.join(packaging, 'package.json'), path.join(root, 'package.json'));
  await fs.copyFile(path.join(packaging, 'health.mjs'), path.join(root, 'health.mjs'));
  await fs.copyFile(path.join(packaging, 'runtime-relay.py'), path.join(root, 'runtime-relay.py'));
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e',
    'const service=await import("./app/deployment/container-service.js"); if(typeof service.startContainerService!=="function") throw Error("missing entrypoint"); console.log("standalone imports resolved");'],
  { cwd: root, timeout: 15000 });
  assert.match(stdout, /standalone imports resolved/);
  assert.equal((await fs.readdir(root)).includes('node_modules'), false);
  await assert.rejects(fs.stat(path.join(root, 'app', 'server.js')), error => error.code === 'ENOENT');
});
