'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { classifyModel, resolveRoute } = require('../src/routing');
const { createModeState, loadRoutes, loadRuntimeConfig } = require('../src/config');

test('classifies known Claude tiers and defaults unknown models', () => {
  assert.equal(classifyModel('claude-fable-5'), 'fable');
  assert.equal(classifyModel('CLAUDE-OPUS-4-8'), 'opus');
  assert.equal(classifyModel('claude-sonnet-5'), 'sonnet');
  assert.equal(classifyModel('claude-haiku-4-5'), 'haiku');
  assert.equal(classifyModel('Qwen3.6'), 'default');
  assert.equal(classifyModel(''), 'default');
  assert.equal(classifyModel(null), 'default');
});

test('loads the complete version-neutral route matrix', () => {
  const modes = loadRoutes();
  assert.deepEqual(Object.keys(modes), [
    'NATIVE',
    'HYBRID-PERFORMANCE',
    'HYBRID-BALANCE',
    'PERFORMANCE',
    'BALANCE',
  ]);
  assert.deepEqual(modes.NATIVE.routes, {
    fable: 'native', opus: 'native', sonnet: 'native', haiku: 'native', default: 'native',
  });
  assert.deepEqual(modes['HYBRID-PERFORMANCE'].routes, {
    fable: 'native', opus: 'native', sonnet: 'performance', haiku: 'balance', default: 'native',
  });
  assert.deepEqual(modes['HYBRID-BALANCE'].routes, {
    fable: 'native', opus: 'native', sonnet: 'balance', haiku: 'balance', default: 'native',
  });
  assert.deepEqual(modes.PERFORMANCE.routes, {
    fable: 'performance', opus: 'performance', sonnet: 'performance', haiku: 'balance', default: 'performance',
  });
  assert.deepEqual(modes.BALANCE.routes, {
    fable: 'balance', opus: 'performance', sonnet: 'balance', haiku: 'balance', default: 'balance',
  });
  assert.deepEqual(resolveRoute(modes.BALANCE, 'claude-opus-4-8'), { tier: 'opus', upstream: 'performance' });
});

test('rejects missing tiers and unknown upstreams', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-routes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'routes.json');
  const valid = {
    NATIVE: {
      description: 'test',
      routes: { fable: 'native', opus: 'native', sonnet: 'native', haiku: 'native', default: 'native' },
    },
  };

  fs.writeFileSync(file, JSON.stringify({ NATIVE: { ...valid.NATIVE, routes: { ...valid.NATIVE.routes, haiku: undefined } } }));
  assert.throws(() => loadRoutes(file), /routes\.haiku is required/);

  fs.writeFileSync(file, JSON.stringify({ NATIVE: { ...valid.NATIVE, routes: { ...valid.NATIVE.routes, opus: 'gpt56' } } }));
  assert.throws(() => loadRoutes(file), /unknown upstream "gpt56"/);
});

test('allows unused upstreams to remain unconfigured', () => {
  const config = loadRuntimeConfig({});
  assert.equal(config.upstreams.native.missing, true);
  assert.equal(config.upstreams.performance.missing, true);
  assert.equal(config.upstreams.balance.missing, true);
});

test('hot-reloads an atomic mode replacement with an unchanged timestamp', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'active-mode');
  const replacement = path.join(directory, '.active-mode.next');
  const activeModeName = createModeState({ modes: loadRoutes(), stateFile });

  fs.writeFileSync(stateFile, 'PERFORMANCE\n');
  fs.utimesSync(stateFile, 1, 1);
  assert.equal(activeModeName(), 'PERFORMANCE');
  const original = fs.statSync(stateFile);

  fs.writeFileSync(replacement, 'BALANCE\n');
  fs.utimesSync(replacement, 1, 1);
  fs.renameSync(replacement, stateFile);
  const replaced = fs.statSync(stateFile);
  assert.equal(replaced.mtimeMs, original.mtimeMs);
  assert.notEqual(replaced.ino, original.ino);
  assert.equal(activeModeName(), 'BALANCE');
});

test('hot-reloads active mode and retains the last valid value', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'active-mode');
  const logs = [];
  const activeModeName = createModeState({
    modes: loadRoutes(),
    stateFile,
    log: (message) => logs.push(message),
  });

  assert.equal(activeModeName(), 'NATIVE');
  fs.writeFileSync(stateFile, 'PERFORMANCE\n');
  assert.equal(activeModeName(), 'PERFORMANCE');
  fs.writeFileSync(stateFile, 'NOT-A-MODE\n');
  fs.utimesSync(stateFile, new Date(), new Date(Date.now() + 1000));
  assert.equal(activeModeName(), 'PERFORMANCE');
  assert.match(logs.at(-1), /active mode "NOT-A-MODE" unknown/);
});
