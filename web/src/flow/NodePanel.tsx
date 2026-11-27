/**
 * The side panel of the flow editor that edits the selected node: "Run now" inputs, a trigger's
 * settings, or a block's settings. The forms come from the field descriptions the server sends
 * (`GET /api/meta`), so new block types need no change here.
 */
import { useState, type CSSProperties } from 'react';
import type { BlockType, FieldSpec, RunInput, StepConfig, TriggerConfig } from '../api.ts';
import { FieldInput } from '../components/FieldInput.tsx';
import { RunInputsEditor } from '../components/RunInputsEditor.tsx';
import { NodeIcon, nodeStyle } from './node-style.tsx';

/** `if` setting shared by all blocks. Rendered like any other field, but stored on the block instead of under `with`. */
const RUN_ONLY_IF: FieldSpec = {
  key: 'if',
  label: 'Run only if',
  type: 'expression',
  placeholder: 'Always runs',
  help: "Optional. The block is skipped when this is false, e.g. steps.tests.output.passed or trigger.task.priority == 'urgent'. Use previous.output for the block above.",
};

/** `pauseBefore` setting shared by all blocks, stored on the block like `if`. */
const PAUSE_BEFORE: FieldSpec = {
  key: 'pauseBefore',
  label: 'Pause before this block runs',
  type: 'boolean',
  help: 'The run waits for you before it starts this block. On a "Run Claude" block you can change the prompt there.',
};

/** Keeps ids usable in expressions such as `steps.<id>.output`. */
export const cleanId = (id: string) => id.replace(/[^\w-]/g, '_');

function PanelHeader({ type, title, subtitle, onClose }: { type: string; title: string; subtitle: string; onClose: () => void }) {
  return (
    <header className="flow-panel-header">
      <span className="flow-node-icon" style={{ '--node-color': nodeStyle(type).color } as CSSProperties}>
        <NodeIcon type={type} />
      </span>
      <span className="flow-panel-title">
        <strong>{title}</strong>
        <span className="muted">{subtitle}</span>
      </span>
      <button className="ghost icon-button" onClick={onClose} aria-label="Close" title="Close (Esc)">
        ✕
      </button>
    </header>
  );
}

export function ManualPanel({ inputs, onChange, onClose }: { inputs: RunInput[]; onChange: (inputs: RunInput[]) => void; onClose: () => void }) {
  return (
    <>
      <PanelHeader type="manual" title="Run now" subtitle="Manual run" onClose={onClose} />
      <div className="flow-panel-body">
        <RunInputsEditor inputs={inputs} onChange={onChange} />
      </div>
    </>
  );
}

interface TriggerPanelProps {
  trigger: TriggerConfig;
  type?: BlockType;
  /** The URL that starts this trigger, when it is called from outside and the workflow is saved. */
  url?: string;
  needsSave: boolean;
  secretNames: string[];
  onChange: (settings: Record<string, unknown>) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function TriggerPanel({ trigger, type, url, needsSave, secretNames, onChange, onRemove, onClose }: TriggerPanelProps) {
  const [copied, setCopied] = useState(false);
  const copy = () => url && navigator.clipboard?.writeText(url).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)));
  return (
    <>
      <PanelHeader type={trigger.type} title={type?.title ?? `Unknown trigger type "${trigger.type}"`} subtitle={`Trigger · ${trigger.id}`} onClose={onClose} />
      <div className="flow-panel-body">
        {type && <p className="muted">{type.description}</p>}
        {url && (
          <div className="field">
            <span>URL of this trigger</span>
            <div className="copy-field">
              <code>{url}</code>
              <button className="ghost" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}
        {needsSave && <p className="muted">Save the workflow to see the URL of this trigger.</p>}
        {type?.fields.map((field) => (
          <FieldInput key={field.key} field={field} value={trigger.with[field.key]} secretNames={secretNames} earlierSteps={[]} onChange={(value) => onChange({ ...trigger.with, [field.key]: value })} />
        ))}
      </div>
      <footer className="flow-panel-footer">
        <button className="danger" onClick={onRemove}>
          Remove trigger
        </button>
      </footer>
    </>
  );
}

interface StepPanelProps {
  step: StepConfig;
  index: number;
  steps: StepConfig[];
  type?: BlockType;
  secretNames: string[];
  onChange: (changes: Partial<StepConfig>) => void;
  onIdChange: (id: string) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function StepPanel({ step, index, steps, type, secretNames, onChange, onIdChange, onMove, onRemove, onClose }: StepPanelProps) {
  const others = steps.filter((other) => other !== step).map((other) => ({ id: other.id, label: other.name || other.id }));
  const earlier = steps.slice(0, index).map((other) => ({ id: other.id, label: other.name || other.id }));
  return (
    <>
      <PanelHeader type={step.type} title={step.name || type?.title || step.type} subtitle={`Block ${index + 1} of ${steps.length} · ${type?.title ?? `unknown type "${step.type}"`}`} onClose={onClose} />
      <div className="flow-panel-body">
        {type ? <p className="muted">{type.description}</p> : <p className="error">The server does not know the block type "{step.type}". Its settings are kept as they are.</p>}
        <div className="field-pair">
          <label className="field">
            <span>Name</span>
            <input value={step.name ?? ''} onChange={(event) => onChange({ name: event.target.value })} />
          </label>
          <label className="field">
            <span>Id</span>
            <input className="mono" value={step.id} spellCheck={false} onChange={(event) => onIdChange(cleanId(event.target.value))} />
          </label>
        </div>
        <p className="hint field-hint">
          Other blocks read this block's result as <code>{`{{steps.${step.id}.output}}`}</code>
        </p>
        <FieldInput field={RUN_ONLY_IF} value={step.if} secretNames={secretNames} earlierSteps={[]} onChange={(value) => onChange({ if: value ? String(value) : undefined })} />
        <FieldInput field={PAUSE_BEFORE} value={step.pauseBefore} secretNames={secretNames} earlierSteps={[]} onChange={(value) => onChange({ pauseBefore: value === true || undefined })} />
        {type?.fields.map((field) => (
          <FieldInput
            key={field.key}
            field={field}
            value={step.with[field.key]}
            secretNames={secretNames}
            earlierSteps={earlier}
            otherSteps={others}
            onChange={(value) => onChange({ with: { ...step.with, [field.key]: value } })}
          />
        ))}
      </div>
      <footer className="flow-panel-footer">
        <button onClick={() => onMove(index - 1)} disabled={index === 0} title="Run this block one place earlier">
          ← Earlier
        </button>
        <button onClick={() => onMove(index + 1)} disabled={index === steps.length - 1} title="Run this block one place later">
          Later →
        </button>
        <span className="grow" />
        <button className="danger" onClick={onRemove}>
          Remove block
        </button>
      </footer>
    </>
  );
}
