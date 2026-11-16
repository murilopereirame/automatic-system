/**
 * The block editor: "Run now" and the triggers on top, then the blocks in the order they
 * run. Any trigger starts a run. Blocks can be added between any two blocks,
 * reordered by dragging or with the arrow buttons, and expanded to edit their
 * settings.
 *
 * Conditions show on the block itself: a block with "Run only if" carries its
 * expression in the header, and a condition block shows where each outcome
 * continues.
 */
import { useState } from 'react';
import type { BlockType, FieldSpec, Meta, RunInput, StepConfig, TriggerConfig } from '../api.ts';
import { FieldInput } from './FieldInput.tsx';
import { RunInputsBlock } from './RunInputsBlock.tsx';

interface Props {
  meta: Meta;
  triggers: TriggerConfig[];
  /** What "Run now" asks for. */
  inputs: RunInput[];
  steps: StepConfig[];
  secretNames: string[];
  /** What webhook URLs are built from. Missing until the workflow has been saved once. */
  hooks?: { workflowId: string; secret: string };
  onTriggersChange: (triggers: TriggerConfig[]) => void;
  onInputsChange: (inputs: RunInput[]) => void;
  onStepsChange: (steps: StepConfig[]) => void;
}

/** Settings a new block starts with: the defaults declared by its type. */
function defaultSettings(type: BlockType): Record<string, unknown> {
  const withDefaults = type.fields.filter((field) => field.default !== undefined).map((field) => [field.key, field.default]);
  return Object.fromEntries(withDefaults);
}

function uniqueId(type: string, existing: { id: string }[]): string {
  const taken = new Set(existing.map((item) => item.id));
  if (!taken.has(type)) return type;
  for (let counter = 2; ; counter += 1) {
    if (!taken.has(`${type}_${counter}`)) return `${type}_${counter}`;
  }
}

/** Only triggers that are called from outside have a URL. Every trigger has its own, ending in its id. */
function hookUrl(trigger: TriggerConfig, hooks: NonNullable<Props['hooks']>): string | undefined {
  const url = `${window.location.origin}/hooks/${hooks.workflowId}/${trigger.id}`;
  if (trigger.type === 'webhook') return `${url}?secret=${hooks.secret}`;
  if (trigger.type === 'clickup' && trigger.with.mode === 'webhook') return url;
  return undefined;
}

/** `if` setting shared by all blocks. Rendered like any other field, but stored on the block instead of under `with`. */
const RUN_ONLY_IF: FieldSpec = {
  key: 'if',
  label: 'Run only if',
  type: 'expression',
  placeholder: 'Always runs',
  help: "Optional. The block is skipped when this is false, e.g. steps.tests.output.passed or trigger.task.priority == 'urgent'. Use previous.output for the block above.",
};

/** `openId` of the "Run now" block. The colon keeps it apart from block ids, like the prefix of triggers. */
const RUN_NOW_KEY = 'run-now:';

/** Where a condition block continues for one outcome, in words. */
function targetLabel(target: unknown, steps: StepConfig[]): string {
  if (!target) return 'next block';
  if (target === '$end') return 'finish the run';
  const step = steps.find((candidate) => candidate.id === target);
  return step?.name || String(target);
}

