import fs from 'node:fs/promises';
import { writeFileAtomic } from '../atomic-file.js';
import { withLifecycleLock } from '../lifecycle-lock.js';
import { DeploymentError, fields, record, validateEndpoint } from './protocol.js';

export const DEFAULT_DEPLOYMENT_SETTINGS = Object.freeze({ backend: 'local', endpoint: '', credential: '' });

// The Windows account a deploy RUNS AS, per target, for the whole workbench.
// See docs/deploy-credentials.md. `dev` and `prod` are always separate fields
// even when an operator puts the same account in both: the day two accounts
// exist, nothing here has to change.
export const DEPLOY_TARGETS = Object.freeze(['dev', 'prod']);
export const DEFAULT_DEPLOY_CREDENTIALS = Object.freeze({
  dev: Object.freeze({ user: '', password: '', note: '' }),
  prod: Object.freeze({ user: '', password: '', note: '' }),
});
// `DOMAIN\user` or a bare account name. Deliberately narrow: this value is
// interpolated into SMB paths and WinRM sessions by every slot script on the box.
const DEPLOY_ACCOUNT = /^(?:[A-Za-z0-9._-]{1,64}\\)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Windows domains are case-insensitive, and slot scripts are not: AITDataHub's
// identity gate matched `^GOA\\...` literally, so a credential saved as
// `goa\james.levac` — which is what an administrator naturally types — blocked
// every deploy of that project with "not an explicit GOA Windows account". Fixing
// that per script means fixing it in every generated repository forever, so the
// domain is canonicalised HERE, once, in the one function both saving and loading
// already pass through. The account name is left exactly as entered: scripts that
// compare it do so case-insensitively, and `GOA\JAMES.LEVAC` would be a
// gratuitous change to something an operator reads.
export function canonicalDeployAccount(user) {
  const value = typeof user === 'string' ? user.trim() : '';
  const split = value.lastIndexOf('\\');
  return split < 0 ? value : `${value.slice(0, split).toUpperCase()}${value.slice(split)}`;
}

export function validateDeployAccount(user) {
  const value = canonicalDeployAccount(user);
  if (!DEPLOY_ACCOUNT.test(value)) {
    throw new DeploymentError('A deploy account must be a Windows account name, optionally DOMAIN\\user.', 400, 'deploy_account_invalid');
  }
  return value;
}

export function validateConsoleUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\0-\x20\x7f\\%]/.test(value)) {
    throw new DeploymentError('The service console URL must be a public HTTPS URL.');
  }
  if (value === '') return '';
  let url;
  try { url = new URL(value); }
  catch (error) {
    if (error instanceof TypeError) throw new DeploymentError('The service console URL must be a public HTTPS URL.');
    throw error;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname.includes('%') || /\/\.{1,2}(?:\/|$)/.test(value)) {
    throw new DeploymentError('The service console URL cannot contain credentials, query parameters or traversal.');
  }
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

function settingsError(message = 'Workbench settings are unreadable. Deployment is disabled until an administrator repairs them.') {
  return new DeploymentError(message, 503, 'deployment_settings_invalid');
}

export function validateServiceToken(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
    throw new DeploymentError('A valid deployment service credential is required.', 400, 'deployment_credential_required');
  }
  return token;
}

export function savedDeploymentSettings(settings) {
  if (!record(settings)) throw settingsError();
  if (!Object.hasOwn(settings, 'deployment')) return { ...DEFAULT_DEPLOYMENT_SETTINGS };
  const value = settings.deployment;
  try {
    fields(value, ['backend', 'endpoint', 'credential', 'consoleUrl'], 'deployment settings');
    if (!['local', 'external'].includes(value.backend)) throw settingsError();
    if (value.endpoint !== undefined && typeof value.endpoint !== 'string') throw settingsError();
    if (value.credential !== undefined && (typeof value.credential !== 'string'
        || (value.credential && !/^enc:[A-Za-z0-9+/]+={0,2}$/.test(value.credential)))) throw settingsError();
    const result = { ...DEFAULT_DEPLOYMENT_SETTINGS, ...value };
    if (value.consoleUrl !== undefined) {
      const consoleUrl = validateConsoleUrl(value.consoleUrl);
      if (consoleUrl) result.consoleUrl = consoleUrl;
      else delete result.consoleUrl;
    }
    if (result.endpoint) validateEndpoint(result.endpoint);
    if (result.backend === 'external' && !result.endpoint) throw settingsError('Saved external deployment has no endpoint. An administrator must repair the saved configuration.');
    return result;
  } catch (error) {
    if (error instanceof DeploymentError) {
      if (error.code === 'deployment_settings_invalid') throw error;
      throw settingsError('Saved deployment settings are invalid. Deployment is disabled until an administrator repairs the saved configuration.');
    }
    throw error;
  }
}

