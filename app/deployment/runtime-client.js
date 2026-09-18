import { connectorRequest, connectorSshArgv } from './connector-client.js';

export { nextConnectorRequestId as nextRuntimeRequestId } from './connector-client.js';

export function runtimeSshArgv(runtime, sshPath) {
  return connectorSshArgv('runtime', runtime, sshPath);
}

export function runtimeRequest(runtime, request, options) {
  return connectorRequest('runtime', runtime, request, options);
}
