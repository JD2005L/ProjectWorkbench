import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import {
  atomicFile, assertUnchanged, readSnapshot, requireLinuxRoot, withDirectoryLock,
} from './safe-files.mjs';

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const KEYS = new Set(['name', 'desc', 'url', 'healthUrl', 'tags']);

export function normalizePwBase(value = '/workbench') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
      || /[^A-Za-z0-9/._~-]/.test(value)) {
    throw new Error('PW base must be a same-origin absolute URL path, not an origin, query, or fragment');
  }
  const base = value === '/' ? '' : value.replace(/\/$/, '');
  if (base && base.slice(1).split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('PW base contains an empty or traversal component');
  }
  return base;
}

export function validateDashboardPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file
      || /[\0-\x1f\x7f]/.test(file) || path.extname(file) !== '.html'
      || file.split(path.sep).includes('.git')) {
    throw new Error('Dashboard must be a normalized absolute path to a static .html file');
  }
  return file;
}

function formatError() {
  throw new Error('Unexpected dashboard format: expected one top-level const services = [literal cards]; in an inline script');
}

class LiteralCards {
  constructor(source, index) { this.source = source; this.index = index; }

  space() {
    while (this.index < this.source.length) {
      if (/\s/.test(this.source[this.index])) { this.index++; continue; }
      if (this.source.startsWith('//', this.index)) {
        const end = this.source.indexOf('\n', this.index + 2);
        this.index = end < 0 ? this.source.length : end + 1;
      } else if (this.source.startsWith('/*', this.index)) {
        const end = this.source.indexOf('*/', this.index + 2);
        if (end < 0) formatError();
        this.index = end + 2;
      } else break;
    }
  }

  take(char) {
    this.space();
    if (this.source[this.index] !== char) formatError();
    this.index++;
  }

  string() {
    this.space();
    const quote = this.source[this.index++];
    if (!['"', "'"].includes(quote)) formatError();
    let value = '';
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (char === quote) return value;
      if (/[\0-\x1f]/.test(char)) formatError();
      if (char !== '\\') { value += char; continue; }
      const escaped = this.source[this.index++];
      const simple = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', "'": "'", '\\': '\\', '/': '/' };
      if (Object.hasOwn(simple, escaped)) value += simple[escaped];
      else if (escaped === 'u' || escaped === 'x') {
        const size = escaped === 'u' ? 4 : 2;
        const hex = this.source.slice(this.index, this.index + size);
        if (hex.length !== size || !/^[a-fA-F0-9]+$/.test(hex)) formatError();
        value += String.fromCharCode(parseInt(hex, 16));
        this.index += size;
      } else formatError();
    }
    formatError();
  }

  key() {
    this.space();
    if (['"', "'"].includes(this.source[this.index])) return this.string();
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.source.slice(this.index));
    if (!match) formatError();
    this.index += match[0].length;
    return match[0];
  }

  tags() {
    this.take('[');
    const tags = [];
    this.space();
    while (this.source[this.index] !== ']') {
      if (tags.length >= 32) formatError();
      tags.push(this.string());
      this.space();
      if (this.source[this.index] !== ',') break;
      this.index++;
      this.space();
    }
    this.take(']');
    return tags;
  }

  card() {
    this.take('{');
    const card = {};
    this.space();
    while (this.source[this.index] !== '}') {
      const key = this.key();
      if (!KEYS.has(key) || Object.hasOwn(card, key)) formatError();
      this.take(':');
      card[key] = key === 'tags' ? this.tags() : this.string();
      this.space();
      if (this.source[this.index] !== ',') break;
      this.index++;
      this.space();
    }
    this.take('}');
    if (['name', 'desc', 'url', 'tags'].some(key => !Object.hasOwn(card, key))) formatError();
    return card;
  }

  array() {
    this.take('[');
    const cards = [];
    let lastEnd = this.index, trailingComma = false;
    this.space();
    while (this.source[this.index] !== ']') {
      if (cards.length >= 500) formatError();
      cards.push(this.card());
      lastEnd = this.index;
      trailingComma = false;
      this.space();
      if (this.source[this.index] !== ',') break;
      trailingComma = true;
      this.index++;
      this.space();
    }
    this.space();
    const close = this.index;
    this.take(']');
    this.take(';');
    return { cards, close, lastEnd, trailingComma };
  }
}

