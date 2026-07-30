// Crash-safe whole-file writes for users.json / projects.json /
// sessions.json. A plain fs.writeFile() opens the target with O_TRUNC —
// truncating it in place — before the new bytes ever land, so a crash (or a
// SIGKILL, indistinguishable at the filesystem level) between the truncate
// and the write completing can leave a corrupt or empty file behind. Worse,
// a bare rename() without an fsync of the containing directory is not
// guaranteed durable either: the directory-entry update itself can be lost
// on a crash even after the rename() call returned.
//
// writeFileAtomic() instead: writes the FULL new content to a fresh temp file
// in the SAME directory (so the later rename is on one filesystem and atomic),
// fsyncs that file, renames it over the target (POSIX rename is atomic — a
// reader always sees either the complete old file or the complete new one,
// never a partial write), then fsyncs the directory so the rename itself
// survives a crash. The target's mode is set explicitly rather than relying
// on umask at file-creation time.
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export async function writeFileAtomic(filePath, data, { mode = 0o644 } = {}) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);

  const fh = await fsp.open(tmpPath, 'w', mode);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw e;
  }
  await fh.close();
  // Mode passed to open() is subject to umask; set it explicitly so the
  // caller's requested mode (0600 for secret-bearing files) is exact.
  await fsp.chmod(tmpPath, mode);

  try {
    await fsp.rename(tmpPath, filePath);
  } catch (e) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw e;
  }

  const dirFh = await fsp.open(dir, 'r');
  try { await dirFh.sync(); } finally { await dirFh.close(); }
}
