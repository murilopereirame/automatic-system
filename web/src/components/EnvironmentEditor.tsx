/** Editor for everything a workflow needs around it. All of it ends up in the formula. */
import { useState } from 'react';
import type { Environment, Requirements, ServiceSpec } from '../api.ts';
import { ListEditor } from './ListEditor.tsx';
import { MultiSelect } from './MultiSelect.tsx';
import { CodeBlock } from './CodeBlock.tsx';
import { CodeEditor } from './CodeEditor.tsx';

interface Props {
  environment: Environment;
  secretNames: string[];
  /** Which declared mounts and services exist in the deployment, when known. */
  requirements?: Requirements;
  /** Whether the deployment restricts outbound connections to the allow list. */
  egressEnforced?: boolean;
  onChange: (environment: Environment) => void;
}

export function EnvironmentEditor({ environment, secretNames, requirements, egressEnforced, onChange }: Props) {
  const set = (changes: Partial<Environment>) => onChange({ ...environment, ...changes });
  const envRows = Object.entries(environment.env).map(([name, value]) => ({ name, value }));
  const allSecrets = [...new Set([...secretNames, ...environment.secrets])].sort();

  return (
    <div className="sections">
      <section className="card">
        <h2>Runtimes</h2>
        <p className="muted">Language runtimes and tools, installed with mise before the first block runs. For example node 22, python 3.12, go latest.</p>
        <ListEditor items={environment.runtimes} onChange={(runtimes) => set({ runtimes })} blank={() => ({ name: '', version: 'latest' })} addLabel="Add runtime">
          {(runtime, update) => (
            <>
              <input placeholder="node" value={runtime.name} onChange={(event) => update({ name: event.target.value })} />
              <input placeholder="22" value={runtime.version} onChange={(event) => update({ version: event.target.value })} />
            </>
          )}
        </ListEditor>
      </section>

      <section className="card">
        <h2>Environment variables</h2>
        <p className="muted">Visible to Claude, commands and the web shell. Values are stored in the formula, so use secrets for anything sensitive.</p>
        <ListEditor
          items={envRows}
          onChange={(rows) => set({ env: Object.fromEntries(rows.map((row) => [row.name, row.value])) })}
          blank={() => ({ name: '', value: '' })}
          addLabel="Add variable"
        >
          {(row, update) => (
            <>
              <input placeholder="NAME" value={row.name} onChange={(event) => update({ name: event.target.value })} />
              <input placeholder="value" value={row.value} onChange={(event) => update({ value: event.target.value })} />
            </>
          )}
        </ListEditor>
      </section>

      <section className="card">
        <h2>Secrets exposed to Claude</h2>
        <p className="muted">
          Picked secrets become environment variables for Claude, commands and the web shell. Leave tokens that only blocks need (for example GITHUB_TOKEN for the pull request block) out, so Claude cannot use them. The formula
          stores names only.
        </p>
        <MultiSelect
          label="Secrets exposed to Claude"
          options={allSecrets.map((name) => ({ value: name, note: !secretNames.includes(name) && <small className="warning">no value stored</small> }))}
          selected={environment.secrets}
          onChange={(secrets) => set({ secrets })}
          placeholder="Search secrets to expose…"
          emptyText="No secrets stored yet. Add them under Settings."
        />
      </section>

      <section className="card">
        <h2>Claude memory</h2>
        <p className="muted">Files in the workflow's Claude config directory. CLAUDE.md holds standing instructions. An exported formula contains these files as they are on disk, including what Claude added.</p>
        <ListEditor items={environment.memory} onChange={(memory) => set({ memory })} blank={() => ({ path: environment.memory.length ? '' : 'CLAUDE.md', content: '' })} addLabel="Add memory file">
          {(file, update) => (
            <div className="stack">
              <input placeholder="CLAUDE.md" value={file.path} onChange={(event) => update({ path: event.target.value })} />
              <textarea rows={6} value={file.content} onChange={(event) => update({ content: event.target.value })} />
            </div>
          )}
        </ListEditor>
      </section>

      <section className="card">
        <h2>Skills</h2>
        <p className="muted">
          Claude Code skills for this workflow: reusable instructions Claude loads when a task matches the description in the frontmatter. Each skill is stored as <code>skills/&lt;name&gt;/SKILL.md</code>. Skills added on disk are
          included when you export the formula.
        </p>
        <ListEditor
          items={environment.skills}
          onChange={(skills) => set({ skills })}
          blank={() => ({ name: '', content: '---\nname: my-skill\ndescription: When to use this skill\n---\n\nInstructions for Claude.\n' })}
          addLabel="Add skill"
        >
          {(skill, update) => (
            <div className="stack">
              <input placeholder="frontend-prompt" value={skill.name} onChange={(event) => update({ name: event.target.value.replace(/[^\w-]/g, '-') })} />
              <textarea className="mono" rows={7} value={skill.content} onChange={(event) => update({ content: event.target.value })} spellCheck={false} />
            </div>
          )}
        </ListEditor>
      </section>

      <section className="card">
        <h2>MCP servers</h2>
        <p className="muted">
          The <code>mcpServers</code> object of a Claude Code .mcp.json file. Refer to variables and exposed secrets as <code>{'${NAME}'}</code>.
        </p>
        <JsonEditor value={environment.mcpServers} onChange={(mcpServers) => set({ mcpServers })} />
      </section>

      <section className="card">
        <h2>Services</h2>
        <p className="muted">
          Helper containers the workflow needs, such as a database for tests. They run next to the sandbox as their own compose services, so the sandbox never needs access to Docker. Claude and commands reach them by name, for
          example <code>mongo:27017</code>. A run waits for them and fails with a clear message when one is missing. Turn on “Also on localhost” when the project only accepts <code>localhost</code> URLs: the server then forwards{' '}
          <code>localhost:&lt;port&gt;</code> to the service, for runs and the web shell.
        </p>
        <ListEditor items={environment.services} onChange={(services) => set({ services })} blank={(): ServiceSpec => ({ name: '', image: '', ports: [], env: {} })} addLabel="Add service">
          {(service, update) => (
            <div className="stack">
              <div className="list-row">
                <input placeholder="mongo" value={service.name} onChange={(event) => update({ name: event.target.value.toLowerCase() })} />
                <input placeholder="mongo:7" value={service.image} onChange={(event) => update({ image: event.target.value })} />
                <input placeholder="27017" value={service.ports.join(', ')} onChange={(event) => update({ ports: toPorts(event.target.value) })} />
              </div>
              <input
                className="mono"
                placeholder="Environment, e.g. POSTGRES_PASSWORD=test POSTGRES_DB=app"
                defaultValue={Object.entries(service.env).map(([name, value]) => `${name}=${value}`).join(' ')}
                onChange={(event) => update({ env: toEnv(event.target.value) })}
              />
              <label className="field checkbox inline">
                <input type="checkbox" role="switch" checked={service.forwardToLocalhost === true} onChange={(event) => update({ forwardToLocalhost: event.target.checked || undefined })} />
                <span>
                  Also on <code>localhost</code>, for projects that only accept loopback URLs
                </span>
              </label>
              <span className="meta">
                {service.ports.map((port) => {
                  const probe = requirements?.services.find((entry) => entry.name === service.name && entry.port === port);
                  if (!probe) return null;
                  return (
                    <span key={port} className={probe.reachable ? 'status status-succeeded' : 'status status-failed'}>
                      {service.name}:{port} {probe.reachable ? 'reachable' : 'not reachable'}
                    </span>
                  );
                })}
                {service.forwardToLocalhost &&
                  service.ports.map((port) => {
                    const forward = requirements?.forwards?.find((entry) => entry.host === service.name && entry.port === port);
                    if (!forward) return null;
                    return (
                      <span key={`forward-${port}`} className={forward.listening ? 'status status-succeeded' : 'status status-failed'} title={forward.error}>
                        localhost:{forward.localPort} {forward.listening ? 'listening' : `not listening: ${forward.error}`}
                      </span>
                    );
                  })}
              </span>
            </div>
          )}
        </ListEditor>
      </section>

      <section className="card">
        <h2>Network</h2>
        <p className="muted">
          Hosts the sandbox may connect to, one per line. Use <code>*.example.com</code> for a domain with its subdomains, or <code>*</code> for everything. The host and local network are never reachable through a wildcard.
        </p>
        {egressEnforced === false && <p className="hint warning">This deployment runs without the gateway, so outbound connections are not restricted and this list is not enforced.</p>}
        <textarea
          className="mono"
          rows={Math.max(4, environment.network.allow.length + 1)}
          placeholder={'github.com\napi.github.com\nregistry.npmjs.org\nstaging.example.com'}
          defaultValue={environment.network.allow.join('\n')}
          onChange={(event) => set({ network: { allow: event.target.value.split(/[\s,]+/).filter(Boolean) } })}
          spellCheck={false}
        />
      </section>

      <section className="card">
        <h2>Volume mounts</h2>
        <p className="muted">Mounts this workflow expects. They are created when the container starts, so add them to your compose file; this list travels with the formula and shows which targets are missing.</p>
        <ListEditor items={environment.mounts} onChange={(mounts) => set({ mounts })} blank={() => ({ source: '', target: '', readOnly: false })} addLabel="Add mount">
          {(mount, update) => {
            const status = requirements?.mounts.find((entry) => entry.target === mount.target);
            return (
              <>
                <input placeholder="./host/path or volume" value={mount.source} onChange={(event) => update({ source: event.target.value })} />
                <input placeholder="/container/path" value={mount.target} onChange={(event) => update({ target: event.target.value })} />
                <label className="field checkbox inline">
                  <input type="checkbox" role="switch" checked={mount.readOnly === true} onChange={(event) => update({ readOnly: event.target.checked })} />
                  <span>read only</span>
                </label>
                {status && <span className={status.present ? 'status status-succeeded' : 'status status-failed'}>{status.present ? 'Mounted' : 'Missing'}</span>}
              </>
            );
          }}
        </ListEditor>
      </section>

      {(environment.mounts.length > 0 || environment.services.length > 0) && (
        <section className="card">
          <h2>Deployment snippet</h2>
          <p className="muted">
            Services and mounts are created by Docker when the deployment starts. Save this as <code>compose.override.yaml</code> next to <code>compose.yaml</code> and run <code>docker compose up -d</code>.
          </p>
          <CodeBlock className="code" language="yaml" code={composeOverride(environment)} />
        </section>
      )}
    </div>
  );
}

