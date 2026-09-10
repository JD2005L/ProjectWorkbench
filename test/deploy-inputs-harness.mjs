import vm from 'node:vm';
import { serverTemplate } from './deploy-manifest-harness.mjs';

class Element {
 constructor(document) {
  this.ownerDocument = document; this.dataset = {}; this.style = {}; this.events = {};
  this.value = ''; this.textContent = ''; this.disabled = false; this.children = [];
  const classes = new Set();
  this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: name => classes.delete(name), contains: name => classes.has(name) };
 }
 addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
 async emit(type, event = {}) { for (const fn of this.events[type] || []) await fn({ target: this, ...event }); }
 async click() { if (this.disabled) return; if (this.onclick) await this.onclick(); await this.emit('click'); }
 focus() { this.ownerDocument.activeElement = this; }
 reportValidity() { this.reported = true; return !!this.value; }
 getClientRects() { return [{}]; }
 appendChild(child) { this.children.push(child); }
 replaceChildren() { this.children = []; }
 remove() { this.removed = true; }
 querySelector() { return null; }
 querySelectorAll() { return []; }
 closest() { return null; }
}

function fakeCard(document, manifest, legacyOption) {
 const card = new Element(document);
 card.dataset = { project: 'demo', target: manifest?.target || 'dev', label: manifest?.label || 'Development' };
 if (manifest) Object.assign(card.dataset, { managed: '1', manifest: JSON.stringify(manifest) });
 card.selects = (manifest?.inputs || []).map(input => {
  const select = new Element(document), label = new Element(document), caption = new Element(document);
  select.name = input.name; select.required = true;
  select.closest = selector => selector === 'label' ? label : card;
  label.querySelector = selector => selector === '.deploy-input-label' ? caption : null;
  return select;
 });
 card.button = new Element(document); card.button.disabled = !!manifest;
 card.button.closest = () => card;
 card.output = new Element(document);
 card.current = new Element(document); card.current.textContent = 'Choose an identity';
 card.target = new Element(document); card.notice = new Element(document);
 card.script = new Element(document); card.script.value = manifest?.script || 'legacy';
 card.last = new Element(document);
 card.option = new Element(document); card.option.value = legacyOption || '';
 const line = new Element(document), source = new Element(document);
 source.textContent = 'V1.26.0909.1200';
 const parent = new Element(document);
 parent.querySelector = selector => selector === '.version.source' ? source : null;
 card.closest = selector => selector === '.project-card' ? parent : null;
 card.querySelectorAll = selector => selector === '.deploy-input' ? card.selects : [];
 const elements = {
  '.deploy-btn': card.button, '.deploy-output': card.output, '.current-version': card.current,
  '.target-version': card.target, '.manifest-notice': card.notice, '.deploy-script': card.script,
  '.last-deploy-info': card.last, '.version-line': line,
 };
 card.querySelector = selector => elements[selector] || (selector === '.deploy-option' && !manifest ? card.option : null);
 return card;
}

const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const decodeAttribute = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export async function loadDeployBrowser(surface, initialManifest, options = {}) {
 const requests = [], prompts = [], confirms = [];
 const document = new Element(null);
 document.ownerDocument = document;
 document.createElement = () => new Element(document);
 document.activeElement = new Element(document);
 const opener = document.activeElement;
 let card = fakeCard(document, initialManifest, options.legacyOption);
 const title = new Element(document), body = new Element(document), backdrop = new Element(document), close = new Element(document);
 backdrop.classList.add('hidden');
 const cards = () => card ? [card] : [];
 function queryAll(selector) {
  if (selector === '.target-card[data-managed="1"]') return cards().filter(item => item.dataset.managed === '1');
  if (selector === '.deploy-btn') return cards().map(item => item.button);
  if (selector === '.deploy-input') return cards().flatMap(item => item.selects);
  return [];
 }
 document.querySelectorAll = body.querySelectorAll = queryAll;
 body.querySelector = selector => selector === '.deploy-input' ? card?.selects[0] || null : null;
 backdrop.querySelectorAll = () => [close, ...cards().flatMap(item => [...item.selects, item.button, item.script])];
 document.getElementById = id => ({ deployBackdrop: backdrop, deployModalBody: body, deployModalTitle: title, deployCloseBtn: close }[id] || null);
 Object.defineProperty(body, 'innerHTML', {
  set(html) {
   const manifests = [...html.matchAll(/data-manifest="([^"]+)"/g)].map(match => JSON.parse(decodeAttribute(match[1])));
   const manifest = manifests.find(slot => slot.target === (initialManifest?.target || 'dev'));
   card = manifest ? fakeCard(document, manifest, options.legacyOption)
    : html.includes('<legacy-card>') ? fakeCard(document, null, options.legacyOption) : null;
  },
 });
 const window = {};
 const responses = [...(options.responses || [{ ok: true, version: '2.3.5', duration: '1.0', user: 'operator', output: 'published' }])];
 const sandbox = {
  document, window, console,
  setTimeout: () => 0,
  confirm: message => { confirms.push(message); return options.confirm !== false; },
  prompt: message => { prompts.push(message); return options.password ?? 'good-password'; },
  alert: message => { throw new Error(message); },
  fetch: async (url, init = {}) => {
   const request = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined, cache: init.cache };
   requests.push(request);
   if (options.respond) return { json: async () => options.respond(request) };
   if (request.method === 'GET') {
    const manifest = options.loadManifest ? await options.loadManifest() : initialManifest;
    return { json: async () => ({ ok: true, html: manifest ? `<div data-manifest="${escapeAttribute(JSON.stringify(manifest))}"></div>` : '<legacy-card>' }) };
   }
   const response = responses.shift();
   if (!response) throw new Error('Unexpected extra deployment request');
   return { json: async () => response };
  },
 };
 vm.createContext(sandbox);
 const script = serverTemplate(surface).replace(/^\s*<script>|<\/script>\s*$/g, '');
 vm.runInContext(script, sandbox, { filename: `${surface}-rendered.js` });
 if (surface === 'deployModalScript') await window.pwDeploy.open('demo');
 return {
  requests, prompts, confirms, document, body, backdrop, close, window, opener,
  get card() { return card; },
  async choose(name, value) {
   const select = card.selects.find(item => item.name === name);
   if (!select) throw new Error(`No select ${name}`);
   select.value = value; await select.emit('change');
  },
  click: () => card.button.click(),
 };
}
