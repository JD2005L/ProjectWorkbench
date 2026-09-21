// Loads app/terminal-preload.js (a browser IIFE, no module system) into a vm
// sandbox that stubs just enough DOM for its top-level code to run, then drives
// the patched window.WebSocket message path — the exact code path real ttyd
// frames take through the OSC 52 clipboard sniffer.
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../app/terminal-preload.js', import.meta.url), 'utf8');

/**
 * `fetchImpl` and `intervals` are optional: the read-only guard polls for the viewer's
 * identity and the active tab's owner, and a test that wants to exercise it has to
 * supply both. Left out, the guard finds no fetch and stays inert — which is also what
 * every other preload test wants.
 */
export function loadPreload({ pathname = '/pty/demo/', fetchImpl = null, intervals = null } = {}) {
  const copies = [];
  class FakeWebSocket {
    constructor(...args) { this.args = args; this._listeners = Object.create(null); this.sent = []; }
    send(data) { this.sent.push(data); }
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
    emit(type, ev) { for (const fn of this._listeners[type] || []) fn(ev); }
  }
  const el = () => ({
    style: {}, setAttribute() {}, remove() {}, select() {}, setSelectionRange() {},
    focus() {}, appendChild() {}, textContent: '', value: '',
  });
  const documentStub = {
    createElement: el,
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    body: { appendChild(node) { bars.push(node); } },
    hidden: false,
    addEventListener() {},
    execCommand() { return false; },
    activeElement: null,
  };
  const windowStub = { WebSocket: FakeWebSocket, parent: { postMessage() {} }, addEventListener() {} };
  // The lock bar is appended to document.body; record what it says so a test can assert
  // the page TELLS the reader why their typing went nowhere.
  const bars = [];
  const thenable = { then(onOk) { try { onOk && onOk(); } catch {} return thenable; }, catch() { return thenable; } };
  const sandbox = {
    window: windowStub,
    document: documentStub,
    location: { pathname, search: '' },
    navigator: { clipboard: { writeText(t) { copies.push(t); return thenable; } } },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextDecoder,
    Blob: class BlobStub {},
    setTimeout: (fn) => { if (typeof fn === 'function') { /* deliberately not run: the
      flash is cosmetic and running it synchronously would undo what a test just asserted */ } return 0; },
    clearTimeout() {},
    console,
  };
  if (fetchImpl) sandbox.fetch = fetchImpl;
  if (intervals) sandbox.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'terminal-preload.js' });
  // Open a "ttyd" socket through the patched constructor so the preload's
  // message sniffer attaches, then expose a frame feeder to the test.
  const ws = new windowStub.WebSocket('ws://127.0.0.1/pty/demo/ws');
  return {
    copies,
    bars,
    ws,
    window: windowStub,
    // One server->client ttyd frame: first byte '0' = terminal OUTPUT.
    frame(payload) { ws.emit('message', { data: '0' + payload }); },
  };
}

export const b64 = (s) => Buffer.from(s, 'binary').toString('base64');
export const osc52 = (text, term = '\x07') => '\x1b]52;c;' + b64(text) + term;
