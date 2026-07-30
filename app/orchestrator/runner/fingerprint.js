// Identity and capability fingerprinting of the coding CLI binary.
//
// This exists to support one specific claim: that ProjectWorkbench *enforced* a setting at launch,
// as distinct from having *observed* it at runtime. That claim is only worth anything if PW can say
// exactly which executable it launched and that the executable declares support for the option and
// value it passed. So this module answers, for a configured path:
//
//   * which file is it really (realpath, device, inode, size, mtime, SHA-256 of the content);
//   * what version does it report;
//   * does its own `--help` declare the option, and does it list the value being passed;
//   * and is it the CLI itself rather than something that will rewrite argv on the way through.
//
// That last check is not hypothetical. ProjectWorkbench's own installer puts a *wrapper* on `PATH`
// at /usr/local/bin/claude which sources /etc/project-workbench/claude-wrapper.env and appends
// `--permission-mode`, `--mcp-config` and `--strict-mcp-config` before exec'ing the real binary. A
// launch through that wrapper is not a launch PW controls, so it can never be `launch_enforced`.
//
// Hashing the real binary costs about a second (it is ~275 MB), so the result is cached — keyed on
// the binary's own identity, so any change to the file invalidates it. Nothing else invalidates it,
// and nothing is trusted across an identity change.

import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Any shebang at all marks a script, and a script can always rewrite argv before the real program
 * sees it.
 *
 * An earlier version listed shells, which was the wrong shape of check: the vendor ships
 * `cli-wrapper.cjs` with `#!/usr/bin/env node` and calls it a fallback launcher, so a node shim at
 * the configured path passed the list and was attested as enforced. Enumerating interpreters is a
 * losing game — node, bun, deno, busybox ash, and whatever comes next. The real CLI is a compiled
 * ELF, so refusing every script costs nothing and closes the class.
 *
 * A compiled binary that execs something else with extra argv remains undetectable from here; that
 * is why the pinned content hash exists alongside this.
 */
const SHEBANG = /^#!/;

/**
 * The executable formats a kernel will load directly.
 *
 * Refusing the shebang is not sufficient, and the gap is not theoretical. `execvp` falls back to
 * running a file through `/bin/sh` when the kernel refuses it with `ENOEXEC`, so a text file with
 * **no** shebang is still interpreted, still sees the full argv, and can still rewrite it:
 *
 *     printf '\x7fELF not a real elf\necho "REWROTE-ARGV $*"\n' > fake.exe
 *     execFile('fake.exe', ['--version'])   ->   stdout: "REWROTE-ARGV --version"
 *
 * Note that the impostor above carries the ELF *magic* — which is why a magic check is not enough
 * either. The question is whether the kernel would load it, so on Linux the header is parsed far
 * enough to answer that: a bad `EI_CLASS`, `EI_DATA`, `EI_VERSION` or `e_type` is exactly what makes
 * `execve` return ENOEXEC and hand the file to a shell. Other platforms' formats are recognised by
 * magic only, which is a weaker statement and said so here rather than implied.
 */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const OTHER_EXECUTABLE_MAGICS = Object.freeze([
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),               // Mach-O 64, little-endian
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]),               // Mach-O 32, little-endian
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),               // Mach-O 64, big-endian
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]),               // Mach-O 32, big-endian
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),               // Mach-O universal
  Buffer.from([0x4d, 0x5a]),                           // PE/COFF ("MZ")
]);

/** ET_EXEC and ET_DYN — a position-independent executable is the latter. */
const LOADABLE_ELF_TYPES = new Set([2, 3]);

function isLoadableElf(head) {
  if (head.length < 18 || !head.subarray(0, 4).equals(ELF_MAGIC)) return false;
  const eiClass = head[4];   // 1 = 32-bit, 2 = 64-bit
  const eiData = head[5];    // 1 = little-endian, 2 = big-endian
  const eiVersion = head[6]; // always 1
  if (eiClass !== 1 && eiClass !== 2) return false;
  if (eiData !== 1 && eiData !== 2) return false;
  if (eiVersion !== 1) return false;
  const eType = eiData === 1 ? head.readUInt16LE(16) : head.readUInt16BE(16);
  return LOADABLE_ELF_TYPES.has(eType);
}

function isLoadableExecutable(head) {
  if (head.subarray(0, 4).equals(ELF_MAGIC)) return isLoadableElf(head);
  return OTHER_EXECUTABLE_MAGICS.some((magic) => head.subarray(0, magic.length).equals(magic));
}

/** How a fingerprint failed. Each maps to a distinct, actionable operator message. */
export const FingerprintFailure = Object.freeze({
  NOT_ABSOLUTE: 'not_absolute',
  UNRESOLVABLE: 'unresolvable',
  WRAPPER: 'wrapper',
  NOT_A_BINARY: 'not_a_binary',
  UNREADABLE: 'unreadable',
  VERSION_UNAVAILABLE: 'version_unavailable',
  HELP_UNAVAILABLE: 'help_unavailable',
  // The binary was never asked. In host mode the probe launches through a privilege drop, and a
  // drop that cannot be made is an operator's configuration fault — reporting it as "the CLI did
  // not report a version" sends them to look at the wrong thing entirely.
  PRIVILEGE_DROP_FAILED: 'privilege_drop_failed',
  PINNED_MISMATCH: 'pinned_mismatch',
});

