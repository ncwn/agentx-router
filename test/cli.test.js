'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const command = path.join(__dirname, '..', 'agentx-mode');

test('agentx-mode lists routes and atomically writes selected mode', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'active-mode');
  const env = { ...process.env, AGENTX_STATE_FILE: stateFile, AGENTX_PORT: '1' };

  const list = execFileSync(command, ['--list'], { env, encoding: 'utf8' });
  assert.match(list, /Mode\s+Fable\s+Opus\s+Sonnet\s+Haiku\s+Default/);
  assert.match(list, /HYBRID-PERFORMANCE/);
  assert.match(list, /logical server groups: native, performance, balance/);
  assert.match(list, /Concrete model versions and effort settings belong to the upstream servers/);
  assert.doesNotMatch(list, /gpt-[\d.]+/i);

  const output = execFileSync(command, ['balance'], { env, encoding: 'utf8' });
  assert.match(output, /active mode -> BALANCE/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), 'BALANCE\n');

  const invalid = spawnSync(command, ['PERF'], { env, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /unknown mode: PERF/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), 'BALANCE\n');
});
