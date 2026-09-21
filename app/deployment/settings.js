import fs from 'node:fs/promises';
import { writeFileAtomic } from '../atomic-file.js';
import { withLifecycleLock } from '../lifecycle-lock.js';
import { DeploymentError, fields, record, validateEndpoint } from './protocol.js';

export const DEFAULT_DEPLOYMENT_SETTINGS = Object.freeze({ backend: 'local', endpoint: '', credential: '' });

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

export function publicDeploymentSettings(settings) {
  const value = savedDeploymentSettings(settings);
  return { backend: value.backend, endpoint: value.endpoint, hasCredential: !!value.credential,
    ...(value.consoleUrl ? { consoleUrl: value.consoleUrl } : {}) };
}

export function publicWorkbenchSettings(settings) {
  return { ...settings, deployment: publicDeploymentSettings(settings) };
}

// Both the old settings forms and the new backend form share the same lock.
// A general settings save cannot overwrite a concurrently rotated service token.
export function createWorkbenchSettingsStore({
  filePath, defaults = {}, encrypt, decrypt,
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
    return { ...structuredClone(defaults), ...value, deployment: savedDeploymentSettings(value) };
  }

  async function mutate(change) {
    return withLock(`${filePath}.lock`, async () => {
      const current = await load();
      const next = await change(current);
      savedDeploymentSettings(next);
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
        if (key !== 'deployment' && Object.hasOwn(patch, key)) next[key] = patch[key];
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

  return { load, updateGeneral, updateDeployment, connection, externalConnection };
}
