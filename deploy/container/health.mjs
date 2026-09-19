import http from 'node:http';
import { readContainerConfig } from './app/deployment/container-config.js';

const config = await readContainerConfig(process.env.PW_DEPLOY_CONFIG || '/etc/pw-deploy/config.json');
const host = config.listen.host === '::1' ? '[::1]' : '127.0.0.1';
const request = http.get(`http://${host}:${config.listen.port}/health`, { timeout: 5000 }, response => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', text => {
    body += text;
    if (Buffer.byteLength(body) > 2048) request.destroy(new Error('Invalid health response'));
  });
  response.on('end', () => {
    let value;
    try { value = JSON.parse(body); }
    catch (error) {
      if (error instanceof SyntaxError) { process.exitCode = 1; return; }
      throw error;
    }
    if (response.statusCode !== 200 || value.ok !== true || value.service !== 'pw-deploy' || value.apiVersion !== 1) {
      process.exitCode = 1;
    }
  });
  response.on('error', () => { process.exitCode = 1; });
});
request.on('timeout', () => request.destroy(new Error('Health timeout')));
request.on('error', () => { process.exitCode = 1; });
