'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { resolveRoute } = require('./routing');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailers',
  'upgrade', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
]);

function endToEndHeaders(headers) {
  const result = { ...headers };
  const connection = Array.isArray(headers.connection) ? headers.connection : [headers.connection];
  const nominated = connection
    .filter(Boolean)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const header of [...HOP_BY_HOP, ...nominated]) delete result[header];
  return result;
}

function jsonError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
}

function createProxyServer({ modes, upstreams, activeModeName, connectTimeoutMs, idleTimeoutMs, log = (message) => process.stderr.write(message) }) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', () => {
      try { jsonError(res, 400, 'router: invalid request body'); } catch (_) {}
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let model = '';
      if (body.length) {
        try { model = JSON.parse(body.toString('utf8')).model || ''; }
        catch (_) { log(`${new Date().toISOString()} [router] WARN: body not JSON; routing by default\n`); }
      }

      const modeName = activeModeName();
      const mode = modes[modeName];
      if (!mode) {
        jsonError(res, 500, `router: active mode "${modeName}" not in route configuration`);
        return;
      }

      const { tier, upstream: upstreamName } = resolveRoute(mode, model);
      const upstream = upstreams[upstreamName];
      if (!upstream || upstream.missing) {
        log(`${new Date().toISOString()} [${modeName}] model="${model}" tier=${tier} -> ${upstreamName} NOT CONFIGURED\n`);
        jsonError(res, 502, `router: mode ${modeName} needs upstream "${upstreamName}" but ${(upstream && upstream.baseEnv) || '?'}/${(upstream && upstream.keyEnv) || '?'} is not set in .env`);
        return;
      }

      let target;
      try {
        target = new URL(upstream.base);
        if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error(`unsupported protocol ${target.protocol}`);
      } catch (error) {
        jsonError(res, 500, `router: bad base for ${upstreamName}: ${error.message}`);
        return;
      }

      const headers = endToEndHeaders(req.headers);
      delete headers['x-api-key'];
      headers.host = target.host;
      headers.authorization = `Bearer ${upstream.key}`;
      if (body.length) headers['content-length'] = String(body.length);

      const isHttps = target.protocol === 'https:';
      const options = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        method: req.method,
        path: req.url,
        headers,
      };

      log(`${new Date().toISOString()} [${modeName}] ${req.method} ${req.url} model="${model}" tier=${tier} -> ${upstreamName} ${upstream.base}\n`);

      const forwarded = (isHttps ? https : http).request(options, (upstreamResponse) => {
        forwarded.setTimeout(idleTimeoutMs);
        const responseHeaders = endToEndHeaders(upstreamResponse.headers);
        res.writeHead(upstreamResponse.statusCode, responseHeaders);
        upstreamResponse.on('error', (error) => {
          log(`${new Date().toISOString()} [${modeName}] upstream "${upstreamName}" stream error: ${error.message}\n`);
          try { res.destroy(); } catch (_) {}
        });
        res.on('close', () => {
          try { upstreamResponse.destroy(); } catch (_) {}
        });
        upstreamResponse.pipe(res);
      });

      forwarded.on('timeout', () => {
        log(`${new Date().toISOString()} [${modeName}] upstream "${upstreamName}" timed out\n`);
        forwarded.destroy(new Error('upstream timeout'));
      });
      forwarded.on('error', (error) => {
        log(`${new Date().toISOString()} [${modeName}] upstream "${upstreamName}" error: ${error.message}\n`);
        if (res.headersSent) {
          try { res.destroy(); } catch (_) {}
          return;
        }
        jsonError(res, 502, `router: upstream ${upstreamName} failed: ${error.message}`);
      });
      forwarded.setTimeout(connectTimeoutMs);
      if (body.length) forwarded.write(body);
      forwarded.end();
    });
  });
}

module.exports = { HOP_BY_HOP, endToEndHeaders, createProxyServer };
