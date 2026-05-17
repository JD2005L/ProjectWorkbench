(() => {
  if (window.__projectWorkbenchPreloadInstalled) return;
  window.__projectWorkbenchPreloadInstalled = true;

  const project = decodeURIComponent((location.pathname.match(/^\/pty\/([^/]+)/) || [])[1] || '');
  if (!project) return;

  let activeSend = null;
  window.__pwSendToTerminal = function(text) {
    if (activeSend) {
      activeSend(String(text));
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

  document.addEventListener('paste', async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imgItem = items.find(i => i.type?.startsWith('image/'));
    if (!imgItem) return; // Non-image paste: let ttyd handle it normally.
    e.preventDefault();
    e.stopPropagation();
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
  }, true);

  // tmux mouse-on makes tmux own drag-selection, so xterm.js never sees a
  // selection and ttyd's built-in onSelectionChange auto-copy never fires.
  // tmux emits OSC 52 on copy-pipe-and-cancel (set-clipboard on), but the
  // xterm.js bundled with ttyd 1.7.x has no OSC 52 handler. Sniff it from
  // the inbound ttyd stream and write the decoded text to the OS clipboard.
  const oscDecoder = new TextDecoder();
  const oscRe = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g;
  function handleClipboardOSC(text) {
    if (!text || text.indexOf('\x1b]52;') === -1) return;
    oscRe.lastIndex = 0;
    let m;
    while ((m = oscRe.exec(text)) !== null) {
      try {
        const data = atob(m[1]);
        if (data) navigator.clipboard.writeText(data).catch(() => {});
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
