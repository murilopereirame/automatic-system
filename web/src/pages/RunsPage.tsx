import { api } from '../api.ts';
import { Empty, ErrorNote, PageHeader, StatusBadge, TimeAgo } from '../components/common.tsx';
import { useLoad } from '../hooks.ts';
import { useLive } from '../live.ts';

export function RunsPage() {
  const runs = useLoad(() => api.runs());
  useLive({ onRun: runs.reload });

  return (
    <>
      <PageHeader title="Runs" />
      <ErrorNote message={runs.error} />
      {runs.data?.length === 0 && <Empty>No runs yet. They appear here when a trigger fires or you press "Run now".</Empty>}
      <div className="card-list">
        {runs.data?.map((run) => {
          const step = run.definition.steps[run.stepIndex];
          return (
            <a className="card row" key={run.id} href={`#/runs/${run.id}`}>
              <span className="row-main">
                <strong>{run.workflowName}</strong>
                <span className="muted">{triggerSummary(run.context.trigger)}</span>
                <span className="meta">
                  <StatusBadge status={run.status} />
                  {step && run.status !== 'succeeded' && (
                    <span>
                      Block {run.stepIndex + 1} of {run.definition.steps.length}: {step.name || step.id}
                    </span>
                  )}
                  <TimeAgo time={run.createdAt} />
                </span>
              </span>
            </a>
          );
        })}
      </div>
    </>
  );
}

/** One line describing what started a run. */
export function triggerSummary(trigger: Record<string, unknown>): string {
  const task = trigger.task as { name?: string } | undefined;
  if (task?.name) return `Task: ${task.name}`;
  if (trigger.source === 'manual') return 'Started manually';
  return 'Started by webhook';
}
