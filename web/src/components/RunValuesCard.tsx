/**
 * Values a person adds to a run while it is open, such as the URL of a
 * staging deploy. Blocks that start afterwards read them as `{{vars.<name>}}`.
 * The rules are in server/src/run-values.ts.
 */
import { useState, type FormEvent } from 'react';
import { api, type Run } from '../api.ts';
import { listValues } from '../../../server/src/run-values.ts';
import { ErrorNote } from './common.tsx';

const OPEN = new Set<Run['status']>(['queued', 'running', 'waiting', 'failed', 'cancelled']);

/** How a value is shown in the list and put back into the form: text as it is, anything else as JSON. */
const asText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

export function RunValuesCard({ run, onChanged }: { run: Run; onChanged: () => void }) {
  const values = listValues(run.context.vars);
  const open = OPEN.has(run.status) && !run.cleanedAt;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [isJson, setIsJson] = useState(false);
  const [error, setError] = useState<string>();

  if (!open && values.length === 0) return null;

  const fail = (reason: Error) => setError(reason.message);
  const startEdit = (existing?: [string, unknown]) => {
    setEditing(true);
    setError(undefined);
    setName(existing?.[0] ?? '');
    setValue(existing ? asText(existing[1]) : '');
    setIsJson(existing ? typeof existing[1] !== 'string' : false);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    let parsed: unknown = value;
    if (isJson) {
      try {
        parsed = JSON.parse(value);
      } catch {
        return setError('This is not valid JSON. Untick "Read as JSON" to add it as text.');
      }
    }
    api.setRunValue(run.id, name.trim(), parsed).then(() => (setEditing(false), setError(undefined), onChanged()), fail);
  };
  const remove = (valueName: string) => api.removeRunValue(run.id, valueName).then(onChanged, fail);

  const when =
    run.status === 'running'
      ? 'The block running now already has its settings, so the value is used from the next block on.'
      : run.status === 'failed' || run.status === 'cancelled'
        ? 'The value is used when you retry or skip.'
        : 'Blocks that have not started yet use it.';

  return (
    <section className="card run-values">
      <header>
        <strong>{open ? 'Values for upcoming blocks' : 'Values added to this run'}</strong>
        {open && !editing && <button onClick={() => startEdit()}>Add value</button>}
      </header>
      {values.length > 0 ? (
        <div className="table-scroll">
        <table className="run-values-list">
          <tbody>
            {values.map(([valueName, current]) => (
              <tr key={valueName}>
                <td>
                  <code>{`{{vars.${valueName}}}`}</code>
                </td>
                <td className="run-value">{asText(current)}</td>
                {open && (
                  <td className="actions">
                    <button onClick={() => startEdit([valueName, current])}>Edit</button>
                    <button className="danger" onClick={() => remove(valueName)}>
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : (
        !editing && (
          <p className="muted">
            Add a value here, like the URL of a staging deploy, and the blocks after this point read it as <code>{'{{vars.<name>}}'}</code>.
          </p>
        )
      )}
      {editing && (
        <form onSubmit={save}>
          <label className="field">
            <span>Name</span>
            <input required autoFocus placeholder="staging.url" value={name} onChange={(event) => setName(event.target.value)} />
            <small>
              Letters, digits and "_". Dots nest: <code>staging.url</code> is <code>{'{{vars.staging.url}}'}</code>.
            </small>
          </label>
          <label className="field">
            <span>Value</span>
            <textarea rows={3} value={value} onChange={(event) => setValue(event.target.value)} />
          </label>
          <label className="field checkbox">
            <input type="checkbox" checked={isJson} onChange={(event) => setIsJson(event.target.checked)} />
            <span>Read as JSON</span>
            <small>For numbers, true/false, lists and objects.</small>
          </label>
          <ErrorNote message={error} />
          <div className="actions">
            <button className="primary" type="submit">
              Save value
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <span className="muted">{when}</span>
          </div>
        </form>
      )}
      {!editing && <ErrorNote message={error} />}
    </section>
  );
}
