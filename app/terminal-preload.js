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
    ws.addEventListener('close', () => { if (activeSend === nativeSend) activeSend = null; });
    return ws;
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  Object.assign(window.WebSocket, NativeWebSocket);
})();
