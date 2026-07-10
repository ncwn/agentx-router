'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const test = require('node:test');
const { createProxyServer } = require('../src/proxy');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, body, path = '/v1/messages?beta=true') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': 'router-managed',
        authorization: 'Bearer placeholder',
        connection: 'x-request-hop',
        'x-request-hop': 'remove me',
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function proxyOptions(mode, upstreams, logs = []) {
  return {
    modes: { TEST: mode },
    upstreams,
    activeModeName: () => 'TEST',
    connectTimeoutMs: 1000,
    idleTimeoutMs: 1000,
    log: (message) => logs.push(message),
  };
}

test('forwards original bytes and query while replacing routing headers', async (t) => {
  let received;
  const receivedRequest = new Promise((resolve) => { received = resolve; });
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'x-response-hop',
        'x-response-hop': 'remove me',
        'x-upstream': 'yes',
      });
      res.end('data: {"ok":true}\n\n');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const base = `http://127.0.0.1:${upstreamPort}`;
  const proxy = createProxyServer(proxyOptions(
    { routes: { fable: 'performance', opus: 'performance', sonnet: 'performance', haiku: 'balance', default: 'balance' } },
    {
      performance: { name: 'performance', base, key: 'performance-key', missing: false },
      balance: { name: 'balance', base, key: 'balance-key', missing: false },
    },
  ));
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const original = '{"model":"claude-fable-5", "messages":[]}\n';
  const [response, upstreamRequest] = await Promise.all([request(proxyPort, original), receivedRequest]);
  assert.equal(upstreamRequest.method, 'POST');
  assert.equal(upstreamRequest.url, '/v1/messages?beta=true');
  assert.equal(upstreamRequest.body, original);
  assert.equal(upstreamRequest.headers.authorization, 'Bearer performance-key');
  assert.equal(upstreamRequest.headers['x-api-key'], undefined);
  assert.equal(upstreamRequest.headers['x-request-hop'], undefined);
  assert.equal(upstreamRequest.headers['anthropic-version'], '2023-06-01');
  assert.equal(upstreamRequest.headers.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-response-hop'], undefined);
  assert.equal(response.headers['x-upstream'], 'yes');
  assert.equal(response.body, 'data: {"ok":true}\n\n');
});

test('routes malformed JSON through the default path without rewriting it', async (t) => {
  let received;
  const receivedRequest = new Promise((resolve) => { received = resolve; });
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received(Buffer.concat(chunks).toString());
      res.end('ok');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const logs = [];
  const base = `http://127.0.0.1:${upstreamPort}`;
  const proxy = createProxyServer(proxyOptions(
    { routes: { fable: 'performance', opus: 'performance', sonnet: 'performance', haiku: 'performance', default: 'balance' } },
    { balance: { name: 'balance', base, key: 'balance-key', missing: false } },
    logs,
  ));
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const malformed = '{not-json';
  const [response, upstreamBody] = await Promise.all([request(proxyPort, malformed), receivedRequest]);
  assert.equal(response.status, 200);
  assert.equal(upstreamBody, malformed);
  assert.ok(logs.some((line) => line.includes('body not JSON')));
  assert.ok(logs.some((line) => line.includes('tier=default -> balance')));
});

test('returns a clear 502 for an unconfigured selected upstream', async (t) => {
  const mode = { routes: { fable: 'native', opus: 'native', sonnet: 'native', haiku: 'native', default: 'balance' } };
  const proxy = createProxyServer(proxyOptions(mode, {
    balance: {
      name: 'balance', base: '', key: '', missing: true,
      baseEnv: 'AGENTX_BALANCE_BASE', keyEnv: 'AGENTX_BALANCE_KEY',
    },
  }));
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const response = await request(proxyPort, '{"model":"unknown"}');
  assert.equal(response.status, 502);
  assert.match(response.body, /AGENTX_BALANCE_BASE\/AGENTX_BALANCE_KEY/);
});

test('turns an upstream response timeout into a 502', async (t) => {
  const upstream = http.createServer(() => {});
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const base = `http://127.0.0.1:${upstreamPort}`;
  const mode = { routes: { fable: 'performance', opus: 'performance', sonnet: 'performance', haiku: 'performance', default: 'performance' } };
  const options = proxyOptions(mode, {
    performance: { name: 'performance', base, key: 'key', missing: false },
  });
  options.connectTimeoutMs = 30;
  const proxy = createProxyServer(options);
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const response = await request(proxyPort, '{"model":"claude-opus-4-8"}');
  assert.equal(response.status, 502);
  assert.match(response.body, /upstream timeout/);
});

test('turns an upstream connection failure into a 502', async (t) => {
  const unused = http.createServer();
  const unusedPort = await listen(unused);
  await close(unused);
  const mode = { routes: { fable: 'performance', opus: 'performance', sonnet: 'performance', haiku: 'performance', default: 'performance' } };
  const proxy = createProxyServer(proxyOptions(mode, {
    performance: { name: 'performance', base: `http://127.0.0.1:${unusedPort}`, key: 'key', missing: false },
  }));
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const response = await request(proxyPort, '{"model":"claude-sonnet-5"}');
  assert.equal(response.status, 502);
  assert.match(response.body, /upstream performance failed/);
});
