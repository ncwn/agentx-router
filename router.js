#!/usr/bin/env node
'use strict';

const { loadRuntimeConfig, createModeState, UPSTREAM_NAMES } = require('./src/config');
const { createProxyServer } = require('./src/proxy');

function die(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

let config;
try {
  config = loadRuntimeConfig();
} catch (error) {
  die(error.message);
}

const activeModeName = createModeState(config);
const server = createProxyServer({ ...config, activeModeName });

server.on('error', (error) => {
  die(`cannot listen on :${config.port}: ${error.message}${error.code === 'EADDRINUSE' ? ' (another router already running?)' : ''}`);
});

server.listen(config.port, '127.0.0.1', () => {
  const bar = '-'.repeat(64);
  console.error(bar);
  console.error(`agentx-cc-router   http://127.0.0.1:${config.port}`);
  console.error(bar);
  console.error(`active mode  ${activeModeName()}   (state: ${config.stateFile})`);
  console.error('switch with  ./agentx-mode <MODE>   (applies on the next request)');
  for (const name of UPSTREAM_NAMES) {
    const upstream = config.upstreams[name];
    console.error(`upstream     ${name.padEnd(11)} ${upstream.missing ? `(MISSING ${upstream.baseEnv}/${upstream.keyEnv})` : `-> ${upstream.base}`}`);
  }
  console.error(bar);
});
