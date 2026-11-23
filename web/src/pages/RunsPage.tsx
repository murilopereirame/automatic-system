import { useState } from 'react';
import { api, type RunContext } from '../api.ts';
import { Empty, ErrorNote, PageHeader, StatusBadge, TimeAgo } from '../components/common.tsx';
import { useLoad } from '../hooks.ts';
import { useLive } from '../live.ts';

export function RunsPage() {
  const runs = useLoad(() => api.runs());
  useLive({ onRun: runs.reload });
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const ended = runs.data?.filter((run) => ['succeeded', 'failed', 'cancelled'].includes(run.status) && !run.cleanedAt).length ?? 0;

  const cleanUpAll = () => {
    if (!window.confirm(`Delete the files of every run that has ended (${ended} listed here)? Failed runs cannot be retried afterwards. The runs and their logs stay.`)) return;
    api.cleanUpEndedRuns().then(
      ({ cleaned }) => (setNotice(`Cleaned up ${cleaned} run${cleaned === 1 ? '' : 's'}`), setError(undefined), runs.reload()),
      (reason: Error) => setError(reason.message),
    );
  };

  return (
    <>
      <PageHeader title="Runs">
        {notice && <span className="muted">{notice}</span>}
        {ended > 0 && (
          <button onClick={cleanUpAll} title="Delete the workspaces and Claude conversations of runs that succeeded, failed or were cancelled">
            Clean up ended runs
          </button>
        )}
      </PageHeader>
      <ErrorNote message={error ?? runs.error} />
      {runs.data?.length === 0 && <Empty>No runs yet. They appear here when a trigger fires or you press "Run now".</Empty>}
      <div className="card-list">
        {runs.data?.map((run) => {
          const step = run.definition.steps[run.stepIndex];
          return (
            <a className="card row" key={run.id} href={`#/runs/${run.id}`}>
              <span className="row-main">
                <strong>{run.workflowName}</strong>
                <span className="muted">{triggerSummary(run.context)}</span>
                <span className="meta">
                  <StatusBadge status={run.status} />
                  {step && run.status !== 'succeeded' && (
                    <span>
                      Block {run.stepIndex + 1} of {run.definition.steps.length}: {step.name || step.id}
                    </span>
                  )}
                  <TimeAgo time={run.createdAt} />
                  {run.cleanedAt && <span title="The files of this run were deleted">files cleaned up</span>}
                </span>
              </span>
            </a>
          );
        })}
      </div>
    </>
  );
}

/** One line describing what started a run: the task, when there is one, and which trigger fired. */
export function triggerSummary(context: RunContext): string {
  const task = context.trigger.task as { name?: string } | undefined;
  const by = context.triggeredBy;
  // Runs from before workflows could have several triggers did not record which one fired.
  const manual = by ? by.type === 'manual' : context.trigger.source === 'manual';
  const how = manual ? 'Started manually' : by ? `Started by trigger "${by.id}"` : 'Started by trigger';
  return task?.name ? `Task: ${task.name} · ${how}` : how;
}
