import './helpers.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { agentExec, baseEnv, SANDBOX_PATH_VARIABLE } from '../src/sandbox/agent.js';

const PROFILE_SCRIPT = path.join(import.meta.dirname, '../../docker/profile.d/autoworker-path.sh');
const MISE_SHIMS = path.join(config.agentHome, '.local/share/mise/shims');

test('the runtimes a formula installs come first on the sandbox PATH', () => {
  const env = baseEnv();
  assert.equal(env.PATH.split(':')[0], MISE_SHIMS);
  assert.equal(env[SANDBOX_PATH_VARIABLE], env.PATH);
});

test('a login shell gets the sandbox PATH back after /etc/profile has reset it', async () => {
  // Stands in for Debian's /etc/profile, which replaces PATH with a fixed list.
  const loginShell = `PATH=/usr/local/bin:/usr/bin:/bin; . "${PROFILE_SCRIPT}"; printf %s "$PATH"`;
  const env = baseEnv();
  const result = await agentExec('/bin/sh', ['-c', loginShell], { env, cwd: '/' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, env.PATH);
});

test('the profile script leaves PATH alone outside the sandbox', async () => {
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin' };
  const result = await agentExec('/bin/sh', ['-c', `. "${PROFILE_SCRIPT}"; printf %s "$PATH"`], { env, cwd: '/' });
  assert.equal(result.stdout, env.PATH);
});
