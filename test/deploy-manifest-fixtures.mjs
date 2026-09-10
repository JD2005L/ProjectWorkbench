import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function manifestDocument() {
 return {
  schemaVersion: 1,
  slots: {
   dev: {
    label: 'Publish visual identity',
    script: 'bash deploy/publish.sh "$DEPLOY_IDENTITY" "$DEPLOY_BUMP"',
    inputs: [
     {
      name: 'identity', type: 'select', label: 'Visual identity', env: 'DEPLOY_IDENTITY', required: true,
      source: {
       directory: 'identities', file: 'tokens.json', labelPath: ['$meta', 'name'],
       initialVersionPath: ['$meta', 'version'],
       version: { directory: 'releases', file: 'index.json', valuePath: ['latest'] },
      },
     },
     {
      name: 'bump', type: 'select', label: 'Version bump', env: 'DEPLOY_BUMP', required: true,
      choices: ['patch', 'minor', 'major'].map(value => ({ value, label: value })),
     },
    ],
    version: { input: 'identity', bumpInput: 'bump' },
   },
  },
 };
}

export function writeJson(root, parts, data) {
 const file = path.join(root, ...parts);
 fs.mkdirSync(path.dirname(file), { recursive: true });
 fs.writeFileSync(file, JSON.stringify(data));
 return file;
}

export function addIdentity(root, name, { label = name, initial = '1.0.0', published = null } = {}) {
 writeJson(root, ['identities', name, 'tokens.json'], { $meta: { name: label, version: initial } });
 if (published !== null) writeJson(root, ['releases', name, 'index.json'], { latest: published });
}

export function manifestWorkspace(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-deploy-manifest-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 const document = manifestDocument();
 writeJson(root, ['.pw', 'deploy.json'], document);
 addIdentity(root, 'alpha', { label: 'Alpha', published: '2.3.4' });
 addIdentity(root, 'bravo', { label: 'Bravo', initial: '1.2.0' });
 return { root, document, save: () => writeJson(root, ['.pw', 'deploy.json'], document) };
}
