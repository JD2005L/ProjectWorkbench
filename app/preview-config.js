// Port allocation and the per-project preview block (`p.preview = { cmd, port, env? }`).
//
// One implementation, used by both places that can write a preview block: the admin edit
// route (/manage/update/:oldName) and the shared add handler behind /manage/add and the
// machine API (POST /api/projects). Before, only the edit route validated a preview, inline;
// a second copy for the add path would have been free to drift from it.

export function allUsedPorts(projects){ const out = new Set(); for(const p of projects){ const a = Number(p?.port); if(Number.isFinite(a)) out.add(a); const b = Number(p?.preview?.port); if(Number.isFinite(b) && b > 0) out.add(b); } return out; }
export function nextPort(projects){ const used = allUsedPorts(projects); let port = 7681; while(used.has(port)) port++; return port; }
export function nextPreviewPort(projects){ const used = allUsedPorts(projects); let port = 7790; while(used.has(port)) port++; return port; }
export function validPort(n){ return Number.isInteger(n) && n >= 1024 && n <= 65535; }

export function previewPortInUseMessage(port){ return 'Preview port '+port+' is already in use by another project'; }

// KEY=VALUE lines; blank lines and `#` comments skipped. PORT and BASEPATH are reserved
// because the preview runner sets them itself.
export function parsePreviewEnv(raw){
 const env = {};
 for(const line0 of String(raw ?? '').split(/\r?\n/)){
  const line = line0.replace(/^\s+|\s+$/g,'');
  if(!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if(i < 1) throw new Error(`Bad env line (need KEY=VALUE): ${line.slice(0,60)}`);
  const k = line.slice(0,i).replace(/\s+$/,'');
  const v = line.slice(i+1);
  if(k === 'PORT' || k === 'BASEPATH') throw new Error(`${k} is reserved and cannot be set via preview env`);
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid env var name: ${k}`);
  env[k] = v;
 }
 return env;
}

/**
 * Validate the three request fields and return the block to store, or null when no
 * command was given (no command = no preview).
 *
 *   cmd, port, env  the raw request fields (previewCmd, previewPort, previewEnv)
 *   terminalPort    this project's terminal port; the preview may not share it
 *   others          every OTHER project in the registry (collision set + auto-allocation)
 *   defaultPort     used when `port` is blank/non-numeric, before auto-allocation
 */
export function buildPreviewBlock({ cmd, port, env, terminalPort, others, defaultPort } = {}){
 const command = String(cmd || '').trim();
 if(!command) return null;
 const previewPort = Number(String(port || '').trim()) || Number(defaultPort) || nextPreviewPort(others);
 if(!validPort(previewPort)) throw new Error('Preview port must be between 1024 and 65535');
 if(previewPort === terminalPort) throw new Error('Preview port cannot match this project\'s terminal port');
 if(allUsedPorts(others).has(previewPort)) throw new Error(previewPortInUseMessage(previewPort));
 const parsedEnv = parsePreviewEnv(env || '');
 const block = { cmd: command, port: previewPort };
 if(Object.keys(parsedEnv).length) block.env = parsedEnv;
 return block;
}