export function BlockPipeline({ meta, triggers, inputs, steps, secretNames, hooks, onTriggersChange, onInputsChange, onStepsChange }: Props) {
  const [openId, setOpenId] = useState<string>();
  const [draggedIndex, setDraggedIndex] = useState<number>();

  // Triggers and blocks share `openId`, so trigger ids get a prefix to keep them apart from block ids.
  const triggerKey = (trigger: TriggerConfig) => `trigger:${trigger.id}`;
  const addTrigger = (type: BlockType) => {
    const trigger: TriggerConfig = { id: uniqueId(type.type, triggers), type: type.type, with: defaultSettings(type) };
    onTriggersChange([...triggers, trigger]);
    setOpenId(triggerKey(trigger));
  };
  const updateTrigger = (index: number, settings: Record<string, unknown>) => onTriggersChange(triggers.map((trigger, at) => (at === index ? { ...trigger, with: settings } : trigger)));
  const removeTrigger = (index: number) => onTriggersChange(triggers.filter((_, at) => at !== index));

  const insert = (index: number, type: BlockType) => {
    const step: StepConfig = { id: uniqueId(type.type, steps), type: type.type, name: type.title, with: defaultSettings(type) };
    onStepsChange([...steps.slice(0, index), step, ...steps.slice(index)]);
    setOpenId(step.id);
  };
  const update = (index: number, changes: Partial<StepConfig>) => onStepsChange(steps.map((step, at) => (at === index ? { ...step, ...changes } : step)));
  const remove = (index: number) => onStepsChange(steps.filter((_, at) => at !== index));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length || from === to) return;
    const reordered = [...steps];
    reordered.splice(to, 0, ...reordered.splice(from, 1));
    onStepsChange(reordered);
  };

  return (
    <div className="pipeline">
      <RunInputsBlock inputs={inputs} open={openId === RUN_NOW_KEY} onToggle={() => setOpenId(openId === RUN_NOW_KEY ? undefined : RUN_NOW_KEY)} onChange={onInputsChange} />
      {triggers.map((trigger, index) => {
        const type = meta.triggerTypes.find((candidate) => candidate.type === trigger.type);
        const url = hooks && hookUrl(trigger, hooks);
        const open = openId === triggerKey(trigger);
        return (
          <section key={trigger.id} className={`block trigger-block${open ? ' open' : ''}`}>
            <header onClick={() => setOpenId(open ? undefined : triggerKey(trigger))}>
              <span className="block-kind">Or trigger</span>
              <span className="block-title">
                <strong>{type?.title ?? `Unknown trigger type "${trigger.type}"`}</strong>
                <span className="muted">
                  <code>{trigger.id}</code>
                </span>
              </span>
              <button className="ghost danger" onClick={(event) => (event.stopPropagation(), removeTrigger(index))}>
                Remove
              </button>
            </header>
            {url && (
              <p className="muted">
                URL of this trigger: <code>{url}</code>
              </p>
            )}
            {!hooks && trigger.type === 'webhook' && <p className="muted">Save the workflow to see the URL of this trigger.</p>}
            {open && (
              <div className="block-fields">
                <p className="muted">{type?.description}</p>
                {type?.fields.map((field) => (
                  <FieldInput
                    key={field.key}
                    field={field}
                    value={trigger.with[field.key]}
                    secretNames={secretNames}
                    earlierSteps={[]}
                    onChange={(value) => updateTrigger(index, { ...trigger.with, [field.key]: value })}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
      <AddBlock types={meta.triggerTypes} onAdd={addTrigger} label="+ Add trigger" />

      <AddBlock types={meta.stepTypes} onAdd={(type) => insert(0, type)} />

      {steps.map((step, index) => {
        const type = meta.stepTypes.find((candidate) => candidate.type === step.type);
        const open = openId === step.id;
        return (
          <div key={step.id}>
            <section
              className={`block block-${step.type}${open ? ' open' : ''}${draggedIndex === index ? ' dragging' : ''}`}
              draggable={!open}
              onDragStart={() => setDraggedIndex(index)}
              onDragEnd={() => setDraggedIndex(undefined)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => draggedIndex !== undefined && move(draggedIndex, index)}
            >
              <header onClick={() => setOpenId(open ? undefined : step.id)}>
                <span className="block-number">{index + 1}</span>
                <span className="block-title">
                  <strong>{step.name || type?.title || step.type}</strong>
                  <span className="muted">
                    {type?.title ?? `Unknown block type "${step.type}"`} · <code>{step.id}</code>
                  </span>
                  {step.if && (
                    <span className="block-condition-note">
                      only if <code>{step.if}</code>
                    </span>
                  )}
                  {step.type === 'condition' && (
                    <span className="block-condition-note">
                      if <code>{String(step.with.expression ?? '')}</code> → {targetLabel(step.with.then, steps)}, else → {targetLabel(step.with.else, steps)}
                    </span>
                  )}
                </span>
                <span className="block-actions" onClick={(event) => event.stopPropagation()}>
                  <button className="ghost" onClick={() => move(index, index - 1)} disabled={index === 0} title="Move up">
                    ↑
                  </button>
                  <button className="ghost" onClick={() => move(index, index + 1)} disabled={index === steps.length - 1} title="Move down">
                    ↓
                  </button>
                  <button className="ghost danger" onClick={() => remove(index)}>
                    Remove
                  </button>
                </span>
              </header>

              {open && type && (
                <div className="block-fields">
                  <p className="muted">{type.description}</p>
                  <div className="field-pair">
                    <label className="field">
                      <span>Name</span>
                      <input value={step.name ?? ''} onChange={(event) => update(index, { name: event.target.value })} />
                    </label>
                    <label className="field">
                      <span>Id</span>
                      <input value={step.id} onChange={(event) => (update(index, { id: event.target.value.replace(/[^\w-]/g, '_') }), setOpenId(event.target.value.replace(/[^\w-]/g, '_')))} />
                      <small>
                        Other blocks read this block's result as <code>{`{{steps.${step.id}.output}}`}</code>
                      </small>
                    </label>
                  </div>
                  <FieldInput field={RUN_ONLY_IF} value={step.if} secretNames={secretNames} earlierSteps={[]} onChange={(value) => update(index, { if: value ? String(value) : undefined })} />
                  {type.fields.map((field) => (
                    <FieldInput
                      key={field.key}
                      field={field}
                      value={step.with[field.key]}
                      secretNames={secretNames}
                      earlierSteps={steps.slice(0, index).map((earlier) => ({ id: earlier.id, label: earlier.name || earlier.id }))}
                      otherSteps={steps.filter((other) => other !== step).map((other) => ({ id: other.id, label: other.name || other.id }))}
                      onChange={(value) => update(index, { with: { ...step.with, [field.key]: value } })}
                    />
                  ))}
                </div>
              )}
            </section>
            <AddBlock types={meta.stepTypes} onAdd={(chosen) => insert(index + 1, chosen)} />
          </div>
        );
      })}
    </div>
  );
}

/** The connector between two blocks, with a menu to insert a new block there. With a `label` it adds a trigger instead. */
function AddBlock({ types, onAdd, label }: { types: BlockType[]; onAdd: (type: BlockType) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="connector">
      <button className={label ? 'add-block add-trigger' : 'add-block'} onClick={() => setOpen(!open)} title={label ? undefined : 'Add a block here'}>
        {label ?? '+'}
      </button>
      {open && (
        <div className="palette">
          {types.map((type) => (
            <button key={type.type} onClick={() => (onAdd(type), setOpen(false))}>
              <strong>{type.title}</strong>
              <span className="muted">{type.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
