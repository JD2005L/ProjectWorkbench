// Loads app/terminal-preload.js (a browser IIFE, no module system) into a vm
// sandbox that stubs just enough DOM for its top-level code to run, then drives
// the patched window.WebSocket message path — the exact code path real ttyd
// frames take through the OSC 52 clipboard sniffer.
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../app/terminal-preload.js', import.meta.url), 'utf8');

export function loadPreload({ pathname = '/pty/demo/' } = {}) {
  const copies = [];
  class FakeWebSocket {
    constructor(...args) { this.args = args; this._listeners = Object.create(null); }
    send() {}
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
    body: { appendChild() {} },
    addEventListener() {},
    execCommand() { return false; },
    activeElement: null,
  };
  const windowStub = { WebSocket: FakeWebSocket, parent: { postMessage() {} }, addEventListener() {} };
  const thenable = { then(onOk) { try { onOk && onOk(); } catch {} return thenable; }, catch() { return thenable; } };
  const sandbox = {
    window: windowStub,
    document: documentStub,
    location: { pathname, search: '' },
    navigator: { clipboard: { writeText(t) { copies.push(t); return thenable; } } },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextDecoder,
    Blob: class BlobStub {},
    setTimeout: () => 0,
    clearTimeout() {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'terminal-preload.js' });
  // Open a "ttyd" socket through the patched constructor so the preload's
  // message sniffer attaches, then expose a frame feeder to the test.
  const ws = new windowStub.WebSocket('ws://127.0.0.1/pty/demo/ws');
  return {
    copies,
    window: windowStub,
    // One server->client ttyd frame: first byte '0' = terminal OUTPUT.
    frame(payload) { ws.emit('message', { data: '0' + payload }); },
  };
}

export const b64 = (s) => Buffer.from(s, 'binary').toString('base64');
export const osc52 = (text, term = '\x07') => '\x1b]52;c;' + b64(text) + term;
