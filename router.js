#!/usr/bin/env node
'use strict';
/*
 * agentx-cc-router — single-port, hot-swappable verbatim Anthropic /v1/messages router.
 *
 * Point Claude Code at ONE fixed port (set once in ~/.claude/settings.json and
 * never touched again). The ACTIVE MODE is read from the `active-mode` state
 * file on every request — so `./agentx-mode <MODE>` switches routing instantly,
 * with no client change and no router restart.
 *
 * Per request: read active mode -> classify the request's `model` into a tier
 * (opus / sonnet / background) -> look up the mode's route table -> pick an
 * upstream {base, key} (native / gpt55 / gpt54) -> forward the request
 * BYTE-FOR-BYTE, overriding ONLY the Host header and the Authorization Bearer
 * key. The body and all client headers (User-Agent: claude-cli, x-app,
 * anthropic-*, the system[] blocks, metadata.user_id) pass through untouched.
 *
 * Run:  ./agentx-up      (starts this on the fixed port; leave it running)
 * Switch mode:  ./agentx-mode BB
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const PORT = parseInt(process.env.AGENTX_PORT || '8787', 10);
const STATE_FILE = process.env.AGENTX_STATE_FILE || path.join(ROOT, 'active-mode');
const CONNECT_TIMEOUT_MS = parseInt(process.env.AGENTX_CONNECT_TIMEOUT_MS || '60000', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.AGENTX_IDLE_TIMEOUT_MS || '300000', 10);

function die(m) { console.error('FATAL: ' + m); process.exit(1); }

let modes;
try { modes = JSON.parse(fs.readFileSync(path.join(ROOT, 'modes.json'), 'utf8')); }
catch (e) { die('cannot read modes.json: ' + e.message); }

const DEFAULT_MODE = (() => {
  const env = (process.env.AGENTX_MODE || '').trim().toUpperCase();
  if (modes[env]) return env;
  return modes.NB ? 'NB' : Object.keys(modes)[0];
})();

// Upstream name -> {base,key} from env. Resolved once at startup (env is fixed
// for the process); a missing one only fails the modes that actually use it.
const UPSTREAM_ENV = {
  native: ['AGENTX_NATIVE_BASE', 'AGENTX_NATIVE_KEY'],
  gpt55: ['AGENTX_GPT55_BASE', 'AGENTX_GPT55_KEY'],
  gpt54: ['AGENTX_GPT54_BASE', 'AGENTX_GPT54_KEY'],
};
function resolveUpstream(name) {
  const env = UPSTREAM_ENV[name];
  if (!env) return { name, base: '', key: '', missing: true };
  const base = (process.env[env[0]] || '').trim().replace(/\/+$/, '');
  const key = (process.env[env[1]] || '').trim();
  return { name, base, key, baseEnv: env[0], keyEnv: env[1], missing: !base || !key };
}
const UPSTREAMS = { native: resolveUpstream('native'), gpt55: resolveUpstream('gpt55'), gpt54: resolveUpstream('gpt54') };

// ── active mode: hot-swapped via the state file, cached by mtime ─────────────
let _cache = { mtime: -1, name: DEFAULT_MODE };
function activeModeName() {
  try {
    const st = fs.statSync(STATE_FILE);
    if (st.mtimeMs !== _cache.mtime) {
      const n = fs.readFileSync(STATE_FILE, 'utf8').trim().toUpperCase();
      if (modes[n]) _cache = { mtime: st.mtimeMs, name: n };
      else { _cache.mtime = st.mtimeMs; process.stderr.write(`[router] WARN: active-mode "${n}" unknown; staying on ${_cache.name}\n`); }
    }
  } catch (_) { /* no state file yet -> DEFAULT_MODE */ }
  return _cache.name;
}

function tierOf(model) {
  // Substring match (claude-opus-*, claude-sonnet-*, claude-haiku-*). haiku
  // first so a background model never falls through to opus/sonnet.
  const m = (model || '').toLowerCase();
  if (m.includes('haiku')) return 'background';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  return null;
}

