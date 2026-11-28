/**
 * One run: pending approvals, a summary with a progress bar, the blocks as a timeline next to their
 * activity, values for upcoming blocks, the web shell and the output files. Layout in docs/RUN_VIEW.md.
 */
import { useEffect, useRef, useState } from 'react';
import { api, type RunDetail, type StepConfig } from '../api.ts';
import { ApplyLatestCard } from '../components/ApplyLatestCard.tsx';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import { ErrorNote, LoadingOrError, PageHeader, StatusBadge } from '../components/common.tsx';
import { OutputFiles } from '../run-view/OutputFiles.tsx';
import { RunPromptCard } from '../components/RunPromptCard.tsx';
import { RunValuesCard } from '../components/RunValuesCard.tsx';
import { Terminal } from '../components/Terminal.tsx';
import { useLive } from '../live.ts';
import { useRunLog } from '../use-run-log.ts';
import { ActivityLog } from '../run-view/ActivityLog.tsx';
import { RunSummary } from '../run-view/RunSummary.tsx';
import { stepState } from '../run-view/run-steps.ts';
import { StepDetails } from '../run-view/StepDetails.tsx';
import { StepTimeline } from '../run-view/StepTimeline.tsx';
import { useNow } from '../run-view/use-now.ts';
import { triggerSummary } from './RunsPage.tsx';

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
  const open = detail ? ['running', 'waiting', 'queued'].includes(detail.run.status) : false;
  // Durations of running blocks count up while the run is open.
  const now = useNow(open);

  const reload = useCoalescedReload(() => api.run(runId).then(setDetail, (reason: Error) => setError(reason.message)));
  useEffect(() => void reload(), [runId]);
  useLive({ onRun: (run) => run.id === runId && reload() });

  // The log loads on its own, page by page, and only for the selected block.
  const { log, loading, error: logError, loadOlder } = useRunLog(runId, selectedStep);

  // Keep the newest log entry in view while the run is active. Live events arrive in batches, so this runs a few times a second at most.
  useEffect(() => {
    if (follow && detail?.run.status === 'running') logEnd.current?.scrollIntoView({ block: 'end' });
  }, [log.events]);

  if (!detail) return <LoadingOrError error={error} />;
  const { run, approvals, outdated } = detail;
  const act = (action: Promise<unknown>) => action.then(reload, (reason: Error) => setError(reason.message));
  const pending = approvals.filter((approval) => approval.status === 'pending');
  const active = open;
  const currentStep: StepConfig | undefined = run.definition.steps[run.stepIndex];
  const cleaned = run.cleanedAt !== undefined;
  const canSkip = currentStep && !cleaned && ['running', 'waiting', 'failed', 'cancelled'].includes(run.status);
  const canCleanUp = !active && !cleaned;
  const cleanUp = () => {
    const note = run.status === 'succeeded' ? '' : ' The run cannot be retried afterwards.';
    if (window.confirm(`Delete the files of this run: the workspace with its clones and Claude's conversation?${note} The run and its log stay.`)) act(api.cleanUpRun(run.id));
  };
  const skip = () => {
    const name = currentStep?.name || currentStep?.id;
    const stops = run.status === 'running' ? ' What it is doing right now is stopped.' : '';
    if (window.confirm(`Skip "${name}" and continue with the next block?${stops} Later blocks will see it as skipped, without an output.`)) act(api.skipStep(run.id));
  };
  const stepOf = (stepId: string): StepConfig | undefined => run.definition.steps.find((step) => step.id === stepId);
  const selectedIndex = selectedStep ? run.definition.steps.findIndex((step) => step.id === selectedStep) : -1;
  const selected = run.definition.steps[selectedIndex];
  const triggerText = triggerSummary(run.context);
  const followToggle = (
    <label className="field checkbox inline" title="Keep the newest activity in view while the run is going">
      <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
      <span>Follow</span>
    </label>
  );

  return (
    <>
      <PageHeader
        title={
          <>
            {run.workflowName} <StatusBadge status={run.status} />
          </>
        }
      >
        {!cleaned && <button onClick={() => setShellOpen(!shellOpen)}>{shellOpen ? 'Close shell' : 'Open shell'}</button>}
        {canCleanUp && (
          <button onClick={cleanUp} title="Delete the workspace and Claude's conversation files of this run">
            Clean up files
          </button>
        )}
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
        {(run.status === 'failed' || run.status === 'cancelled') && !cleaned && (
          <button className="primary" onClick={() => act(api.retryRun(run.id))}>
            Retry from failed block
          </button>
        )}
      </PageHeader>
      <ErrorNote message={error ?? (run.status === 'failed' ? run.error : undefined)} />
      {outdated && !cleaned && <ApplyLatestCard run={run} onApplied={reload} />}

      {pending.map((approval) => {
        const step = stepOf(approval.stepId);
        const goBack = step && stepOf(String(step.with.onReject ?? ''));
        return (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            title={approval.kind === 'before_step' ? `Before "${step?.name || approval.stepId}"` : step?.name || 'Your approval is needed'}
            rejectHint={goBack ? `Rejecting sends the run back to "${goBack.name || goBack.id}".` : 'Rejecting stops the run.'}
            onResolved={reload}
          />
        );
      })}

      <RunSummary run={run} triggerText={triggerText} selected={selectedStep} onSelect={setSelectedStep} now={now} />

      <RunValuesCard run={run} onChanged={reload} />

      {shellOpen && !cleaned && (
        <section className="card shell-card">
          <p className="muted">
            Shell in <code>{run.context.workdir ?? run.workspace}</code>, as the same user and with the same environment as Claude. Copy files you want to download to <code>$AUTOWORKER_OUTPUT_DIR</code>.
          </p>
          <Terminal runId={run.id} />
        </section>
      )}

      <div className="run-layout">
        <StepTimeline run={run} pending={pending} selected={selectedStep} onSelect={setSelectedStep} now={now} triggerText={triggerText} />

        <section className="card log">
          {selected ? (
            <>
              <StepDetails run={run} step={selected} state={stepState(run, selectedIndex)} now={now} />
              <div className="log-toolbar">
                <button className="ghost" onClick={() => setSelectedStep(undefined)}>
                  ← All activity
                </button>
                {followToggle}
              </div>
            </>
          ) : (
            <header className="log-header">
              <h2>Activity</h2>
              {followToggle}
            </header>
          )}
          {selected?.type === 'claude' && run.status !== 'succeeded' && <RunPromptCard run={run} step={selected} onSaved={reload} />}
          <ErrorNote message={logError} />
          {log.hasOlder && (
            <div className="log-older">
              <button onClick={loadOlder}>Load older activity</button>
            </div>
          )}
          {log.events.length === 0 ? (
            <p className="empty">{loading ? 'Loading…' : 'Nothing has happened here yet.'}</p>
          ) : (
            <ActivityLog run={run} events={log.events} now={now} single={selected !== undefined} onSelect={setSelectedStep} />
          )}
          <div ref={logEnd} />
        </section>
      </div>

      <OutputFiles run={run} />
    </>
  );
}
