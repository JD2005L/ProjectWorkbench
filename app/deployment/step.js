// The supervisor receives only this fixed executable in its unit definition.
// Script bodies and credentials arrive on stdin, never in systemd properties,
// command-line arguments, or the journal.
import { spawn } from 'node:child_process';

async function main() {
  if (!process.getuid || process.getuid() === 0) throw new Error('A deployment step must be non-root');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Execution envelope is too large');
  }
  const envelope = JSON.parse(input);
  if (!Array.isArray(envelope.argv) || !envelope.argv.length
      || envelope.argv.some(value => typeof value !== 'string' || value.includes('\0'))
      || !envelope.argv[0].startsWith('/') || !envelope.env || typeof envelope.env !== 'object'
      || Array.isArray(envelope.env)) throw new Error('Invalid execution envelope');
  for (const [key, value] of Object.entries(envelope.env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid step environment');
  }
  const child = spawn(envelope.argv[0], envelope.argv.slice(1), {
    env: envelope.env, stdio: ['pipe', 'inherit', 'inherit'],
  });
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE') {
      process.stderr.write('Deployment input delivery failed\n');
      process.exitCode = 74;
    }
  });
  child.stdin.end(envelope.input || '');
  child.on('error', () => {
    process.stderr.write('Deployment executable could not start\n');
    process.exitCode = 127;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 128 : 1);
  });
}

main().catch(() => {
  process.stderr.write('Invalid non-root deployment execution envelope\n');
  process.exitCode = 78;
});
