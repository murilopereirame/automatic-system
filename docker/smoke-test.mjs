#!/usr/bin/env node
/**
 * Smoke test for a running Auto Worker container. Used by CI after the image
 * is built, and useful after changing the Dockerfile or compose.yaml.
 *
 *   node docker/smoke-test.mjs http://localhost:8080 <token>
 *
 * It starts a workflow whose command inspects the sandbox from the inside,
 * opens the web shell, and fails if any isolation property does not hold.
 * Set SMOKE_SKIP_TOOLS=1 to skip the checks for the bundled tools, and
 * SMOKE_SKIP_INTERNET=1 where the gateway itself has no internet access.
 */
import WebSocket from 'ws';

const [baseUrl = 'http://localhost:8080', token = process.env.AUTOWORKER_TOKEN] = process.argv.slice(2);
const AGENT_UID = '10001';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const failures = [];

function check(name, passed, detail = '') {
  console.log(`${passed ? 'ok  ' : 'FAIL'}  ${name}${passed ? '' : `\n      ${detail}`}`);
  if (!passed) failures.push(name);
}

async function api(method, path, body) {
  const response = await fetch(`${baseUrl}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`The server at ${baseUrl} did not become healthy`);
}

/** Runs a shell command as a workflow step and returns its output. `allow` is the workflow's network allow list. */
async function runInSandbox(command, allow = []) {
  const definition = {
    trigger: { type: 'manual', with: {} },
    environment: { network: { allow } },
    steps: [{ id: 'probe', type: 'shell', with: { command, continueOnError: true } }],
  };
  const workflow = await api('POST', '/workflows', { name: `smoke-${Date.now()}`, definition });
  const started = await api('POST', `/workflows/${workflow.id}/run`, {});
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const { run } = await api('GET', `/runs/${started.id}`);
    if (run.status === 'succeeded') return run.context.steps.probe.output.output;
    if (run.status === 'failed') throw new Error(`The probe run failed: ${run.error}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('The probe run did not finish');
}

/** Types a command into the web shell and returns what comes back. */
function runInWebShell(command) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/shell`, { headers });
    let output = '';
    socket.on('open', () => socket.send(JSON.stringify({ type: 'input', data: `${command}; exit\r` })));
    socket.on('message', (data) => (output += data.toString()));
    socket.on('close', () => resolve(output));
    socket.on('error', reject);
    setTimeout(() => reject(new Error('The web shell did not answer')), 15000);
  });
}

const PROBE = `
echo "uid=$(id -u)"
echo "groups=$(id -G)"
grep -E '^(CapEff|CapPrm|CapBnd|NoNewPrivs):' /proc/self/status
touch /app/escape 2>/dev/null && echo ROOTFS_WRITABLE
cat /data/autoworker.db >/dev/null 2>&1 && echo DATA_READABLE
ls /data >/dev/null 2>&1 && echo DATA_LISTABLE
[ -e /var/run/docker.sock ] && echo DOCKER_SOCKET_PRESENT
touch "$HOME/.smoke" && echo HOME_WRITABLE
touch /tmp/.smoke && echo TMP_WRITABLE
env | grep -qE 'AUTOWORKER_(TOKEN|SECRET_KEY|GATEWAY_SECRET)' && echo TOKEN_LEAKED
cat /proc/[0-9]*/environ 2>/dev/null | grep -qaE 'AUTOWORKER_(TOKEN|SECRET_KEY|GATEWAY_SECRET)' && echo TOKEN_LEAKED
pwd
`;

const TOOLS = ['git', 'gh', 'node', 'npm', 'claude', 'mise', 'python3', 'jq', 'rg'];

await waitForServer();
check('the API rejects requests without a token', (await fetch(`${baseUrl}/api/workflows`)).status === 401);

const probe = await runInSandbox(PROBE);
const line = (name) => probe.match(new RegExp(`^${name}[=:]\\s*(.*)$`, 'm'))?.[1]?.trim();

check('workflow commands run as the agent user', line('uid') === AGENT_UID, probe);
check('the agent has no extra groups', line('groups') === AGENT_UID, probe);
check('the agent has no capabilities', /^0+$/.test(line('CapEff') ?? '') && /^0+$/.test(line('CapPrm') ?? ''), probe);
check('no-new-privileges is set', line('NoNewPrivs') === '1', probe);
check('the root file system is read-only', !probe.includes('ROOTFS_WRITABLE'), probe);
check('the agent cannot read the server database', !probe.includes('DATA_READABLE') && !probe.includes('DATA_LISTABLE'), probe);
check('no Docker socket is mounted', !probe.includes('DOCKER_SOCKET_PRESENT'), probe);
check('the server secrets are not readable from the agent, directly or through /proc', !probe.includes('TOKEN_LEAKED'), probe);
check('the agent home and /tmp are writable', probe.includes('HOME_WRITABLE') && probe.includes('TMP_WRITABLE'), probe);
check('commands start in the run workspace', /^\/workspaces\//m.test(probe), probe);

const shell = await runInWebShell('echo "shell-uid=$(id -u) shell-groups=$(id -G)"');
check('the web shell runs as the agent user without extra groups', shell.includes(`shell-uid=${AGENT_UID} shell-groups=${AGENT_UID}`), shell);

// ---- Network: the sandbox has no direct route out, and the gateway only lets allowed hosts through ----

/** Node one-liners, so the probes do not depend on curl being installed. */
const directConnect = (host, port) =>
  `node -e "require('net').connect(${port}, '${host}').on('connect', () => { console.log('DIRECT_OK ${host}'); process.exit(); }).on('error', () => process.exit()); setTimeout(() => process.exit(), 4000)"`;
const fetchThroughProxy = (url) => `node -e "fetch('${url}').then((r) => console.log('FETCH_OK ${url} ' + r.status), (e) => console.log('FETCH_FAILED ${url}'))"`;

const ALLOWED = 'api.github.com';
const network = await runInSandbox(
  [
    'sleep 7', // The gateway picks up a changed allow list within a few seconds.
    directConnect('1.1.1.1', 443),
    directConnect('169.254.169.254', 80),
    fetchThroughProxy('https://example.com/'),
    fetchThroughProxy(`https://${ALLOWED}/zen`),
  ].join('\n'),
  [ALLOWED],
);
check('the sandbox cannot connect to the internet directly', !network.includes('DIRECT_OK 1.1.1.1'), network);
check('the sandbox cannot reach a cloud metadata address', !network.includes('DIRECT_OK 169.254.169.254'), network);
check('a host that is not on the allow list is refused by the gateway', network.includes('FETCH_FAILED https://example.com/'), network);
if (!process.env.SMOKE_SKIP_INTERNET) {
  check('a host on the allow list is reachable through the gateway', network.includes(`FETCH_OK https://${ALLOWED}/zen 200`), network);
}

await new Promise((resolve) => setTimeout(resolve, 6000));
const sandbox = await api('GET', '/sandbox');
check('the deployment reports that egress is enforced', sandbox.egressEnforced === true, JSON.stringify(sandbox));
check('the blocked connection shows up in the UI data', sandbox.recentlyBlocked.some((entry) => entry.host === 'example.com'), JSON.stringify(sandbox));

if (!process.env.SMOKE_SKIP_TOOLS) {
  const versions = await runInSandbox(TOOLS.map((tool) => `command -v ${tool} >/dev/null && echo "has-${tool}"`).join('\n'));
  for (const tool of TOOLS) check(`${tool} is installed`, versions.includes(`has-${tool}`), versions);
}

console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