function toPorts(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0);
}

/** Parses `NAME=value OTHER=value` into an object. */
function toEnv(text: string): Record<string, string> {
  const pairs = text
    .split(/\s+/)
    .filter((pair) => pair.includes('='))
    .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]);
  return Object.fromEntries(pairs);
}

/** The compose file that adds this workflow's services and mounts to the deployment. */
function composeOverride(environment: Environment): string {
  const lines = ['services:'];
  if (environment.mounts.length > 0) {
    lines.push('  autoworker:', '    volumes:');
    for (const mount of environment.mounts) lines.push(`      - ${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`);
  }
  for (const service of environment.services) {
    lines.push(`  ${service.name || 'service'}:`, `    image: ${service.image}`, '    restart: unless-stopped', '    networks: [sandbox]');
    if (service.command) lines.push(`    command: ${service.command}`);
    const variables = Object.entries(service.env);
    if (variables.length > 0) lines.push('    environment:', ...variables.map(([name, value]) => `      ${name}: ${JSON.stringify(value)}`));
  }
  return lines.join('\n');
}

/** A textarea for a JSON value that only reports changes when the text is valid JSON. */
export function JsonEditor({ value, onChange }: { value: unknown; onChange: (value: Record<string, unknown>) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string>();

  const edit = (next: string) => {
    setText(next);
    try {
      const parsed = JSON.parse(next || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Expected a JSON object');
      setError(undefined);
      onChange(parsed);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  return (
    <>
      <CodeEditor language="json" rows={Math.max(4, text.split('\n').length)} value={text} onChange={edit} aria-label="MCP servers JSON" />
      {error && <p className="error">{error}</p>}
    </>
  );
}
