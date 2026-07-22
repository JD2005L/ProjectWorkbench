import fs from 'node:fs';

export const VERSION_PATTERN = /^1\.(\d{2})\.(\d{2})(\d{2})\.(\d{2})(\d{2})$/;

function hasValidDateTime(version) {
 const match = VERSION_PATTERN.exec(version);
 if (!match) return false;
 const [, year, month, day, hour, minute] = match.map(Number);
 if (month < 1 || month > 12 || hour > 23 || minute > 59) return false;
 const date = new Date(Date.UTC(2000 + year, month - 1, day));
 return date.getUTCFullYear() === 2000 + year
  && date.getUTCMonth() === month - 1
  && date.getUTCDate() === day;
}

export function readReleaseVersion(fileUrl = new URL('./VERSION', import.meta.url)) {
 let version;
 try {
  version = fs.readFileSync(fileUrl, 'utf8').trim();
 } catch {
  throw new Error('Invalid Project Workbench release version: missing or unreadable');
 }
 if (!hasValidDateTime(version)) {
  throw new Error(`Invalid Project Workbench release version: ${version || '(empty)'}`);
 }
 return version;
}

export const RELEASE_VERSION = readReleaseVersion();
