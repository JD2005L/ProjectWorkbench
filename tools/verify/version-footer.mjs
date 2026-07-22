import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RELEASE_VERSION, VERSION_PATTERN, readReleaseVersion } from '../../app/version.js';

assert.match(RELEASE_VERSION, VERSION_PATTERN, 'release version must use 1.YY.MMDD.hhmm');

const server = fs.readFileSync(new URL('../../app/server.js', import.meta.url), 'utf8');
assert.ok(server.includes('Release: <b>${esc(RELEASE_VERSION)}</b>'), 'shared footer must render the canonical release version');
const cockpitStart = server.indexOf("app.get(BASE + '/term/:project/'");
const cockpitEnd = server.indexOf("// Lightweight /files/", cockpitStart);
const cockpit = server.slice(cockpitStart, cockpitEnd);
assert.ok(cockpit.includes('${footer}</body>'), 'main cockpit must include the shared footer');
assert.ok(cockpit.includes('${statusBarCss}'), 'main cockpit must include shared footer styles');
assert.ok(server.includes('#pwStatusBar{height:32px;box-sizing:border-box;'), 'footer must have a fixed, box-sized height');
assert.ok(server.includes('overflow:hidden;white-space:nowrap'), 'footer must not wrap over cockpit content');
assert.ok(server.includes('body.pw-cockpit #shell{height:calc(100% - 32px)}'), 'cockpit must reserve the fixed footer height');

assert.throws(
 () => readReleaseVersion(new URL('./fixtures/missing-version', import.meta.url)),
 /Invalid Project Workbench release version/,
 'missing release metadata must fail closed',
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-version-'));
const invalidPath = path.join(tempDir, 'VERSION');
try {
 fs.writeFileSync(invalidPath, '1.26.1332.2460\n');
 assert.throws(
  () => readReleaseVersion(new URL(`file://${invalidPath}`)),
  /Invalid Project Workbench release version/,
  'impossible date/time components must fail closed',
 );
} finally {
 fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`version-footer PASS ${RELEASE_VERSION}`);