// Hop-by-hop headers (RFC 7230 §6.1) stripped both ways. content-encoding is
// intentionally NOT here — a gzipped upstream response pipes back as-is.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailers',
  'upgrade', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
]);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('error', () => { try { res.writeHead(400); res.end(); } catch (_) {} });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let model = '';
    if (body.length) {
      try { model = JSON.parse(body.toString('utf8')).model || ''; }
      catch (_) { process.stderr.write(`[router] WARN: body not JSON — routing by default tier\n`); }
    }

    const modeName = activeModeName();
    const mode = modes[modeName];
    if (!mode) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `router: active mode "${modeName}" not in modes.json` } })); return; }

    const tier = tierOf(model);
    const upName = (tier && mode.routes[tier]) || mode.default || mode.routes.opus;
    const up = UPSTREAMS[upName];

    if (!up || up.missing) {
      process.stderr.write(`[${modeName}] model="${model}" tier=${tier} -> ${upName} NOT CONFIGURED\n`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `router: mode ${modeName} needs upstream "${upName}" but ${(up && up.baseEnv) || '?'}/${(up && up.keyEnv) || '?'} is not set in .env` } }));
      return;
    }

    let target;
    try { target = new URL(up.base); }
    catch (e) { res.writeHead(500); res.end(`router: bad base for ${upName}: ${e.message}`); return; }

    const headers = Object.assign({}, req.headers);
    for (const h of HOP_BY_HOP) delete headers[h];
    delete headers['x-api-key']; // drop the client's placeholder credential
    headers.host = target.host;
    headers['authorization'] = 'Bearer ' + up.key;
    if (body.length) headers['content-length'] = String(Buffer.byteLength(body));

    const isHttps = target.protocol === 'https:';
    const agent = isHttps ? https : http;
    const opts = { protocol: target.protocol, hostname: target.hostname, port: target.port || (isHttps ? 443 : 80), method: req.method, path: req.url, headers };

    process.stderr.write(`[${modeName}] ${req.method} ${req.url} model="${model}" tier=${tier} -> ${upName} ${up.base}\n`);

    const fwd = agent.request(opts, (upRes) => {
      fwd.setTimeout(IDLE_TIMEOUT_MS); // relax to idle deadline once streaming
      const rh = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(k)) rh[k] = v;
      res.writeHead(upRes.statusCode, rh);
      upRes.on('error', (e) => { process.stderr.write(`[${modeName}] upstream "${upName}" stream error: ${e.message}\n`); try { res.destroy(); } catch (_) {} });
      res.on('close', () => { try { upRes.destroy(); } catch (_) {} });
      upRes.pipe(res); // stream SSE through unbuffered
    });
    fwd.on('timeout', () => { process.stderr.write(`[${modeName}] upstream "${upName}" timed out\n`); fwd.destroy(new Error('upstream timeout')); });
    fwd.on('error', (e) => {
      process.stderr.write(`[${modeName}] upstream "${upName}" error: ${e.message}\n`);
      if (res.headersSent) { try { res.destroy(); } catch (_) {} return; }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `router: upstream ${upName} failed: ${e.message}` } }));
    });
    fwd.setTimeout(CONNECT_TIMEOUT_MS);
    if (body.length) fwd.write(body);
    fwd.end();
  });
});

server.on('error', (e) => die(`cannot listen on :${PORT}: ${e.message}` + (e.code === 'EADDRINUSE' ? ' (another router already running?)' : '')));
server.listen(PORT, '127.0.0.1', () => {
  const bar = '─'.repeat(64);
  console.error(bar);
  console.error(`agentx-cc-router (single-port, hot-swap)   http://127.0.0.1:${PORT}`);
  console.error(bar);
  console.error(`active mode  ${activeModeName()}   (state file: ${STATE_FILE})`);
  const _am = modes[activeModeName()];
  if (_am && _am.ultracode && (!_am.cc || (_am.cc.effortLevel !== 'xhigh' && _am.cc.effortLevel !== 'ultracode')))
    console.error(`WARN: mode ${activeModeName()} is ultracode but effort="${_am.cc.effortLevel}" — ultracode only activates at xhigh`);
  console.error('switch with  ./agentx-mode <MODE>   — applies on the next request, no restart');
  for (const n of Object.keys(UPSTREAMS)) {
    const u = UPSTREAMS[n];
    console.error(`upstream     ${n.padEnd(7)} ${u.missing ? `(MISSING ${u.baseEnv}/${u.keyEnv})` : '-> ' + u.base}`);
  }
  console.error(bar);
  console.error('Set ONCE in ~/.claude/settings.json "env" (then never touch it):');
  console.error(`  "ANTHROPIC_BASE_URL": "http://127.0.0.1:${PORT}",`);
  console.error('  "ANTHROPIC_AUTH_TOKEN": "router-managed"   (dummy; router supplies the real key)');
  console.error('  (do NOT set ANTHROPIC_API_KEY)');
  console.error(bar);
});
