/** One run: its blocks with their state, the live event log, pending approvals and the web shell. */
import { useEffect, useRef, useState } from 'react';
import { api, type Run, type RunDetail, type RunStatus, type StepConfig } from '../api.ts';
import { ApplyLatestCard } from '../components/ApplyLatestCard.tsx';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import { ErrorNote, PageHeader, StatusBadge, TimeAgo } from '../components/common.tsx';
import { EventLog } from '../components/EventLog.tsx';
import { Terminal } from '../components/Terminal.tsx';
import { useLive } from '../live.ts';
import { useRunLog } from '../use-run-log.ts';
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

/**
 * Wraps a reload so that bursts of calls cause at most one request in flight and one after it.
 * Each block start and finish updates the run, and refetching it for every one is wasted work.
 */
function useCoalescedReload(load: () => Promise<unknown>): () => void {
  const state = useRef({ busy: false, again: false });
  const latest = useRef(load);
  latest.current = load;
  const run = () => {
    if (state.current.busy) {
      state.current.again = true;
      return;
    }
    state.current.busy = true;
    void latest.current().finally(() => {
      state.current.busy = false;
      if (!state.current.again) return;
      state.current.again = false;
      run();
    });
  };
  return run;
}

export function RunPage({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<RunDetail>();
  const [error, setError] = useState<string>();
  const [selectedStep, setSelectedStep] = useState<string>();
  const [shellOpen, setShellOpen] = useState(false);
  const [follow, setFollow] = useState(true);
  const logEnd = useRef<HTMLDivElement>(null);

  const reload = useCoalescedReload(() => api.run(runId).then(setDetail, (reason: Error) => setError(reason.message)));
  useEffect(() => void reload(), [runId]);
  useLive({ onRun: (run) => run.id === runId && reload() });

  // The log loads on its own, page by page, and only for the selected block.
  const { log, loading, error: logError, loadOlder } = useRunLog(runId, selectedStep);

  // Keep the newest log entry in view while the run is active. Live events arrive in batches, so this runs a few times a second at most.
  useEffect(() => {
    if (follow && detail?.run.status === 'running') logEnd.current?.scrollIntoView({ block: 'end' });
  }, [log.events]);

  if (!detail) return <ErrorNote message={error} />;
  const { run, approvals, outdated } = detail;
  const act = (action: Promise<unknown>) => action.then(reload, (reason: Error) => setError(reason.message));
  const pending = approvals.filter((approval) => approval.status === 'pending');
  const active = run.status === 'running' || run.status === 'queued' || run.status === 'waiting';
  const currentStep: StepConfig | undefined = run.definition.steps[run.stepIndex];
  const canSkip = currentStep && ['running', 'waiting', 'failed', 'cancelled'].includes(run.status);
  const skip = () => {
    const name = currentStep?.name || currentStep?.id;
    const stops = run.status === 'running' ? ' What it is doing right now is stopped.' : '';
    if (window.confirm(`Skip "${name}" and continue with the next block?${stops} Later blocks will see it as skipped, without an output.`)) act(api.skipStep(run.id));
  };
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
        {canSkip && (
          <button onClick={skip} title="Pass over this block and continue with the next one">
            Skip "{currentStep.name || currentStep.id}"
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
      {outdated && <ApplyLatestCard run={run} onApplied={reload} />}

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
          <ErrorNote message={logError} />
          {log.hasOlder && (
            <div className="log-older">
              <button onClick={loadOlder}>Load older activity</button>
            </div>
          )}
          {log.events.length === 0 ? <p className="empty">{loading ? 'Loading…' : 'Nothing has happened here yet.'}</p> : <EventLog events={log.events} />}
          <div ref={logEnd} />
        </section>
      </div>
    </>
  );
}