function checkTopLevelPrefix(source, stop) {
  const stack = [];
  let index = 0;
  while (index < stop) {
    const char = source[index];
    if (source.startsWith('//', index) || source.startsWith('/*', index)
        || source.startsWith('<!--', index) || source.startsWith('-->', index)) {
      const block = source.startsWith('/*', index);
      const end = source.indexOf(block ? '*/' : '\n', index + 2);
      if (end < 0 || end >= stop) formatError();
      index = end + (block ? 2 : 1);
      continue;
    }
    if (['"', "'", '`'].includes(char)) {
      const quote = char;
      index++;
      while (index < stop && source[index] !== quote) {
        // Ambiguous template interpolation or regex before the marker is refused, never evaluated.
        if (quote === '`' && source.startsWith('${', index)) formatError();
        if (source[index] === '\\') index++;
        index++;
      }
      if (index >= stop) formatError();
      index++;
      continue;
    }
    if (char === '/') formatError();
    if ('([{'.includes(char)) stack.push(char);
    if (')]}'.includes(char) && stack.pop() !== { ')': '(', ']': '[', '}': '{' }[char]) formatError();
    index++;
  }
  if (stack.length) formatError();
}

function inlineScripts(page) {
  const scripts = [];
  let index = 0, templateDepth = 0;
  while ((index = page.indexOf('<', index)) >= 0) {
    if (page.startsWith('<!--', index)) {
      const end = page.indexOf('-->', index + 4);
      if (end < 0) formatError();
      index = end + 3;
      continue;
    }
    const tag = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)\b/.exec(page.slice(index));
    if (!tag && !page.startsWith('<!', index) && !page.startsWith('<?', index)) { index++; continue; }
    let end = index + (tag?.[0].length || 2), quote = '';
    for (; end < page.length; end++) {
      const char = page[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === page.length) formatError();
    const name = tag?.[2].toLowerCase(), closing = tag?.[1] === '/';
    if (name === 'plaintext') formatError();
    if (name === 'template') templateDepth += closing ? -1 : 1;
    if (templateDepth < 0) formatError();
    if (!closing && ['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'].includes(name)) {
      const close = new RegExp(`</${name}\\s*>`, 'gi');
      close.lastIndex = end + 1;
      const ending = close.exec(page);
      if (!ending) formatError();
      if (name === 'script' && templateDepth === 0) {
        scripts.push({ attributes: page.slice(index + tag[0].length, end), start: end + 1, end: ending.index });
      }
      index = ending.index + ending[0].length;
    } else index = end + 1;
  }
  if (templateDepth) formatError();
  return scripts;
}

