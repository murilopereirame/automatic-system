/** One run: its blocks with their state, the live event log, pending approvals and the web shell. */
import { useEffect, useRef, useState } from 'react';
import { api, type Run, type RunDetail, type RunStatus, type StepConfig } from '../api.ts';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import { ErrorNote, PageHeader, StatusBadge, TimeAgo } from '../components/common.tsx';
import { EventLog } from '../components/EventLog.tsx';
import { Terminal } from '../components/Terminal.tsx';
import { useLive } from '../live.ts';
import { triggerSummary } from './RunsPage.tsx';

type StepState = 'done' | 'skipped' | 'pending' | RunStatus;

/** Blocks before the current one are done or were skipped by a condition, the current one mirrors the run, later ones are pending. */
function stepState(run: Run, index: number): StepState {
  if (run.status !== 'succeeded' && index >= run.stepIndex) return index === run.stepIndex ? run.status : 'pending';
  return run.context.steps[run.definition.steps[index].id]?.skipped ? 'skipped' : 'done';
}

/** What a finished condition block decided, e.g. "False → Report". Shown instead of "Done". */
function conditionOutcome(run: Run, step: StepConfig): string | undefined {
  const output = run.context.steps[step.id]?.output as { result?: boolean; goTo?: string | null } | null | undefined;
  if (step.type !== 'condition' || typeof output?.result !== 'boolean') return undefined;
  const target = output.goTo === '$end' ? 'end of run' : run.definition.steps.find((candidate) => candidate.id === output.goTo)?.name || output.goTo;
  return `${output.result ? 'True' : 'False'}${target ? ` → ${target}` : ''}`;
}

const STATE_LABEL: Record<StepState, string> = {
  done: 'Done',
  skipped: 'Skipped',
  pending: 'Pending',
  queued: 'Queued',
  running: 'Running',
  waiting: 'Needs you',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
};

export function RunPage({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<RunDetail>();
  const [error, setError] = useState<string>();
  const [selectedStep, setSelectedStep] = useState<string>();
  const [shellOpen, setShellOpen] = useState(false);
  const [follow, setFollow] = useState(true);
  const logEnd = useRef<HTMLDivElement>(null);

  const reload = () => api.run(runId).then(setDetail, (reason: Error) => setError(reason.message));
  useEffect(() => void reload(), [runId]);

  useLive({
    onRun: (run) => run.id === runId && reload(),
    onEvent: (event) => {
      if (event.runId !== runId) return;
      setDetail((current) => (current && !current.events.some((known) => known.id === event.id) ? { ...current, events: [...current.events, event] } : current));
    },
  });

  // Keep the newest log entry in view while the run is active.
  const eventCount = detail?.events.length ?? 0;
  useEffect(() => {
    if (follow && detail?.run.status === 'running') logEnd.current?.scrollIntoView({ block: 'end' });
  }, [eventCount]);

  if (!detail) return <ErrorNote message={error} />;
  const { run, events, approvals } = detail;
  const act = (action: Promise<unknown>) => action.then(reload, (reason: Error) => setError(reason.message));
  const pending = approvals.filter((approval) => approval.status === 'pending');
  const shownEvents = selectedStep ? events.filter((event) => event.stepId === selectedStep) : events;
  const active = run.status === 'running' || run.status === 'queued' || run.status === 'waiting';
  const stepOf = (stepId: string): StepConfig | undefined => run.definition.steps.find((step) => step.id === stepId);

  return (
    <>
      <PageHeader
        title={
          <>
            {run.workflowName} <StatusBadge status={run.status} />
          </>
        }
      >
        <button onClick={() => setShellOpen(!shellOpen)}>{shellOpen ? 'Close shell' : 'Open shell'}</button>
        {active && (
          <button className="danger" onClick={() => act(api.cancelRun(run.id))}>
            Cancel run
          </button>
        )}
        {(run.status === 'failed' || run.status === 'cancelled') && (
          <button className="primary" onClick={() => act(api.retryRun(run.id))}>
            Retry from failed block
          </button>
        )}
      </PageHeader>
      <p className="muted">
        {triggerSummary(run.context)} · started <TimeAgo time={run.createdAt} />
        {run.context.repo && ` · ${run.context.repo.owner}/${run.context.repo.name} on ${run.context.repo.branch}`}
      </p>
      <ErrorNote message={error ?? (run.status === 'failed' ? run.error : undefined)} />

      {pending.map((approval) => {
        const step = stepOf(approval.stepId);
        const goBack = step && stepOf(String(step.with.onReject ?? ''));
        return (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            title={step?.name || 'Your approval is needed'}
            rejectHint={goBack ? `Rejecting sends the run back to "${goBack.name || goBack.id}".` : 'Rejecting stops the run.'}
            onResolved={reload}
          />
        );
      })}

      {shellOpen && (
        <section className="card shell-card">
          <p className="muted">
            Shell in <code>{run.context.workdir ?? run.workspace}</code>, as the same user and with the same environment as Claude.
          </p>
          <Terminal runId={run.id} />
        </section>
      )}

      <div className="run-layout">
        <aside className="card steps">
          <button className={selectedStep ? 'step' : 'step selected'} onClick={() => setSelectedStep(undefined)}>
            <span className="step-name">All activity</span>
          </button>
          {run.definition.steps.map((step, index) => {
            const state = stepState(run, index);
            return (
              <button key={step.id} className={`step step-${state}${selectedStep === step.id ? ' selected' : ''}`} onClick={() => setSelectedStep(step.id)}>
                <span className="step-dot" />
                <span className="step-name">{step.name || step.id}</span>
                <span className="step-state">{(state === 'done' && conditionOutcome(run, step)) || STATE_LABEL[state]}</span>
              </button>
            );
          })}
        </aside>

        <section className="card log">
          <header>
            <h2>{selectedStep ? stepOf(selectedStep)?.name || selectedStep : 'Activity'}</h2>
            <label className="field checkbox inline">
              <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
              <span>Follow</span>
            </label>
          </header>
          {shownEvents.length === 0 ? <p className="empty">Nothing has happened here yet.</p> : <EventLog events={shownEvents} />}
          <div ref={logEnd} />
        </section>
      </div>
    </>
  );
}
