(() => {
  if (window.__projectWorkbenchPreloadInstalled) return;
  window.__projectWorkbenchPreloadInstalled = true;

  const project = decodeURIComponent((location.pathname.match(/^\/pty\/([^/]+)/) || [])[1] || '');
  if (!project) return;

  // Suppress ttyd's "Leave site?" beforeunload prompt. This terminal is a
  // persistent tmux session — navigating back, refreshing, or closing the tab
  // never loses work (the session just reattaches), so the confirmation is pure
  // friction. ttyd's disableLeaveAlert option isn't reliable here, so block both
  // registration styles at the source instead.
  try {
    const _add = window.addEventListener.bind(window);
    window.addEventListener = function (type, ...rest) {
      if (String(type).toLowerCase() === 'beforeunload') return;
      return _add(type, ...rest);
    };
  } catch {}
  try {
    Object.defineProperty(window, 'onbeforeunload', { configurable: true, get: () => null, set: () => {} });
  } catch {}

  let activeSend = null;
  window.__pwSendToTerminal = function(text) {
    if (activeSend) {
      // ttyd's WS protocol expects the first byte to be a command code:
      // '0' = INPUT (write the rest to the PTY).
      //
      // Wrap the payload in bracketed-paste markers (ESC[200~ ... ESC[201~)
      // so Claude (and any other bracketed-paste-aware program) treats it as
      // a paste — not as keystrokes. Without these markers Claude sees the
      // path as typed input and skips its image-detection, so the prompt
      // shows the raw path instead of "[Image #N]".
      activeSend('0\x1b[200~' + String(text) + '\x1b[201~');
      return true;
    }
    return false;
  };

  function extFor(mime) {
    if (!mime) return '.bin';
    if (mime.includes('png')) return '.png';
    if (mime.includes('jpeg')) return '.jpg';
    if (mime.includes('webp')) return '.webp';
    if (mime.includes('gif')) return '.gif';
    return '.bin';
  }

  async function uploadImageBlob(blob, filename) {
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error('Could not read image'));
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.readAsDataURL(blob);
    });
    const res = await fetch('/api/upload/' + encodeURIComponent(project), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, mime: blob.type || 'application/octet-stream', data })
    });
    const out = await res.json().catch(() => null);
    if (!res.ok || !out?.ok) throw new Error(out?.error || 'Upload failed');
    return out;
  }

  // Ctrl+V handling.
  //
  // Image: upload to _inbox, drop the resulting path into the terminal,
  //   surface the preview via the parent drawer (existing flow).
  // Text:  route through __pwSendToTerminal (which wraps in bracketed-paste
  //   markers and sends via the ttyd WS). This sidesteps the async clipboard
  //   permission gauntlet that breaks xterm.js's native Ctrl+V on plain-HTTP
  //   instances. Same final effect as right-click "Paste as plain text".
  // Anything else: fall through to xterm.js's default handling.
  //
  // stopImmediatePropagation (not just stopPropagation) so xterm.js's own
  // paste path doesn't *also* try to handle it and end up sending the raw
  // image bytes / fighting us for the WS write.
  //
  // Wrapped in try/catch — if anything throws we fall through silently so a
  // future browser quirk can't permanently break paste.
  document.addEventListener('paste', async (e) => {
    try {
      const cd = e.clipboardData;
      if (!cd) return;
      const items = Array.from(cd.items || []);
      const imgItem = items.find(i => i.type?.startsWith('image/'));
      if (imgItem) {
        e.preventDefault();
        e.stopImmediatePropagation();
        try {
          const blob = imgItem.getAsFile();
          const filename = 'clipboard-image' + extFor(blob?.type);
          const out = await uploadImageBlob(blob, filename);
          window.__pwSendToTerminal?.(out.path);
          try { await navigator.clipboard.writeText(out.path); } catch {}
          window.parent?.postMessage({ type: 'pw-paste-saved', path: out.path, url: out.url }, '*');
        } catch (err) {
          window.parent?.postMessage({ type: 'pw-paste-error', error: err?.message || String(err) }, '*');
        }
        return;
      }
      const text = cd.getData('text/plain') || cd.getData('text') || '';
      if (text) {
        e.preventDefault();
        e.stopImmediatePropagation();
        // Normalize line endings: terminals expect \r for Enter inside a paste.
        const normalized = text.replace(/\r?\n/g, '\r');
        window.__pwSendToTerminal?.(normalized);
      }
    } catch {}
  }, true);

  // tmux mouse-on makes tmux own drag-selection, so xterm.js never sees a
  // selection and ttyd's built-in onSelectionChange auto-copy never fires.
  // tmux emits OSC 52 on copy-pipe-and-cancel (set-clipboard on), but the
  // xterm.js bundled with ttyd 1.7.x has no OSC 52 handler. Sniff it from
  // the inbound ttyd stream and write the decoded text to the OS clipboard.
  function copyExecFallback(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;padding:0;margin:0';
      document.body.appendChild(ta);
      const prev = document.activeElement;
      ta.select(); ta.setSelectionRange(0, ta.value.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      try { prev && prev.focus && prev.focus(); } catch {}
      return ok;
    } catch { return false; }
  }
  let toastEl = null, toastTimer = null;
  function flashToast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;background:#0f172a;color:#bbf7d0;border:1px solid #166534;border-radius:8px;padding:6px 10px;font:12px system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 6px 22px rgba(0,0,0,.55);opacity:0;transition:opacity .12s ease;pointer-events:none;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 900);
  }
  function writeClipboard(text) {
    if (!text) return;
    const preview = (text.length > 48 ? text.slice(0, 48) + '…' : text).replace(/\s+/g, ' ');
    const after = (ok) => { if (ok) flashToast('Copied: ' + preview); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => after(true), () => after(copyExecFallback(text)));
    } else {
      after(copyExecFallback(text));
    }
  }
  const oscDecoder = new TextDecoder();
  const oscRe = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g;
  function handleClipboardOSC(text) {
    if (!text || text.indexOf('\x1b]52;') === -1) return;
    oscRe.lastIndex = 0;
    let m;
    while ((m = oscRe.exec(text)) !== null) {
      try {
        const data = atob(m[1]);
        if (data) writeClipboard(data);
      } catch {}
    }
  }
  function sniffFrame(d) {
    try {
      if (typeof d === 'string') {
        if (d.charCodeAt(0) === 0x30) handleClipboardOSC(d.slice(1));
      } else if (d instanceof ArrayBuffer) {
        const v = new Uint8Array(d);
        if (v.length && v[0] === 0x30) handleClipboardOSC(oscDecoder.decode(v.subarray(1)));
      } else if (typeof Blob !== 'undefined' && d instanceof Blob) {
        d.arrayBuffer().then(buf => {
          const v = new Uint8Array(buf);
          if (v.length && v[0] === 0x30) handleClipboardOSC(oscDecoder.decode(v.subarray(1)));
        }).catch(() => {});
      }
    } catch {}
  }

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function(...args) {
    const ws = new NativeWebSocket(...args);
    const nativeSend = ws.send.bind(ws);
    activeSend = nativeSend;
    ws.send = function(data) {
      // Strip stray SYN bytes (^V). The paste handler above already uploaded the image;
      // we don't want Claude's image-detection path to fire on the raw ^V byte.
      try {
        if (typeof data === 'string' && data.includes('\x16')) {
          const remaining = data.replaceAll('\x16', '');
          return remaining ? nativeSend(remaining) : undefined;
        }
        if (data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(data);
          if (bytes.includes(0x16)) {
            const filtered = bytes.filter(b => b !== 0x16);
            return filtered.length ? nativeSend(filtered.buffer) : undefined;
          }
        }
      } catch {}
      return nativeSend(data);
    };
    ws.addEventListener('message', (ev) => sniffFrame(ev.data));
    ws.addEventListener('close', () => { if (activeSend === nativeSend) activeSend = null; });
    return ws;
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  Object.assign(window.WebSocket, NativeWebSocket);
})();
