import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../atomic-file.js';
import { DeploymentError, fields } from './protocol.js';
import { resolveJobPolicy } from './policy.js';

const FILE = 'runtime-candidate.json';
const invalid = () => new DeploymentError('Unsafe runtime candidate checkpoint', 503, 'invalid_state');

async function checkpointPath(directory) {
  if (process.platform !== 'linux' || typeof directory !== 'string' || !path.isAbsolute(directory)) throw invalid();
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw invalid();
  return path.join(directory, FILE);
}

export function validateRuntimeCandidate(value, job, config) {
  fields(value, ['jobId', 'instanceId', 'project', 'target', 'revision', 'image', 'imageId'], 'runtime candidate checkpoint');
  if (value.jobId !== job.id || value.instanceId !== config.container.instanceId
      || value.project !== job.project || value.target !== job.target || value.revision !== job.revision
      || typeof value.image !== 'string' || !value.image
      || !/^sha256:[a-f0-9]{64}$/.test(value.imageId || '')) throw invalid();
  resolveJobPolicy(config, { defaultTimeoutSeconds: 30 }, {}, {
    project: job.project, target: job.target,
    recipe: { adapter: 'podman', image: value.image, service: value.image },
  });
  return value;
}

export class RuntimeCandidateJournal {
  async write(directory, value) {
    const file = await checkpointPath(directory);
    await writeFileAtomic(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  async read(directory) {
    const file = await checkpointPath(directory);
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o077) || stat.size > 4096) throw invalid();
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) throw invalid();
      throw error;
    }
  }

  async remove(directory) {
    const file = await checkpointPath(directory);
    await fs.unlink(file);
  }
}
