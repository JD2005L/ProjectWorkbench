(() => {
  if (window.__projectWorkbenchPreloadInstalled) return;
  window.__projectWorkbenchPreloadInstalled = true;

  const project = decodeURIComponent((location.pathname.match(/^\/term\/([^/]+)/) || [])[1] || '');
  if (!project) return;

  let activeSend = null;
  window.__pwSendToTerminal = function(text) {
    if (activeSend) {
      activeSend(String(text));
      return true;
    }
    return false;
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function(...args) {
    const ws = new NativeWebSocket(...args);
    const nativeSend = ws.send.bind(ws);
    activeSend = nativeSend;
    ws.send = function(data) {
      try {
        // If Ctrl+V reaches the PTY as ASCII SYN, block it so Claude does not run its own broken image check.
        if (typeof data === 'string' && data.includes('\x16')) {
          const remaining = data.replaceAll('\x16', '');
          if (remaining) nativeSend(remaining);
          window.__pwOpenImageTray?.('Ctrl+V detected — paste the image into this tray.');
          return;
        }
        if (data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(data);
          if (bytes.includes(0x16)) {
            const filtered = bytes.filter(b => b !== 0x16);
            if (filtered.length) nativeSend(filtered.buffer);
            window.__pwOpenImageTray?.('Ctrl+V detected — paste the image into this tray.');
            return;
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
