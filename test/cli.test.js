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
  assert.match(list, /Effort\s+Group\s+Fable Target\s+Opus Target\s+Sonnet Target\s+Haiku Target/);
  assert.match(list, /HIGH\s+PERFORMANCE\s+gpt-5\.6-sol\s+gpt-5\.5\s+gpt-5\.6-terra\s+gpt-5\.6-sol/);
  assert.match(list, /HIGH\s+BALANCE\s+gpt-5\.6-terra\s+gpt-5\.6-terra\s+gpt-5\.6-luna\s+gpt-5\.6-sol/);
  assert.match(list, /XHIGH\s+PERFORMANCE\s+gpt-5\.6-sol\s+gpt-5\.5\s+gpt-5\.6-terra\s+gpt-5\.6-sol/);
  assert.match(list, /XHIGH\s+BALANCE\s+gpt-5\.6-terra\s+gpt-5\.6-terra\s+gpt-5\.6-luna\s+gpt-5\.6-sol/);
  assert.match(list, /MAX\s+PERFORMANCE\s+gpt-5\.6-sol\s+gpt-5\.6-terra\s+gpt-5\.6-luna\s+gpt-5\.6-sol/);
  assert.match(list, /MAX\s+BALANCE\s+gpt-5\.6-terra\s+gpt-5\.6-terra\s+gpt-5\.6-luna\s+gpt-5\.6-sol/);
  assert.match(list, /PERFORMANCE\s+Haiku\s+gpt-5\.6-sol\/medium\s+gpt-5\.6-sol\/medium\s+gpt-5\.6-sol\/medium/);
  assert.match(list, /BALANCE\s+Default\s+gpt-5\.6-terra\/high\s+gpt-5\.6-terra\/xhigh\s+gpt-5\.6-terra\/max/);
  assert.match(list, /local router does not switch target models by effort/);

  const output = execFileSync(command, ['balance'], { env, encoding: 'utf8' });
  assert.match(output, /active mode -> BALANCE/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), 'BALANCE\n');

  const invalid = spawnSync(command, ['PERF'], { env, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /unknown mode: PERF/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), 'BALANCE\n');
});