function declaration(page) {
  const markers = [...page.matchAll(/\bconst\s+services\s*=\s*\[/g)];
  if (markers.length !== 1) formatError();
  const marker = markers[0];
  for (const { attributes, start, end } of inlineScripts(page)) {
    const source = page.slice(start, end);
    if (marker.index < start || marker.index >= end) continue;
    if (/\bsrc(?:\s|=|$)/i.test(attributes)) formatError();
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    if (type && !['text/javascript', 'application/javascript', 'module']
      .includes((type[1] ?? type[2] ?? type[3]).toLowerCase())) formatError();
    checkTopLevelPrefix(source, marker.index - start);
    try { new Script(source); }
    catch (error) { if (error instanceof SyntaxError) formatError(); throw error; }
    const open = marker.index + marker[0].length - 1;
    const parsed = new LiteralCards(page, open).array();
    if (parsed.close >= end) formatError();
    return { ...parsed, marker: marker.index, sourceStart: start, sourceEnd: end };
  }
  formatError();
}

export function patchDashboard(page, pwBase = '/workbench') {
  if (typeof page !== 'string' || Buffer.byteLength(page) > MAX_PAGE_BYTES) throw new Error('Dashboard exceeds the size limit');
  const base = normalizePwBase(pwBase);
  const card = {
    name: 'Deployment Service', desc: 'Shared deployment jobs, logs, and administration',
    url: `${base}/deploy-service`, healthUrl: `${base}/api/deploy-service/health`,
    tags: ['Deployments', 'Logs', 'Administration'],
  };
  const parsed = declaration(page);
  if (parsed.cards.some(existing => existing.url === card.url)) return { changed: false, page, card };
  if (parsed.cards.some(existing => existing.name === card.name)) {
    throw new Error('A Deployment Service card already has a different URL; review it manually');
  }
  const newline = page.includes('\r\n') ? '\r\n' : '\n';
  const markerLine = page.slice(page.lastIndexOf('\n', parsed.marker) + 1, parsed.marker);
  const indent = /^[ \t]*$/.test(markerLine) ? markerLine : '';
  let before = page.slice(0, parsed.close);
  if (parsed.cards.length && !parsed.trailingComma) {
    before = page.slice(0, parsed.lastEnd) + ',' + page.slice(parsed.lastEnd, parsed.close);
  }
  const addition = `${newline}${indent}  ${JSON.stringify(card)}${newline}${indent}`;
  const updated = before + addition + page.slice(parsed.close);
  // Compilation is syntax-only. No existing dashboard JavaScript is run.
  try { new Script(updated.slice(parsed.sourceStart, parsed.sourceEnd + updated.length - page.length)); }
  catch (error) { if (error instanceof SyntaxError) formatError(); throw error; }
  return { changed: true, page: updated, card };
}

export async function updateDashboard(file, {
  pwBase = '/workbench', check = false, rollback = false, policy = {},
} = {}) {
  validateDashboardPath(file);
  normalizePwBase(pwBase);
  const pagePolicy = { ...policy, owner: null, maxBytes: MAX_PAGE_BYTES };
  const snapshot = await readSnapshot(file, pagePolicy);
  if (snapshot.stat.mode & 0o7000) throw new Error('Static dashboard must not have special permission bits');
  const original = snapshot.bytes.toString('utf8');
  if (!Buffer.from(original).equals(snapshot.bytes)) throw new Error('Static dashboard must be UTF-8');
  const backupFile = `${file}.pw-deploy-service.bak`;
  const backupPolicy = { ...policy, privateFile: true, maxBytes: MAX_PAGE_BYTES };
  let result;
  if (rollback) {
    const backup = await readSnapshot(backupFile, backupPolicy);
    const expected = patchDashboard(backup.bytes.toString('utf8'), pwBase);
    if (!expected.changed || expected.page !== original) {
      throw new Error('Dashboard differs from the generated card update; refusing to overwrite later edits during rollback');
    }
    result = { changed: true, page: backup.bytes.toString('utf8') };
  } else result = patchDashboard(original, pwBase);
  if (!result.changed || check) return { changed: result.changed, backupFile, check, rollback };
  return withDirectoryLock(`${file}.pw-deploy-service.lock`, async () => {
    await assertUnchanged(file, snapshot, pagePolicy);
    if (!rollback) {
      const existingBackup = await readSnapshot(backupFile, { ...backupPolicy, optional: true });
      if (existingBackup && !existingBackup.bytes.equals(snapshot.bytes)) {
        throw new Error('Named rollback copy already contains a different page; preserve it and review before proceeding');
      }
      if (!existingBackup) {
        await atomicFile(backupFile, snapshot.bytes, {
          mode: 0o600, uid: policy.owner ?? 0, gid: process.getgid?.() ?? 0, policy: backupPolicy,
        });
      }
    }
    await atomicFile(file, result.page, {
      expected: snapshot, mode: snapshot.stat.mode & 0o777, policy: pagePolicy,
    });
    return { changed: true, backupFile, check, rollback };
  }, policy);
}

async function main() {
  const options = {}, seen = new Set();
  let file;
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (seen.has(flag)) throw new Error('Duplicate dashboard option');
    seen.add(flag);
    if (flag === '--dashboard' || flag === '--pw-base') {
      const value = process.argv[++index];
      if (!value || value.startsWith('--')) throw new Error('Dashboard option needs a value');
      if (flag === '--dashboard') file = value;
      else options.pwBase = value;
    } else if (flag === '--check') options.check = true;
    else if (flag === '--rollback') options.rollback = true;
    else if (flag === '--help') {
      process.stdout.write('Usage: node dashboard-card.mjs --dashboard /absolute/index.html [--pw-base /workbench] [--check | --rollback]\n');
      return;
    } else throw new Error('Unknown dashboard option');
  }
  if (!file) throw new Error('--dashboard is required; there is no implicit live-site target');
  if (!options.check) requireLinuxRoot();
  const result = await updateDashboard(file, options);
  process.stdout.write(result.check
    ? (result.changed ? 'Dashboard format accepted; a change is needed. No files written.\n' : 'Deployment Service link already present. No files written.\n')
    : result.changed
      ? `${result.rollback ? 'Restored' : 'Updated'} static dashboard. Named page-only rollback copy: ${result.backupFile}\n`
      : 'Deployment Service link already present; no files changed.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Dashboard update refused: ${error.message}\n`); process.exitCode = 1; });
}
