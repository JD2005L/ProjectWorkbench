#!/usr/bin/env node
// Serve the constrained orchestration MCP adapter over stdio.
//
// Runs in the same process model as any other MCP server: newline-delimited JSON-RPC on stdin and
// stdout. Because stdout *is* the protocol channel, every diagnostic goes to stderr — a stray
// console.log here would corrupt the stream rather than merely look untidy.
//
// The credential is supplied by the environment, not by the protocol. An MCP client is trusted to
// have been configured with a token; the token is what selects the orchestrator instance and the
// project grants, exactly as over HTTP.
//
//   PW_ORCHESTRATOR_ENABLED=true \
//   PW_ORCHESTRATOR_INSTANCE_ID=<id> \
//   PW_ORCHESTRATOR_SERVICE_TOKEN=<secret> \
//     node bin/pw-orchestrator-mcp.mjs

import readline from 'readline';
import crypto from 'crypto';

import { createOrchestratorSubsystem } from '../app/orchestrator/index.js';
import { createToolDispatcher, createMcpHandler } from '../app/orchestrator/mcp.js';
import { ServiceTokenStore } from '../app/orchestrator/auth.js';
import {
  resolveProject, capabilitiesPayload, listGrantedProjects,
} from '../app/orchestrator/projects.js';

const fail = (message) => {
  process.stderr.write(`[pw-orchestrator-mcp] ${message}\n`);
  process.exit(1);
};

const subsystem = await createOrchestratorSubsystem({ workbenchVersion: 'mcp-stdio' })
  .catch((err) => fail(`could not start: ${err.message}`));
if (!subsystem) fail('the orchestration subsystem is not enabled (set PW_ORCHESTRATOR_ENABLED=true)');

// Resolve the credential the same way the HTTP surface does, so the two cannot diverge: the same
// token file, the same digest comparison, the same project grants and scopes.
const presented = process.env.PW_ORCHESTRATOR_SERVICE_TOKEN || '';
if (!presented) fail('PW_ORCHESTRATOR_SERVICE_TOKEN is not set');
const digest = crypto.createHash('sha256').update(presented, 'utf8').digest('hex');
const token = new ServiceTokenStore(subsystem.config.tokensPath).load()
  .find((candidate) => crypto.timingSafeEqual(Buffer.from(candidate.secret_sha256, 'hex'), Buffer.from(digest, 'hex')));
if (!token) fail('the service token was rejected');

const dispatch = createToolDispatcher({
  engine: subsystem.engine,
  sessionManager: subsystem.sessionManager,
  backend: subsystem.backend,
  config: subsystem.config,
  projectStore: subsystem.projectStore,
  resolveProject: {
    resolve: (c, ps, tk, id) => resolveProject(c, ps, tk, id),
    capabilities: (c, ps, tk, id) => capabilitiesPayload(c, resolveProject(c, ps, tk, id)),
    list: (c, ps, tk) => listGrantedProjects(c, ps, tk),
  },
});

const handle = createMcpHandler({ dispatch, token, serverVersion: '1.0' });

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
    return;
  }
  const response = await handle(message);
  // A notification produces no response; writing one would be a protocol violation.
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
});

const shutdown = async () => {
  await subsystem.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
rl.on('close', shutdown);
