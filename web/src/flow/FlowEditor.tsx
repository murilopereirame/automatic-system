/**
 * The workflow editor's "Blocks" tab: the workflow as a flow of nodes on a canvas, with a side panel
 * for the selected node. "Run now" and the triggers start the flow on the left, then the blocks in
 * the order they run, then the end. See docs/FLOW_EDITOR.md.
 *
 * This file owns the editing (add, change, move, remove, and where nodes were dragged to);
 * FlowCanvas draws and handles the pointer,
 * graph.ts decides where everything goes, NodePanel and NodePicker are the side panels.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { BlockType, FlowLayout, Meta, NodePosition, RunInput, StepConfig, TriggerConfig, WorkflowDefinition } from '../api.ts';
import { describeInputs } from '../components/RunInputsEditor.tsx';
import { FlowCanvas } from './FlowCanvas.tsx';
import { buildGraph, type GraphNode } from './graph.ts';
import { NodeIcon, nodeStyle } from './node-style.tsx';
import { ManualPanel, StepPanel, TriggerPanel } from './NodePanel.tsx';
import { NodePicker } from './NodePicker.tsx';

interface Props {
  meta: Meta;
  triggers: TriggerConfig[];
  /** What "Run now" asks for. */
  inputs: RunInput[];
  steps: StepConfig[];
  secretNames: string[];
  /** What webhook URLs are built from. Missing until the workflow has been saved once. */
  hooks?: { workflowId: string; secret: string };
  /** Where nodes were dragged to. Missing when every node is laid out automatically. */
  layout?: FlowLayout;
  /** One call per edit, with every part of the definition it changed (e.g. `steps` and `layout`). */
  onChange: (changes: Partial<WorkflowDefinition>) => void;
}

/** The layout holding `positions`, or none when no node has one left. */
const layoutOf = (positions: Record<string, NodePosition>): FlowLayout | undefined => (Object.keys(positions).length ? { positions } : undefined);

/** `positions` without `key`, and with `position` under `renamed` instead when given. */
function movePosition(positions: Record<string, NodePosition>, key: string, renamed?: string): Record<string, NodePosition> {
  const { [key]: position, ...rest } = positions;
  return renamed && position ? { ...rest, [renamed]: position } : rest;
}

/** What the "add" panel is adding: a block at a position, or a trigger. */
type Adding = { kind: 'step'; index: number } | { kind: 'trigger' };

/** Settings a new block starts with: the defaults declared by its type. */
function defaultSettings(type: BlockType): Record<string, unknown> {
  const withDefaults = type.fields.filter((field) => field.default !== undefined).map((field) => [field.key, field.default]);
  return Object.fromEntries(withDefaults);
}

