import { useRef, useState, type ChangeEvent } from 'react';
import { api } from '../api.ts';
import { Empty, ErrorNote, PageHeader } from '../components/common.tsx';
import { useLoad } from '../hooks.ts';
import { navigate } from '../router.ts';

export function WorkflowsPage() {
  const workflows = useLoad(api.workflows);
  const meta = useLoad(api.meta);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const workflow = await api.importFormula(await file.text());
      navigate(`/workflows/${workflow.id}`);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const run = (id: string) => api.runWorkflow(id).then((started) => navigate(`/runs/${started.id}`), (reason: Error) => setError(reason.message));
  const triggerTitle = (type: string) => meta.data?.triggerTypes.find((trigger) => trigger.type === type)?.title ?? type;

  return (
    <>
      <PageHeader title="Workflows">
        <input ref={fileInput} type="file" accept=".yaml,.yml" hidden onChange={importFile} />
        <button onClick={() => fileInput.current?.click()}>Import formula</button>
        <button className="primary" onClick={() => navigate('/workflows/new')}>
          New workflow
        </button>
      </PageHeader>
      <ErrorNote message={error ?? workflows.error} />

      {workflows.data?.length === 0 && (
        <Empty>No workflows yet. Create one, or import a formula such as examples/clickup-to-pr.formula.yaml from the repository.</Empty>
      )}

      <div className="card-list">
        {workflows.data?.map((workflow) => (
          <div className="card row" key={workflow.id}>
            <a className="row-main" href={`#/workflows/${workflow.id}`}>
              <strong>{workflow.name}</strong>
              <span className="muted">{workflow.description}</span>
              <span className="meta">
                <span className={workflow.enabled ? 'status status-succeeded' : 'status status-cancelled'}>{workflow.enabled ? 'Enabled' : 'Disabled'}</span>
                <span>{workflow.definition.triggers.length === 0 ? 'Manual only' : `Triggers: ${workflow.definition.triggers.map((trigger) => triggerTitle(trigger.type)).join(', ')}`}</span>
                <span>{workflow.definition.steps.length} blocks</span>
              </span>
            </a>
            <div className="actions">
              <button onClick={() => run(workflow.id)}>Run now</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
