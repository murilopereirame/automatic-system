/**
 * The "Run now" block at the top of the pipeline: the inputs a manual run
 * asks for. Each input is a place in the trigger payload, so a manual run can
 * hand the blocks the same fields another trigger would.
 */
import type { RunInput, RunInputType } from '../api.ts';
import { ListEditor } from './ListEditor.tsx';

interface Props {
  inputs: RunInput[];
  open: boolean;
  onToggle: () => void;
  onChange: (inputs: RunInput[]) => void;
}

const TYPE_LABELS: Record<RunInputType, string> = {
  text: 'Text',
  textarea: 'Long text',
  number: 'Number',
  boolean: 'Yes / no',
  select: 'Choice',
  json: 'JSON',
};

function uniqueName(inputs: RunInput[]): string {
  const taken = new Set(inputs.map((input) => input.name));
  for (let counter = inputs.length + 1; ; counter += 1) {
    if (!taken.has(`input_${counter}`)) return `input_${counter}`;
  }
}

/** A default is stored with the type of its input, and edited as text. */
const defaultToText = (value: unknown) => (value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value));

function textToDefault(type: RunInputType, text: string): unknown {
  if (text === '') return undefined;
  if (type === 'number') return Number.isNaN(Number(text)) ? text : Number(text);
  if (type === 'boolean') return text === 'true';
  if (type !== 'json') return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function RunInputsBlock({ inputs, open, onToggle, onChange }: Props) {
  return (
    <section className={`block trigger-block${open ? ' open' : ''}`}>
      <header onClick={onToggle}>
        <span className="block-kind">Run now</span>
        <span className="block-title">
          <strong>Manual run</strong>
          <span className="muted">{inputs.length === 0 ? 'Starts right away, without asking for anything' : `Asks for ${inputs.map((input) => input.label || input.name).join(', ')}`}</span>
        </span>
      </header>
      {open && (
        <div className="block-fields">
          <p className="muted">
            "Run now" always works. Add inputs and it asks for them first. The answers are the trigger payload of the run: an input named <code>task.id</code> is read by blocks as <code>{'{{trigger.task.id}}'}</code>, the same way they read what other triggers send.
          </p>
          <ListEditor items={inputs} onChange={onChange} blank={(): RunInput => ({ name: uniqueName(inputs), type: 'text' })} addLabel="Add input">
            {(input, update) => (
              <div className="stack run-input">
                <div className="field-pair">
                  <label className="field">
                    <span>Name</span>
                    <input className="mono" value={input.name} placeholder="task.id" spellCheck={false} onChange={(event) => update({ name: event.target.value.replace(/[^\w.]/g, '_') })} />
                    <small>
                      Read as <code>{`{{trigger.${input.name}}}`}</code>
                    </small>
                  </label>
                  <label className="field">
                    <span>Label</span>
                    <input value={input.label ?? ''} placeholder={input.name} onChange={(event) => update({ label: event.target.value || undefined })} />
                  </label>
                </div>
                <div className="field-pair">
                  <label className="field">
                    <span>Type</span>
                    <select value={input.type} onChange={(event) => update({ type: event.target.value as RunInputType, default: undefined })}>
                      {Object.entries(TYPE_LABELS).map(([type, label]) => (
                        <option key={type} value={type}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Default</span>
                    {input.type === 'boolean' ? (
                      <select value={defaultToText(input.default)} onChange={(event) => update({ default: textToDefault('boolean', event.target.value) })}>
                        <option value="">No</option>
                        <option value="true">Yes</option>
                      </select>
                    ) : (
                      <input value={defaultToText(input.default)} placeholder="None" onChange={(event) => update({ default: textToDefault(input.type, event.target.value) })} />
                    )}
                  </label>
                </div>
                {input.type === 'select' && (
                  <label className="field">
                    <span>Choices, separated by commas</span>
                    <input value={(input.options ?? []).join(', ')} placeholder="staging, production" onChange={(event) => update({ options: event.target.value.split(',').map((option) => option.trimStart()) })} />
                  </label>
                )}
                <label className="field">
                  <span>Help text</span>
                  <input value={input.help ?? ''} onChange={(event) => update({ help: event.target.value || undefined })} />
                </label>
                {input.type !== 'boolean' && (
                  <label className="field checkbox">
                    <input type="checkbox" checked={input.required === true} onChange={(event) => update({ required: event.target.checked || undefined })} />
                    <span>Required</span>
                    <small>The run does not start while this is empty.</small>
                  </label>
                )}
              </div>
            )}
          </ListEditor>
        </div>
      )}
    </section>
  );
}
