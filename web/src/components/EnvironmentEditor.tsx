/** Editor for everything a workflow needs around it. All of it ends up in the formula. */
import { useState } from 'react';
import type { Environment } from '../api.ts';
import { ListEditor } from './ListEditor.tsx';

interface Props {
  environment: Environment;
  secretNames: string[];
  /** Which declared mount targets exist in the container, when known. */
  mountStatus?: { target: string; present: boolean }[];
  onChange: (environment: Environment) => void;
}

export function EnvironmentEditor({ environment, secretNames, mountStatus, onChange }: Props) {
  const set = (changes: Partial<Environment>) => onChange({ ...environment, ...changes });
  const envRows = Object.entries(environment.env).map(([name, value]) => ({ name, value }));
  const allSecrets = [...new Set([...secretNames, ...environment.secrets])].sort();

  const toggleSecret = (name: string, exposed: boolean) =>
    set({ secrets: exposed ? [...environment.secrets, name] : environment.secrets.filter((secret) => secret !== name) });

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
          Checked secrets become environment variables for Claude, commands and the web shell. Leave tokens that only blocks need (for example GITHUB_TOKEN for the pull request block) unchecked, so Claude cannot use them. The formula
          stores names only.
        </p>
        {allSecrets.length === 0 && <p className="empty">No secrets stored yet. Add them under Settings.</p>}
        <div className="checks">
          {allSecrets.map((name) => (
            <label key={name} className="field checkbox">
              <input type="checkbox" checked={environment.secrets.includes(name)} onChange={(event) => toggleSecret(name, event.target.checked)} />
              <code>{name}</code>
              {!secretNames.includes(name) && <small className="warning">no value stored</small>}
            </label>
          ))}
        </div>
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
        <h2>MCP servers</h2>
        <p className="muted">
          The <code>mcpServers</code> object of a Claude Code .mcp.json file. Refer to variables and exposed secrets as <code>{'${NAME}'}</code>.
        </p>
        <JsonEditor value={environment.mcpServers} onChange={(mcpServers) => set({ mcpServers })} />
      </section>

      <section className="card">
        <h2>Volume mounts</h2>
        <p className="muted">Mounts this workflow expects. They are created when the container starts, so add them to your compose file; this list travels with the formula and shows which targets are missing.</p>
        <ListEditor items={environment.mounts} onChange={(mounts) => set({ mounts })} blank={() => ({ source: '', target: '', readOnly: false })} addLabel="Add mount">
          {(mount, update) => {
            const status = mountStatus?.find((entry) => entry.target === mount.target);
            return (
              <>
                <input placeholder="./host/path or volume" value={mount.source} onChange={(event) => update({ source: event.target.value })} />
                <input placeholder="/container/path" value={mount.target} onChange={(event) => update({ target: event.target.value })} />
                <label className="field checkbox inline">
                  <input type="checkbox" checked={mount.readOnly === true} onChange={(event) => update({ readOnly: event.target.checked })} />
                  <span>read only</span>
                </label>
                {status && <span className={status.present ? 'status status-succeeded' : 'status status-failed'}>{status.present ? 'Mounted' : 'Missing'}</span>}
              </>
            );
          }}
        </ListEditor>
        {environment.mounts.length > 0 && (
          <pre className="code">
            {`# docker-compose.override.yml\nservices:\n  autoworker:\n    volumes:\n${environment.mounts
              .map((mount) => `      - ${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`)
              .join('\n')}`}
          </pre>
        )}
      </section>
    </div>
  );
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
      <textarea className="mono" rows={Math.max(4, text.split('\n').length)} value={text} onChange={(event) => edit(event.target.value)} spellCheck={false} />
      {error && <p className="error">{error}</p>}
    </>
  );
}