/**
 * Parse an option's declared values out of a commander-style `--help`.
 *
 * The real output is:
 *
 *   --effort <level>                      Effort level for the current session
 *                                         (low, medium, high, xhigh, max)
 *
 * so the declared values are on a continuation line. Anything not matching this shape yields
 * `values: null`, which means "declared, but the values could not be read" — never an empty list
 * that a caller might mistake for "no values are valid".
 */
export function parseOptionCapability(helpText, option) {
  const lines = String(helpText ?? '').split('\n');
  // The option must END here: `\b` sits between `t` and `-`, so `--effort` matched `--effort-cap`
  // and borrowed its value list — which would let a value the binary never accepts be "enforced".
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = new RegExp(`^\\s*${escaped}(?=[\\s=<[,]|$)`);
  const index = lines.findIndex((line) => boundary.test(line));
  if (index === -1) return { declared: false, values: null };

  // The option's own line plus continuation lines (more indented, not starting a new option).
  const block = [lines[index]];
  for (let i = index + 1; i < lines.length; i++) {
    if (/^\s*-/.test(lines[i]) || lines[i].trim() === '') break;
    block.push(lines[i]);
  }
  const joined = block.join(' ');
  // `(low, medium, high, xhigh, max)` or `(choices: "a", "b")`.
  const parenthesised = /\(([^)]*)\)\s*$/.exec(joined) || /\(choices:\s*([^)]*)\)/.exec(joined);
  if (!parenthesised) return { declared: true, values: null };

  const values = parenthesised[1]
    .replace(/^choices:\s*/, '')
    .split(',')
    .map((value) => value.trim().replace(/^["']|["']$/g, ''))
    .filter((value) => /^[A-Za-z0-9._-]+$/.test(value));
  return { declared: true, values: values.length ? values : null };
}

/**
 * Fingerprint the configured coding CLI.
 *
 * Returns `{ ok: false, failure, detail }` rather than throwing: a fingerprint that cannot be taken
 * is a capability statement, and callers downgrade provenance rather than erroring out.
 */
export async function probeBinaryFingerprint({
  executable, options = [], expectedSha256 = null, exec = execFileAsync, timeoutMs = 30_000,
}) {
  // A bare name would be resolved through PATH, which an operator's environment controls. Enforcing
  // a setting means knowing exactly which file ran.
  if (!executable || !path.isAbsolute(executable)) {
    return {
      ok: false,
      failure: FingerprintFailure.NOT_ABSOLUTE,
      detail: 'the coding CLI must be configured as an absolute path before a launch can be enforced',
    };
  }

  let realpath;
  let stat;
  try {
    realpath = await fsp.realpath(executable);
    stat = await fsp.stat(realpath);
  } catch {
    return { ok: false, failure: FingerprintFailure.UNRESOLVABLE, detail: 'the configured coding CLI does not resolve to a file' };
  }

  // Is it the program, or something that will rewrite argv before the program sees it?
  let head = Buffer.alloc(0);
  try {
    const handle = await fsp.open(realpath, 'r');
    try {
      const buffer = Buffer.alloc(256);
      const { bytesRead } = await handle.read(buffer, 0, 256, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return { ok: false, failure: FingerprintFailure.UNREADABLE, detail: 'the coding CLI could not be read' };
  }
  if (SHEBANG.test(head.toString('latin1'))) {
    return {
      ok: false,
      failure: FingerprintFailure.WRAPPER,
      detail: 'the configured coding CLI is an interpreted script, which can rewrite argv, so a launch through it cannot be enforced',
    };
  }
  if (!isLoadableExecutable(head)) {
    // No shebang is not the same as "a binary". A file the kernel refuses is handed to /bin/sh by
    // execvp's ENOEXEC fallback, which puts an interpreter between us and the program with the
    // whole argv in its hands — exactly what the check above exists to prevent.
    return {
      ok: false,
      failure: FingerprintFailure.NOT_A_BINARY,
      detail: 'the configured coding CLI is not a loadable executable, so a shell would run it and could rewrite argv',
    };
  }

  const sha256 = await hashFile(realpath);
  if (expectedSha256 && sha256 !== expectedSha256) {
    return {
      ok: false,
      failure: FingerprintFailure.PINNED_MISMATCH,
      detail: 'the coding CLI does not match its pinned content fingerprint',
      realpath,
      sha256,
    };
  }

  let version;
  try {
    const { stdout } = await exec(realpath, ['--version'], { timeout: timeoutMs });
    version = String(stdout).trim().slice(0, 200);
  } catch (err) {
    if (err?.kind === 'privilege_drop_failed') {
      return {
        ok: false,
        failure: FingerprintFailure.PRIVILEGE_DROP_FAILED,
        detail: `the coding CLI could not be run as the unprivileged account: ${String(err.message ?? '').slice(0, 200)}`,
        realpath,
        sha256,
      };
    }
    // This probe runs a real process exactly like the phase it is fingerprinting for, and can leave
    // an unconfirmed descendant behind in the same way. Rebuilding a plain failure result below
    // without this would silently drop that verdict — the caller (verifyConfiguration) would have no
    // way to know a kill could not be confirmed, and would carry on into the actual CLI launch.
    return {
      ok: false,
      failure: FingerprintFailure.VERSION_UNAVAILABLE,
      detail: 'the coding CLI did not report a version',
      realpath,
      sha256,
      terminationConfirmed: err?.terminationConfirmed ?? null,
    };
  }

  let helpText;
  try {
    const { stdout } = await exec(realpath, ['--help'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    helpText = String(stdout);
  } catch (err) {
    // A kill this module could not confirm dead is refused outright, before even asking whether some
    // output happened to survive it: "some CLIs print help to stderr and exit non-zero, and that is
    // still a declaration" is a rule for an ORDINARY failure, and treating a real, unconfirmed kill as
    // though it were one just because stdout/stderr were non-empty would report success over exactly
    // the condition this verdict exists to catch.
    if (err?.terminationConfirmed === false) {
      return {
        ok: false,
        failure: FingerprintFailure.HELP_UNAVAILABLE,
        detail: 'the coding CLI did not declare its options',
        realpath,
        sha256,
        version,
        terminationConfirmed: false,
      };
    }
    // Some CLIs print help to stderr and exit non-zero; that is still a declaration.
    helpText = String(err?.stdout ?? '') + String(err?.stderr ?? '');
    if (!helpText.trim()) {
      return { ok: false, failure: FingerprintFailure.HELP_UNAVAILABLE, detail: 'the coding CLI did not declare its options', realpath, sha256 };
    }
  }

  const capabilities = {};
  for (const option of options) capabilities[option] = parseOptionCapability(helpText, option);

  return {
    ok: true,
    realpath,
    sha256,
    version,
    capabilities,
    // The identity this fingerprint is *for*. A change to any of it invalidates the cache, because
    // a different file is a different program however it is named.
    identity: { dev: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) },
    probed_at: new Date().toISOString(),
  };
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Cache fingerprints, invalidated only by a change in the binary's own identity.
 *
 * Hashing 275 MB on every verification would be absurd; trusting a cached answer after the file
 * changed would be worse. The key is the identity itself, so a rebuilt or replaced binary simply
 * does not hit the cache — there is no staleness window to reason about.
 */
export class FingerprintCache {
  constructor({ exec, ttlMs = 15 * 60 * 1_000 } = {}) {
    this._entries = new Map();
    this._inFlight = new Map();
    this._exec = exec;
    this.ttlMs = ttlMs;
  }

  async get(request) {
    // Concurrent verifications of the same binary asked the same question N times over: N hashes of
    // a 275 MB file and, now that the probe launches through a privilege drop, 2N helper processes
    // as well. Callers that arrive while an answer is being computed wait for that answer instead.
    // Keyed on the request, so a different binary or a different pin is never served this one.
    const key = JSON.stringify([request.executable, [...(request.options ?? [])].sort(), request.expectedSha256 ?? null]);
    const pending = this._inFlight.get(key);
    if (pending) return pending;

    const attempt = this._get(request);
    this._inFlight.set(key, attempt);
    try {
      return await attempt;
    } finally {
      if (this._inFlight.get(key) === attempt) this._inFlight.delete(key);
    }
  }

  async _get({ executable, options, expectedSha256 = null }) {
    // A pinned deployment never serves from cache. Identity is not content: an in-place write that
    // preserves inode, size and mtime (trivial with `touch -r`) collides with the key, and the pin
    // is the one control designed to catch exactly that substitution. Re-hashing costs ~1s and is
    // the whole point of having pinned.
    if (expectedSha256) {
      return probeBinaryFingerprint({
        executable, options, expectedSha256, ...(this._exec ? { exec: this._exec } : {}),
      });
    }

    let identityKey = null;
    try {
      const realpath = await fsp.realpath(executable);
      const stat = await fsp.stat(realpath);
      identityKey = `${realpath}:${stat.dev}:${stat.ino}:${stat.size}:${Math.floor(stat.mtimeMs)}:${[...options].sort().join(',')}`;
    } catch {
      // Unresolvable: fall through to the probe, which reports the failure properly.
    }

    const cached = identityKey ? this._entries.get(identityKey) : null;
    // Bounded even for the unpinned case: identity collision is possible, so trust has a lifetime.
    if (cached && Date.now() - cached._cachedAt < this.ttlMs) return cached;

    const fingerprint = await probeBinaryFingerprint({
      executable, options, expectedSha256, ...(this._exec ? { exec: this._exec } : {}),
    });
    // Only a successful probe is cached. A failure may be transient (a partially written binary
    // mid-upgrade), and caching it would keep the instance down after the cause cleared.
    if (identityKey && fingerprint.ok) {
      this._entries.set(identityKey, Object.assign(fingerprint, { _cachedAt: Date.now() }));
    }
    return fingerprint;
  }

  /** Number of cached identities. Exposed so a test can prove the cache is actually used. */
  get size() {
    return this._entries.size;
  }
}