export function uniqueId(type: string, existing: { id: string }[]): string {
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

/** Points every condition and approval that leads to `from` at `to` instead, after a block id changed. */
function renameTargets(steps: StepConfig[], from: string, to: string): StepConfig[] {
  return steps.map((step) => {
    const changed = Object.fromEntries(['then', 'else', 'onReject'].filter((key) => step.with[key] === from).map((key) => [key, to]));
    return Object.keys(changed).length ? { ...step, with: { ...step.with, ...changed } } : step;
  });
}

export function FlowEditor({ meta, triggers, inputs, steps, secretNames, hooks, layout, onChange }: Props) {
  const [selectedKey, setSelectedKey] = useState<string>();
  const [adding, setAdding] = useState<Adding>();
  /** The node being dragged and where it is right now. Saved to the layout only when it is let go. */
  const [dragging, setDragging] = useState<{ key: string; position: NodePosition }>();
  const positions = layout?.positions ?? {};
  const graph = useMemo(() => buildGraph(triggers, steps, dragging ? { ...positions, [dragging.key]: dragging.position } : positions), [triggers, steps, layout, dragging]);
  const onTriggersChange = (next: TriggerConfig[]) => onChange({ triggers: next });
  const onInputsChange = (next: RunInput[]) => onChange({ inputs: next });
  const onStepsChange = (next: StepConfig[]) => onChange({ steps: next });

  const close = () => (setSelectedKey(undefined), setAdding(undefined));
  const stepType = (type: string) => meta.stepTypes.find((candidate) => candidate.type === type);
  const triggerType = (type: string) => meta.triggerTypes.find((candidate) => candidate.type === type);

  const insertStep = (index: number, type: BlockType) => {
    const step: StepConfig = { id: uniqueId(type.type, steps), type: type.type, name: type.title, with: defaultSettings(type) };
    onStepsChange([...steps.slice(0, index), step, ...steps.slice(index)]);
    setAdding(undefined);
    setSelectedKey(`step:${step.id}`);
  };
  const addTrigger = (type: BlockType) => {
    const trigger: TriggerConfig = { id: uniqueId(type.type, triggers), type: type.type, with: defaultSettings(type) };
    onTriggersChange([...triggers, trigger]);
    setAdding(undefined);
    setSelectedKey(`trigger:${trigger.id}`);
  };
  const updateStep = (index: number, changes: Partial<StepConfig>) => onStepsChange(steps.map((step, at) => (at === index ? { ...step, ...changes } : step)));
  const renameStep = (index: number, id: string) => {
    const renamed = steps.map((step, at) => (at === index ? { ...step, id } : step));
    // The block keeps its place on the canvas under its new id.
    onChange({ steps: renameTargets(renamed, steps[index].id, id), layout: layoutOf(movePosition(positions, `step:${steps[index].id}`, `step:${id}`)) });
    setSelectedKey(`step:${id}`);
  };
  const removeStep = (index: number) => {
    onChange({ steps: steps.filter((_, at) => at !== index), layout: layoutOf(movePosition(positions, `step:${steps[index].id}`)) });
    if (selectedKey === `step:${steps[index].id}`) setSelectedKey(undefined);
  };
  const moveStep = (from: number, to: number) => {
    if (to < 0 || to >= steps.length || from === to) return;
    const reordered = [...steps];
    reordered.splice(to, 0, ...reordered.splice(from, 1));
    onStepsChange(reordered);
  };
  const removeTrigger = (index: number) => {
    onChange({ triggers: triggers.filter((_, at) => at !== index), layout: layoutOf(movePosition(positions, `trigger:${triggers[index].id}`)) });
    setSelectedKey(undefined);
  };
  const dropNode = (key: string, position: NodePosition) => {
    onChange({ layout: { positions: { ...positions, [key]: position } } });
    setDragging(undefined);
  };
  /** Forgets every dragged position: all nodes go back to the automatic layout. */
  const tidyUp = () => onChange({ layout: undefined });

  const select = (key: string | undefined) => {
    // The end and the empty placeholder are where new blocks go: clicking them adds one.
    if (key === 'end' || key === 'placeholder') return (setSelectedKey(undefined), setAdding({ kind: 'step', index: steps.length }));
    setAdding(undefined);
    setSelectedKey(key);
  };

  // Escape closes the panel; Delete removes the selected block, unless the person is typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement).closest('input, textarea, select, [contenteditable]');
      if (event.key === 'Escape') close();
      if ((event.key === 'Delete' || event.key === 'Backspace') && !typing && selectedKey?.startsWith('step:')) {
        const index = steps.findIndex((step) => `step:${step.id}` === selectedKey);
        if (index !== -1) (event.preventDefault(), removeStep(index));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const renderNode = (node: GraphNode) => {
    if (node.kind === 'end')
      return (
        <span className="flow-end" title="End of the run. Click to add a block here.">
          End
        </span>
      );
    if (node.kind === 'placeholder') return <span className="flow-placeholder">+ Add the first block</span>;
    if (node.kind === 'manual') return <NodeCard type="manual" title="Run now" subtitle={describeInputs(inputs)} />;
    if (node.kind === 'trigger') {
      const trigger = triggers[node.index!];
      return <NodeCard type={trigger.type} title={triggerType(trigger.type)?.title ?? trigger.type} subtitle={`Trigger · ${trigger.id}`} onRemove={() => removeTrigger(node.index!)} />;
    }
    const step = steps[node.index!];
    const notes = [step.if && `only if ${step.if}`, step.pauseBefore && 'pauses for you', step.type === 'condition' && `if ${String(step.with.expression ?? '')}`].filter(Boolean) as string[];
    return (
      <NodeCard
        type={step.type}
        number={node.index! + 1}
        title={step.name || stepType(step.type)?.title || step.type}
        subtitle={stepType(step.type)?.title ?? `Unknown type "${step.type}"`}
        notes={notes}
        onRemove={() => removeStep(node.index!)}
      />
    );
  };

  const panel = (() => {
    if (adding?.kind === 'trigger') return <NodePicker types={meta.triggerTypes} title="Add a trigger" onPick={addTrigger} onClose={close} />;
    if (adding?.kind === 'step') {
      const after = steps[adding.index - 1];
      const title = after ? `Add a block after "${after.name || after.id}"` : 'Add the first block';
      return <NodePicker key={adding.index} types={meta.stepTypes} title={title} onPick={(type) => insertStep(adding.index, type)} onClose={close} />;
    }
    if (selectedKey === 'manual') return <ManualPanel inputs={inputs} onChange={onInputsChange} onClose={close} />;
    const triggerIndex = triggers.findIndex((trigger) => `trigger:${trigger.id}` === selectedKey);
    if (triggerIndex !== -1) {
      const trigger = triggers[triggerIndex];
      return (
        <TriggerPanel
          key={selectedKey}
          trigger={trigger}
          type={triggerType(trigger.type)}
          url={hooks && hookUrl(trigger, hooks)}
          needsSave={!hooks && trigger.type === 'webhook'}
          secretNames={secretNames}
          onChange={(settings) => onTriggersChange(triggers.map((candidate, at) => (at === triggerIndex ? { ...candidate, with: settings } : candidate)))}
          onRemove={() => removeTrigger(triggerIndex)}
          onClose={close}
        />
      );
    }
    const stepIndex = steps.findIndex((step) => `step:${step.id}` === selectedKey);
    if (stepIndex !== -1) {
      const step = steps[stepIndex];
      return (
        <StepPanel
          step={step}
          index={stepIndex}
          steps={steps}
          type={stepType(step.type)}
          secretNames={secretNames}
          onChange={(changes) => updateStep(stepIndex, changes)}
          onIdChange={(id) => renameStep(stepIndex, id)}
          onMove={(to) => moveStep(stepIndex, to)}
          onRemove={() => removeStep(stepIndex)}
          onClose={close}
        />
      );
    }
    return undefined;
  })();

  const toolbar = (
    <>
      <button className="primary" onClick={() => (setSelectedKey(undefined), setAdding({ kind: 'step', index: steps.length }))}>
        + Block
      </button>
      <button onClick={() => (setSelectedKey(undefined), setAdding({ kind: 'trigger' }))}>+ Trigger</button>
      {layout && (
        <button onClick={tidyUp} title="Put every node back in its automatic place, in the order the blocks run">
          Tidy up
        </button>
      )}
    </>
  );

  return (
    <FlowCanvas
      graph={graph}
      selectedKey={selectedKey ?? (adding?.kind === 'step' && adding.index === steps.length ? (steps.length ? 'end' : 'placeholder') : undefined)}
      renderNode={renderNode}
      onSelect={select}
      onInsert={(index) => (setSelectedKey(undefined), setAdding({ kind: 'step', index }))}
      onNodeDrag={(key, position) => setDragging({ key, position })}
      onNodeDrop={dropNode}
      toolbar={toolbar}
      panel={panel}
    />
  );
}

interface NodeCardProps {
  type: string;
  title: string;
  subtitle: string;
  /** Position in the run, for blocks. */
  number?: number;
  /** Short notes under the title: conditions, pauses. */
  notes?: string[];
  onRemove?: () => void;
}

/** The face of a node: coloured icon, title and type, notes, and a remove button on hover. */
function NodeCard({ type, title, subtitle, number, notes = [], onRemove }: NodeCardProps) {
  return (
    <div className="flow-card" style={{ '--node-color': nodeStyle(type).color } as CSSProperties} title={[title, ...notes].join('\n')}>
      <span className="flow-node-icon">
        <NodeIcon type={type} />
      </span>
      <span className="flow-card-text">
        <strong>
          {number !== undefined && <span className="flow-card-number">{number}</span>}
          {title}
        </strong>
        <span className="flow-card-subtitle">{subtitle}</span>
        {notes.map((note) => (
          <span key={note} className="flow-card-note">
            {note}
          </span>
        ))}
      </span>
      {onRemove && (
        <button className="flow-card-remove" onClick={(event) => (event.stopPropagation(), onRemove())} title="Remove" aria-label={`Remove ${title}`}>
          ✕
        </button>
      )}
    </div>
  );
}