export function savedDeployCredentials(settings) {
  if (!record(settings)) throw settingsError();
  if (!Object.hasOwn(settings, 'deployCredentials')) return structuredClone(DEFAULT_DEPLOY_CREDENTIALS);
  const value = settings.deployCredentials;
  try {
    if (!record(value)) throw settingsError();
    fields(value, DEPLOY_TARGETS, 'deploy credentials');
    const result = structuredClone(DEFAULT_DEPLOY_CREDENTIALS);
    for (const target of DEPLOY_TARGETS) {
      if (!Object.hasOwn(value, target)) continue;
      const slot = value[target];
      if (!record(slot)) throw settingsError();
      fields(slot, ['user', 'password', 'note'], `${target} deploy credential`);
      const user = slot.user === undefined || slot.user === '' ? '' : validateDeployAccount(slot.user);
      const password = slot.password === undefined ? '' : slot.password;
      if (typeof password !== 'string' || (password && !/^enc:[A-Za-z0-9+/]+={0,2}$/.test(password))) throw settingsError();
      if (!!user !== !!password) throw settingsError();
      const note = slot.note === undefined ? '' : slot.note;
      if (typeof note !== 'string' || note.length > 200) throw settingsError();
      result[target] = { user, password, note };
    }
    return result;
  } catch (error) {
    if (error instanceof DeploymentError) {
      if (error.code === 'deployment_settings_invalid') throw error;
      // A malformed credential block must never read as "no credential
      // configured": that would silently deploy as whoever pressed the button.
      throw settingsError('Saved deploy credentials are invalid. Deployment is disabled until an administrator repairs them in Settings > Deployment.');
    }
    throw error;
  }
}

export function publicDeployCredentials(settings) {
  const value = savedDeployCredentials(settings);
  return Object.fromEntries(DEPLOY_TARGETS.map(target => [target, {
    user: value[target].user, note: value[target].note, hasPassword: !!value[target].password,
  }]));
}

export function publicDeploymentSettings(settings) {
  const value = savedDeploymentSettings(settings);
  return { backend: value.backend, endpoint: value.endpoint, hasCredential: !!value.credential,
    ...(value.consoleUrl ? { consoleUrl: value.consoleUrl } : {}) };
}

export function publicWorkbenchSettings(settings) {
  return { ...settings, deployment: publicDeploymentSettings(settings), deployCredentials: publicDeployCredentials(settings) };
}

