/**
 * The block editor: the trigger on top, then the blocks in the order they
 * run. Blocks can be added between any two blocks, reordered by dragging or
 * with the arrow buttons, and expanded to edit their settings.
 */
import { useState } from 'react';
import type { BlockType, Meta, StepConfig, TriggerConfig } from '../api.ts';
import { FieldInput } from './FieldInput.tsx';

interface Props {
  meta: Meta;
  trigger: TriggerConfig;
  steps: StepConfig[];
  secretNames: string[];
  onTriggerChange: (trigger: TriggerConfig) => void;
  onStepsChange: (steps: StepConfig[]) => void;
}

/** Settings a new block starts with: the defaults declared by its type. */
function defaultSettings(type: BlockType): Record<string, unknown> {
  const withDefaults = type.fields.filter((field) => field.default !== undefined).map((field) => [field.key, field.default]);
  return Object.fromEntries(withDefaults);
}

function uniqueId(type: string, steps: StepConfig[]): string {
  const taken = new Set(steps.map((step) => step.id));
  if (!taken.has(type)) return type;
  for (let counter = 2; ; counter += 1) {
    if (!taken.has(`${type}_${counter}`)) return `${type}_${counter}`;
  }
}

export function BlockPipeline({ meta, trigger, steps, secretNames, onTriggerChange, onStepsChange }: Props) {
  const [openId, setOpenId] = useState<string>();
  const [draggedIndex, setDraggedIndex] = useState<number>();
  const triggerType = meta.triggerTypes.find((candidate) => candidate.type === trigger.type);

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
      <section className="block trigger-block">
        <header>
          <span className="block-kind">Trigger</span>
          <select value={trigger.type} onChange={(event) => onTriggerChange({ type: event.target.value, with: {} })}>
            {meta.triggerTypes.map((type) => (
              <option key={type.type} value={type.type}>
                {type.title}
              </option>
            ))}
          </select>
        </header>
        <p className="muted">{triggerType?.description}</p>
        <div className="block-fields">
          {triggerType?.fields.map((field) => (
            <FieldInput
              key={field.key}
              field={field}
              value={trigger.with[field.key]}
              secretNames={secretNames}
              earlierSteps={[]}
              onChange={(value) => onTriggerChange({ ...trigger, with: { ...trigger.with, [field.key]: value } })}
            />
          ))}
        </div>
      </section>

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
                  {type.fields.map((field) => (
                    <FieldInput
                      key={field.key}
                      field={field}
                      value={step.with[field.key]}
                      secretNames={secretNames}
                      earlierSteps={steps.slice(0, index).map((earlier) => ({ id: earlier.id, label: earlier.name || earlier.id }))}
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

/** The connector between two blocks, with a menu to insert a new block there. */
function AddBlock({ types, onAdd }: { types: BlockType[]; onAdd: (type: BlockType) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="connector">
      <button className="add-block" onClick={() => setOpen(!open)} title="Add a block here">
        +
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
