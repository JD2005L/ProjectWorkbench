(() => {
  if (window.__projectWorkbenchPasteInstalled) return;
  window.__projectWorkbenchPasteInstalled = true;

  const project = decodeURIComponent((location.pathname.match(/^\/term\/([^/]+)/) || [])[1] || '');
  if (!project) return;

  function toast(message, bad = false) {
    let el = document.getElementById('pw-paste-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pw-paste-toast';
      el.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:999999;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:10px;padding:10px 12px;font:13px system-ui;max-width:52vw;box-shadow:0 8px 30px #0008;white-space:pre-wrap';
      document.body.appendChild(el);
    }
    el.style.borderColor = bad ? '#ef4444' : '#22c55e';
    el.textContent = message;
    clearTimeout(el.__timer);
    el.__timer = setTimeout(() => el.remove(), 6500);
  }

  function sendPathToTerminal(text) {
    if (window.__pwSendToTerminal?.(text)) return true;
    const ta = document.querySelector('textarea.xterm-helper-textarea') || document.querySelector('textarea');
    if (!ta) return false;
    ta.focus();
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    } catch {}
    return false;
  }

  async function uploadImage(blob, name = 'clipboard-image.png') {
    if (!blob || !blob.type || !blob.type.startsWith('image/')) {
      toast('That is not an image.', true);
      return false;
    }
    setTrayStatus('Saving image...');
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error('Could not read image'));
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.readAsDataURL(blob);
    });
    const res = await fetch('/api/upload/' + encodeURIComponent(project), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: name, mime: blob.type, data })
    });
    const out = await res.json().catch(() => null);
    if (!res.ok || !out?.ok) throw new Error(out?.error || 'Image upload failed');
    const inserted = sendPathToTerminal(out.path);
    try { await navigator.clipboard.writeText(out.path); } catch {}
    setTrayStatus('Saved and ' + (inserted ? 'inserted' : 'copied') + ':\n' + out.path, false, out.url);
    toast('Image saved into _inbox and path ' + (inserted ? 'inserted.' : 'copied.'));
    return true;
  }

  function setTrayStatus(text, bad = false, imageUrl = null) {
    const status = document.getElementById('pw-tray-status');
    const preview = document.getElementById('pw-tray-preview');
    if (status) { status.textContent = text; status.style.color = bad ? '#fca5a5' : '#bbf7d0'; }
    if (preview && imageUrl) preview.innerHTML = '<img src="'+imageUrl+'" style="max-width:100%;max-height:220px;border-radius:8px;margin-top:10px;border:1px solid #334155">';
  }

  function createTray() {
    if (document.getElementById('pw-image-tray-button')) return;
    const btn = document.createElement('button');
    btn.id = 'pw-image-tray-button';
    btn.textContent = 'Image';
    btn.title = 'Open image paste tray';
    btn.style.cssText = 'position:fixed;right:10px;top:8px;z-index:999998;background:#2563eb;color:white;border:0;border-radius:999px;padding:6px 11px;font:12px system-ui;cursor:pointer;box-shadow:0 4px 18px #0008';
    document.body.appendChild(btn);

    const tray = document.createElement('div');
    tray.id = 'pw-image-tray';
    tray.style.cssText = 'position:fixed;right:-390px;top:0;width:360px;max-width:92vw;height:100vh;z-index:999997;background:#0f172a;color:#e5e7eb;border-left:1px solid #334155;box-shadow:-12px 0 35px #0009;transition:right .18s ease;padding:16px;font:14px system-ui;box-sizing:border-box;display:flex;flex-direction:column;gap:12px';
    tray.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <b>Image to ${project}</b>
        <button id="pw-tray-close" style="background:#334155;color:white;border:0;border-radius:8px;padding:5px 9px;cursor:pointer">Close</button>
      </div>
      <div id="pw-tray-drop" tabindex="0" style="border:2px dashed #64748b;border-radius:14px;padding:24px 12px;text-align:center;background:#111827;outline:none;cursor:pointer">
        <div>Paste here with <b>Ctrl+V</b></div>
        <div style="color:#94a3b8;margin-top:6px">or drop/select an image</div>
        <input id="pw-tray-file" type="file" accept="image/*" style="display:none">
      </div>
      <div id="pw-tray-status" style="white-space:pre-wrap;color:#94a3b8">Saved images go to this project's _inbox and the path is inserted into the terminal.</div>
      <div id="pw-tray-preview"></div>
    `;
    document.body.appendChild(tray);

    const open = (msg) => { tray.style.right = '0'; setTimeout(()=>document.getElementById('pw-tray-drop')?.focus(), 50); if (msg) setTrayStatus(msg); };
    const close = () => { tray.style.right = '-390px'; document.querySelector('textarea.xterm-helper-textarea')?.focus(); };
    window.__pwOpenImageTray = open;
    btn.onclick = () => open();
    tray.querySelector('#pw-tray-close').onclick = close;
    const drop = tray.querySelector('#pw-tray-drop');
    const file = tray.querySelector('#pw-tray-file');
    drop.onclick = () => file.click();
    file.onchange = async () => { try { await uploadImage(file.files[0], file.files[0]?.name); } catch(e){ setTrayStatus(e.message || String(e), true); } };
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = '#60a5fa'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = '#64748b'; });
    drop.addEventListener('drop', async e => { e.preventDefault(); drop.style.borderColor = '#64748b'; try { await uploadImage(e.dataTransfer.files[0], e.dataTransfer.files[0]?.name); } catch(err){ setTrayStatus(err.message || String(err), true); } });
    tray.addEventListener('paste', async e => {
      const item = Array.from(e.clipboardData?.items || []).find(i => i.type?.startsWith('image/'));
      if (!item) { setTrayStatus('No image found in this paste. Click inside the tray and try again.', true); return; }
      e.preventDefault();
      try { await uploadImage(item.getAsFile(), 'clipboard-image.png'); } catch(err){ setTrayStatus(err.message || String(err), true); }
    }, true);
  }

  createTray();
  toast('Image tray ready. Click Image, or press Ctrl+V to open it if Claude intercepts paste.');
})();
