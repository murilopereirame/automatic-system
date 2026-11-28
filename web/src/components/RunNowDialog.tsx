/**
 * "Run now". A workflow without inputs starts right away. A workflow with
 * inputs first shows a form; the answers are serialised as the JSON trigger
 * payload of the run, which the dialog shows before it is sent.
 */
import { useState, type FormEvent } from 'react';
import { CodeBlock } from './CodeBlock.tsx';
import { api, type FieldSpec, type RunInput, type Workflow } from '../api.ts';
import { navigate } from '../router.ts';
import { ErrorNote } from './common.tsx';
import { FieldInput } from './FieldInput.tsx';

type Values = Record<string, unknown>;

/** JSON inputs are edited as text; everything else keeps the type of its form field. */
function initialValues(inputs: RunInput[]): Values {
  const entries = inputs.map((input) => {
    if (input.type === 'boolean') return [input.name, input.default === true];
    if (input.type === 'select') return [input.name, input.default ?? (input.required ? input.options?.[0] : '') ?? ''];
    if (input.type === 'json' && input.default !== undefined) return [input.name, JSON.stringify(input.default, null, 2)];
    return [input.name, input.default ?? ''];
  });
  return Object.fromEntries(entries);
}

/** Describes an input the way FieldInput expects, so the form looks like the block settings. */
function toField(input: RunInput): FieldSpec {
  const label = `${input.label || input.name}${input.required ? ' *' : ''}`;
  const type = input.type === 'json' ? 'textarea' : input.type;
  const options = input.type === 'select' && !input.required ? ['', ...(input.options ?? [])] : input.options;
  return { key: input.name, label, type, options, help: input.help, placeholder: input.type === 'json' ? '{"key": "value"}' : undefined };
}

/** Builds the trigger payload: every answered input at the place its name points to. Throws when a JSON input does not parse. */
function buildPayload(inputs: RunInput[], values: Values): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const input of inputs) {
    let value = values[input.name];
    if (value === '' || value === undefined) continue;
    if (input.type === 'json') {
      try {
        value = JSON.parse(String(value));
      } catch {
        throw new Error(`"${input.label || input.name}" is not valid JSON`);
      }
    }
    const path = input.name.split('.');
    const last = path.pop()!;
    let target = payload;
    for (const segment of path) target = (target[segment] ??= {}) as Record<string, unknown>;
    target[last] = value;
  }
  return payload;
}

interface DialogProps {
  workflow: Workflow;
  onClose: () => void;
}

function RunNowDialog({ workflow, onClose }: DialogProps) {
  const inputs = workflow.definition.inputs ?? [];
  const [values, setValues] = useState(() => initialValues(inputs));
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);

  let payload: Record<string, unknown> | undefined;
  let payloadError: string | undefined;
  try {
    payload = buildPayload(inputs, values);
  } catch (reason) {
    payloadError = (reason as Error).message;
  }

  const start = (event: FormEvent) => {
    event.preventDefault();
    if (!payload) return setError(payloadError);
    setStarting(true);
    api.runWorkflow(workflow.id, payload).then(
      (run) => navigate(`/runs/${run.id}`),
      (reason: Error) => (setError(reason.message), setStarting(false)),
    );
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal card" role="dialog" aria-label={`Run ${workflow.name}`} onClick={(event) => event.stopPropagation()} onSubmit={start}>
        <h2>Run "{workflow.name}"</h2>
        <div className="stack">
          {inputs.map((input) => (
            <FieldInput key={input.name} field={toField(input)} value={values[input.name]} secretNames={[]} earlierSteps={[]} onChange={(value) => setValues({ ...values, [input.name]: value })} />
          ))}
        </div>
        <details className="payload-preview">
          <summary>Trigger payload</summary>
          {payload ? <CodeBlock language="json" code={JSON.stringify(payload, null, 2)} /> : <pre>{payloadError}</pre>}
        </details>
        <ErrorNote message={error} />
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={starting}>
            Run
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * What a page needs for its "Run now" buttons: `runNow` starts the workflow
 * or opens the form, and `dialog` has to be rendered somewhere on the page.
 */
export function useRunNow(onError: (reason: Error) => void) {
  const [asking, setAsking] = useState<Workflow>();
  const runNow = (workflow: Workflow) => {
    if ((workflow.definition.inputs ?? []).length > 0) return setAsking(workflow);
    api.runWorkflow(workflow.id).then((run) => navigate(`/runs/${run.id}`), onError);
  };
  const dialog = asking && <RunNowDialog workflow={asking} onClose={() => setAsking(undefined)} />;
  return { runNow, dialog };
}
