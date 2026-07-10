'use strict';

const fs = require('fs');
const path = require('path');
const { TIERS } = require('./routing');

const ROOT = path.join(__dirname, '..');
const ROUTES_FILE = path.join(ROOT, 'config', 'routes.json');
const UPSTREAM_NAMES = ['native', 'performance', 'balance'];
const UPSTREAM_ENV = {
  native: ['AGENTX_NATIVE_BASE', 'AGENTX_NATIVE_KEY'],
  performance: ['AGENTX_PERFORMANCE_BASE', 'AGENTX_PERFORMANCE_KEY'],
  balance: ['AGENTX_BALANCE_BASE', 'AGENTX_BALANCE_KEY'],
};

function loadRoutes(file = ROUTES_FILE) {
  let modes;
  try {
    modes = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }

  if (!modes || Array.isArray(modes) || typeof modes !== 'object' || !Object.keys(modes).length) {
    throw new Error(`${file}: expected a non-empty object of routing modes`);
  }
  if (!modes.NATIVE) throw new Error(`${file}: NATIVE mode is required`);

  for (const [name, mode] of Object.entries(modes)) {
    if (!/^[A-Z]+(?:-[A-Z]+)*$/.test(name)) throw new Error(`${file}: invalid mode name "${name}"`);
    if (!mode || typeof mode !== 'object' || Array.isArray(mode)) throw new Error(`${file}: ${name} must be an object`);
    if (typeof mode.description !== 'string' || !mode.description.trim()) throw new Error(`${file}: ${name}.description is required`);
    if (!mode.routes || typeof mode.routes !== 'object' || Array.isArray(mode.routes)) throw new Error(`${file}: ${name}.routes must be an object`);

    const keys = Object.keys(mode.routes);
    for (const tier of TIERS) {
      if (!keys.includes(tier)) throw new Error(`${file}: ${name}.routes.${tier} is required`);
      if (!UPSTREAM_NAMES.includes(mode.routes[tier])) {
        throw new Error(`${file}: ${name}.routes.${tier} has unknown upstream "${mode.routes[tier]}"`);
      }
    }
    const extras = keys.filter((key) => !TIERS.includes(key));
    if (extras.length) throw new Error(`${file}: ${name}.routes has unknown tier "${extras[0]}"`);
  }
  return modes;
}

function positiveInteger(env, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = env[name] || String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
  return value;
}

function resolveUpstream(name, env) {
  const [baseEnv, keyEnv] = UPSTREAM_ENV[name];
  const base = (env[baseEnv] || '').trim().replace(/\/+$/, '');
  const key = (env[keyEnv] || '').trim();
  return { name, base, key, baseEnv, keyEnv, missing: !base || !key };
}

function loadRuntimeConfig(env = process.env, routesFile = ROUTES_FILE) {
  const modes = loadRoutes(routesFile);
  const requestedMode = (env.AGENTX_MODE || '').trim().toUpperCase();
  if (requestedMode && !modes[requestedMode]) throw new Error(`AGENTX_MODE has unknown mode "${requestedMode}"`);

  return {
    root: ROOT,
    modes,
    defaultMode: requestedMode || 'NATIVE',
    stateFile: env.AGENTX_STATE_FILE || path.join(ROOT, 'var', 'active-mode'),
    port: positiveInteger(env, 'AGENTX_PORT', 8787, 65535),
    connectTimeoutMs: positiveInteger(env, 'AGENTX_CONNECT_TIMEOUT_MS', 60000),
    idleTimeoutMs: positiveInteger(env, 'AGENTX_IDLE_TIMEOUT_MS', 300000),
    upstreams: Object.fromEntries(UPSTREAM_NAMES.map((name) => [name, resolveUpstream(name, env)])),
  };
}

function createModeState({ modes, stateFile, defaultMode = 'NATIVE', log = (message) => process.stderr.write(message) }) {
  let cache = { mtime: -1, inode: -1, name: defaultMode };

  return function activeModeName() {
    try {
      const stat = fs.statSync(stateFile);
      if (stat.mtimeMs !== cache.mtime || stat.ino !== cache.inode) {
        const name = fs.readFileSync(stateFile, 'utf8').trim().toUpperCase();
        if (modes[name]) cache = { mtime: stat.mtimeMs, inode: stat.ino, name };
        else {
          cache.mtime = stat.mtimeMs;
          cache.inode = stat.ino;
          log(`${new Date().toISOString()} [router] WARN: active mode "${name}" unknown; staying on ${cache.name}\n`);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') log(`${new Date().toISOString()} [router] WARN: cannot read active mode: ${error.message}\n`);
    }
    return cache.name;
  };
}

module.exports = {
  ROOT,
  ROUTES_FILE,
  UPSTREAM_NAMES,
  loadRoutes,
  loadRuntimeConfig,
  createModeState,
};
