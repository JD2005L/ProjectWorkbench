import path from 'node:path';

export function pasteFileOwnership({ deployMode, owner, currentUid }) {
  if (deployMode !== 'host' || !owner) return null;
  const uid = Number(owner.uid);
  const gid = Number(owner.gid);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error('agent paste: terminal owner uid/gid required');
  if (Number(currentUid) === uid) return null;
  return { uid, gid };
}

export async function prepareAgentPasteFile({ fsp, tmpRoot, text, ownership = null }) {
  if (!fsp || !tmpRoot) throw new Error('agent paste: filesystem and temp root required');
  const dir = await fsp.mkdtemp(path.join(tmpRoot, 'pw-agent-paste-'));
  const file = path.join(dir, 'prompt');
  let ready = false;
  try {
    await fsp.chmod(dir, 0o700);
    await fsp.writeFile(file, text, { mode: 0o600 });
    await fsp.chmod(file, 0o600);
    if (ownership) {
      // The terminal owner must read the file before tmux can load it. Hand the
      // file over first and the private directory second; until the directory is
      // handed over, the unprivileged account cannot race or alter the content.
      await fsp.chown(file, ownership.uid, ownership.gid);
      await fsp.chown(dir, ownership.uid, ownership.gid);
    }
    ready = true;
    return {
      dir,
      file,
      cleanup: () => fsp.rm(dir, { recursive: true, force: true }),
    };
  } finally {
    if (!ready) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
