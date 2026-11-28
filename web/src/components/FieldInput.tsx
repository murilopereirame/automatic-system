/**
 * Renders the input for one setting of a block or trigger, based on the
 * field description the server provides. This is what lets new block types
 * appear in the editor without any UI change.
 */
import type { FieldSpec } from '../api.ts';

interface Props {
  field: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Stored secret names, offered for `secret` fields. */
  secretNames: string[];
  /** Blocks that come earlier in the workflow, offered for `step` fields. */
  earlierSteps: { id: string; label: string }[];
  /** All other blocks of the workflow, offered for `target` fields. */
  otherSteps?: { id: string; label: string }[];
}

/** Value of a `target` field that ends the run. The server knows it as END_OF_RUN. */
const END_OF_RUN = '$end';

export function FieldInput({ field, value, onChange, secretNames, earlierSteps, otherSteps = [] }: Props) {
  const current = value ?? field.default ?? '';
  const text = String(current);

  let input;
  switch (field.type) {
    case 'boolean':
      return (
        <label className="field checkbox">
          <input type="checkbox" role="switch" checked={current === true} onChange={(event) => onChange(event.target.checked)} />
          <span>{field.label}</span>
          {field.help && <small>{field.help}</small>}
        </label>
      );
    case 'textarea':
      input = <textarea value={text} placeholder={field.placeholder} rows={Math.min(12, Math.max(3, text.split('\n').length + 1))} onChange={(event) => onChange(event.target.value)} />;
      break;
    case 'number':
      input = <input type="number" value={text} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))} />;
      break;
    case 'select':
      input = (
        <select value={text} onChange={(event) => onChange(event.target.value)}>
          {(field.options ?? []).map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      );
      break;
    case 'step':
      input = (
        <select value={text} onChange={(event) => onChange(event.target.value)}>
          <option value="">Stop the run</option>
          {earlierSteps.map((step) => (
            <option key={step.id} value={step.id}>
              {step.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'target':
      input = (
        <select value={text} onChange={(event) => onChange(event.target.value)}>
          <option value="">The next block</option>
          {otherSteps.map((step) => (
            <option key={step.id} value={step.id}>
              {step.label}
            </option>
          ))}
          <option value={END_OF_RUN}>Finish the run</option>
        </select>
      );
      break;
    case 'expression':
      input = <input className="mono" value={text} placeholder={field.placeholder} spellCheck={false} onChange={(event) => onChange(event.target.value)} />;
      break;
    case 'secret':
      input = (
        <>
          <input value={text} list={`secrets-${field.key}`} onChange={(event) => onChange(event.target.value)} />
          <datalist id={`secrets-${field.key}`}>
            {secretNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {text && !secretNames.includes(text) && <small className="warning">No secret named {text} is stored yet. Add it under Settings.</small>}
        </>
      );
      break;
    default:
      input = <input value={text} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />;
  }

  return (
    <label className="field">
      <span>{field.label}</span>
      {input}
      {field.help && <small>{field.help}</small>}
    </label>
  );
}