// Both the old settings forms and the new backend form share the same lock.
// A general settings save cannot overwrite a concurrently rotated service token.
export function createWorkbenchSettingsStore({
  filePath, defaults = {}, encrypt, decrypt,
  // (record, decrypt) -> { state: 'none'|'stored'|'unreadable', password }. Injected
  // rather than imported: app/deploy-credential.js is part of the workbench app,
  // and this module also ships inside the standalone deployment service, which
  // carries app/deployment/** and nothing above it.
  readCredentialState = null,
  readFile = fs.readFile, writeAtomic = writeFileAtomic, withLock = withLifecycleLock,
}) {
  async function load() {
    let raw;
    try { raw = await readFile(filePath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { ...structuredClone(defaults), deployment: { ...DEFAULT_DEPLOYMENT_SETTINGS } };
      throw settingsError();
    }
    let value;
    try { value = JSON.parse(raw); }
    catch (error) {
      if (error instanceof SyntaxError) throw settingsError();
      throw error;
    }
    if (!record(value) || Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw settingsError();
    return { ...structuredClone(defaults), ...value, deployment: savedDeploymentSettings(value), deployCredentials: savedDeployCredentials(value) };
  }

  async function mutate(change) {
    return withLock(`${filePath}.lock`, async () => {
      const current = await load();
      const next = await change(current);
      savedDeploymentSettings(next);
      savedDeployCredentials(next);
      try { await writeAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }); }
      catch { throw new DeploymentError('Workbench settings could not be saved.', 503, 'deployment_settings_write_failed'); }
      return next;
    });
  }

  function updateGeneral(patch) {
    if (!record(patch)) throw settingsError();
    return mutate(current => {
      const next = { ...current };
      for (const key of Object.keys(defaults)) {
        // Neither sub-store is reachable from a general settings save: a wizard
        // page posting its own form must not be able to blank a credential.
        if (key !== 'deployment' && key !== 'deployCredentials' && Object.hasOwn(patch, key)) next[key] = patch[key];
      }
      return next;
    });
  }

  function decryptCredential(credential) {
    if (!credential) throw new DeploymentError('External deployment requires a saved service credential.', 503, 'deployment_credential_required');
    try { return validateServiceToken(decrypt(credential)); }
    catch { throw new DeploymentError('The saved deployment credential cannot be decrypted. Replace it in Settings > Deployment.', 503, 'deployment_credential_invalid'); }
  }

  async function applyDraft(current, draft, { persist = false } = {}) {
    fields(draft, persist ? ['backend', 'endpoint', 'token', 'clearToken', 'consoleUrl'] : ['endpoint', 'token'], 'deployment settings update');
    const next = { ...savedDeploymentSettings(current) };
    if (persist && Object.hasOwn(draft, 'backend')) {
      if (!['local', 'external'].includes(draft.backend)) throw new DeploymentError('Execution backend must be local or external.');
      next.backend = draft.backend;
    }
    if (Object.hasOwn(draft, 'endpoint')) {
      if (typeof draft.endpoint !== 'string') throw new DeploymentError('Deployment endpoint must be text.');
      next.endpoint = draft.endpoint.trim();
      if (next.endpoint) next.endpoint = validateEndpoint(next.endpoint).endpoint;
    }
    if (persist && Object.hasOwn(draft, 'consoleUrl')) {
      const consoleUrl = validateConsoleUrl(typeof draft.consoleUrl === 'string' ? draft.consoleUrl.trim() : draft.consoleUrl);
      if (consoleUrl) next.consoleUrl = consoleUrl;
      else delete next.consoleUrl;
    }
    if (Object.hasOwn(draft, 'clearToken') && typeof draft.clearToken !== 'boolean') throw new DeploymentError('clearToken must be boolean.');
    if (Object.hasOwn(draft, 'token') && typeof draft.token !== 'string') throw new DeploymentError('Deployment credential must be text.');
    if (draft.clearToken && draft.token) throw new DeploymentError('Choose either a replacement credential or Clear credential.');
    if (draft.clearToken) next.credential = '';
    // An empty password field means "keep", including on old browser forms.
    if (draft.token) {
      validateServiceToken(draft.token);
      try { next.credential = encrypt(draft.token); }
      catch { throw new DeploymentError('The deployment credential could not be encrypted. Check the workbench encryption key.', 503, 'deployment_credential_invalid'); }
    }
    if ((persist && next.backend === 'external') || !persist) {
      if (!next.endpoint) throw new DeploymentError('An external deployment endpoint is required.');
      validateEndpoint(next.endpoint);
      decryptCredential(next.credential);
    }
    return next;
  }

  // One target's account+password, under the same lock as the backend settings:
  // a credential rotation and a backend save cannot clobber each other.
  async function updateDeployCredential(draft) {
    if (!record(draft)) throw settingsError();
    fields(draft, ['target', 'user', 'password', 'note', 'clear'], 'deploy credential update');
    if (!DEPLOY_TARGETS.includes(draft.target)) throw new DeploymentError('Deploy credential target must be dev or prod.', 400, 'deploy_credential_target_invalid');
    if (Object.hasOwn(draft, 'clear') && typeof draft.clear !== 'boolean') throw new DeploymentError('clear must be boolean.', 400, 'deploy_credential_invalid');
    if (draft.clear && (draft.password || draft.user)) throw new DeploymentError('Choose either a replacement credential or Clear.', 400, 'deploy_credential_invalid');
    const next = await mutate(current => {
      const credentials = savedDeployCredentials(current);
      const slot = { ...credentials[draft.target] };
      if (draft.clear) Object.assign(slot, { user: '', password: '', note: '' });
      else {
        if (Object.hasOwn(draft, 'user')) slot.user = draft.user === '' ? '' : validateDeployAccount(draft.user);
        if (Object.hasOwn(draft, 'note')) {
          if (typeof draft.note !== 'string' || draft.note.length > 200) throw new DeploymentError('A deploy credential note must be text of at most 200 characters.', 400, 'deploy_credential_invalid');
          slot.note = draft.note.trim();
        }
        // Blank means KEEP: the form never receives the stored secret, so an
        // empty field cannot be read as "remove it". Clearing is explicit.
        if (typeof draft.password === 'string' && draft.password) {
          try { slot.password = encrypt(draft.password); }
          catch { throw new DeploymentError('The deploy credential could not be encrypted. Check the workbench encryption key.', 503, 'deploy_credential_invalid'); }
        } else if (Object.hasOwn(draft, 'password') && typeof draft.password !== 'string') {
          throw new DeploymentError('A deploy password must be text.', 400, 'deploy_credential_invalid');
        }
        if (!!slot.user !== !!slot.password) throw new DeploymentError(
          slot.user ? 'A deploy credential needs a password as well as an account name.' : 'A deploy credential needs an account name as well as a password.',
          400, 'deploy_credential_invalid');
      }
      return { ...current, deployCredentials: { ...credentials, [draft.target]: slot } };
    });
    return publicDeployCredentials(next);
  }

  // The identity itself, for the deploy path. Mirrors the per-user reader's
  // vocabulary — none / stored / unreadable — because the resolver in
  // app/deploy-credential.js treats those three states differently on purpose.
  async function deployCredential(target) {
    if (!DEPLOY_TARGETS.includes(target)) return { state: 'none', source: 'instance', user: '', password: '', note: '' };
    const saved = savedDeployCredentials(await load())[target];
    if (!saved.user && !saved.password) return { state: 'none', source: 'instance', user: '', password: '', note: '' };
    // A configured credential with no way to read it is a wiring fault, and must
    // not be reported as "none": that would deploy as whoever pressed the button.
    if (!readCredentialState) throw new DeploymentError('This build cannot read stored deploy credentials.', 503, 'deploy_credential_invalid');
    const read = readCredentialState({ deployPassword: saved.password }, decrypt);
    return { state: read.state, source: 'instance', user: saved.user, password: read.password, note: saved.note };
  }

  async function updateDeployment(draft) {
    const next = await mutate(async current => ({ ...current, deployment: await applyDraft(current, draft, { persist: true }) }));
    return publicDeploymentSettings(next);
  }

  async function connection(draft) {
    const current = await load();
    const value = draft === undefined ? savedDeploymentSettings(current) : await applyDraft(current, draft);
    if (draft === undefined && value.backend === 'local') return null;
    validateEndpoint(value.endpoint);
    return { endpoint: value.endpoint, token: decryptCredential(value.credential) };
  }

  // Slot-level EXTERNAL selection uses the globally administered endpoint and
  // encrypted credential even when the inherited global backend remains LOCAL.
  async function externalConnection() {
    const current = await load();
    const value = await applyDraft(current, {});
    return { endpoint: value.endpoint, token: decryptCredential(value.credential) };
  }

  return { load, updateGeneral, updateDeployment, updateDeployCredential, deployCredential, connection, externalConnection };
}
