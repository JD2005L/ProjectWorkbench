// Keeping the GitHub CLI installed — and, more importantly, keeping its ABSENCE visible.
//
// gh has gone missing here more than once, and each time it was discovered by an agent
// failing mid-task rather than by the workbench saying so. The cause was never a bad
// recipe: the Containerfile installs gh, correctly, with `set -eux` and a closing
// `gh --version` so a half-download fails the build. What went wrong was placement and
// timing —
//
//   * the running image predated that layer (its /usr/local/bin is dated 2026-08-21,
//     the layer landed 2026-09-09), and an image is only rebuilt deliberately;
//   * every runtime install inside a container went into the container's writable layer,
//     which the next `podman run` discards.
//
// So the fix has three parts, and this file pins all three: the image layer stays, the
// installer targets a filesystem that survives a recreate, and the dashboard reports the
// tool as missing if it ever is again. The third is the one that stops this recurring
// silently, which is the actual complaint.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CONTAINERFILE = fs.readFileSync(new URL('../Containerfile', import.meta.url), 'utf8');
const INSTALLER = fs.readFileSync(new URL('../deploy/install-gh.sh', import.meta.url), 'utf8');
const SERVER = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');

test('the image still installs gh, and still fails the build rather than shipping a partial one', () => {
  assert.match(CONTAINERFILE, /cli\/cli\/releases\/download/, 'the gh layer must not be dropped from the image');
  const layer = CONTAINERFILE.slice(CONTAINERFILE.indexOf('# GitHub CLI (gh)'));
  const step = layer.slice(0, layer.indexOf('\n\n'));
  assert.match(step, /set -eux/, 'a failing step must abort the layer');
  assert.match(step, /gh --version/, 'and the layer must prove the binary runs before it is accepted');
});

test('the installer targets a filesystem that SURVIVES a container recreation', () => {
  // The whole point. /opt/npm-global is a real host filesystem bind-mounted into the
  // containers — the same reason sqlcmd has lived there across every recreate — and it
  // is already first on a pane's PATH.
  assert.match(INSTALLER, /PW_GH_DEST:-\/opt\/npm-global\/bin/, 'default destination must be the persistent mount');
  // And it refuses the mistake it exists to prevent, rather than trusting the operator
  // to pass the right path.
  assert.match(INSTALLER, /tmpfs\|overlay\|overlayfs/, 'an ephemeral filesystem must be refused');
  assert.match(INSTALLER, /does NOT survive a container recreation/);
});

test('the download is verified, so a truncated or tampered fetch fails closed', () => {
  // An unverified install is how you get a binary that exists, does not run, and
  // reports itself as "not installed" in a way nobody can explain.
  assert.match(INSTALLER, /checksums\.txt/, 'the published checksums must be fetched');
  assert.match(INSTALLER, /sha256sum/);
  assert.match(INSTALLER, /checksum mismatch/, 'and a mismatch must abort');
  assert.match(INSTALLER, /no checksum published/, 'as must a missing checksum entry');
  assert.match(INSTALLER, /refusing to install an unverified binary/);
});

test('the installer is atomic and verifies the result', () => {
  // A half-written binary on a shared mount is visible to every pane while it is being
  // written, so it lands under a temporary name and is moved into place.
  assert.match(INSTALLER, /\.gh\.new/);
  assert.match(INSTALLER, /mv -f "\$DEST_DIR\/\.gh\.new" "\$DEST_DIR\/gh"/);
  assert.match(INSTALLER, /--version \|\| die/, 'and the installed binary must be run before success is claimed');
});

test('the readiness checklist reports gh, so its absence is never silent again', () => {
  assert.match(SERVER, /ghInstalled: !!\(await getCliVersion\('gh'\)\)/, 'the check must ask the tool itself');
  assert.match(SERVER, /\['ghInstalled','GitHub CLI \(gh\) installed/, 'and the checklist must show it');
  // It names the remedy: a check that only says "missing" sends the reader hunting for
  // the install method that keeps not sticking.
  assert.match(SERVER, /ghInstalled','GitHub CLI \(gh\) installed — deploy\/install-gh\.sh/);
});

test('the version is resolved without the rate-limited API, and pinned if that fails', () => {
  // The unauthenticated releases API is rate-limited and would flake a build or an
  // install; the releases/latest redirect is not. Same approach as the Containerfile,
  // deliberately, so the two cannot disagree about which gh you get.
  assert.match(INSTALLER, /releases\/latest/);
  assert.match(INSTALLER, /FALLBACK_VERSION=/);
  assert.match(CONTAINERFILE, /releases\/latest/);
  // A version argument is validated before it becomes part of a URL.
  assert.match(INSTALLER, /does not look like a release number/);
});
