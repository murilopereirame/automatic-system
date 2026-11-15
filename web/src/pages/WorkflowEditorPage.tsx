/** Create or edit a workflow: blocks, environment, notifications, and the formula as code. */
import { useEffect, useState } from 'react';
import { api, type Workflow, type WorkflowDraft } from '../api.ts';
import { BlockPipeline } from '../components/BlockPipeline.tsx';
import { CodeView } from '../components/CodeView.tsx';
import { ErrorNote, PageHeader } from '../components/common.tsx';
import { EnvironmentEditor } from '../components/EnvironmentEditor.tsx';
import { NotificationsEditor } from '../components/NotificationsEditor.tsx';
import { useLoad } from '../hooks.ts';
import { navigate } from '../router.ts';

const TABS = ['Blocks', 'Environment', 'Notifications', 'Code'] as const;
type Tab = (typeof TABS)[number];

const NEW_WORKFLOW: WorkflowDraft = {
  name: '',
  description: '',
  enabled: true,
  definition: {
    triggers: [],
    environment: { runtimes: [], mcpServers: {}, memory: [], skills: [], services: [], network: { allow: [] }, env: {}, secrets: [], mounts: [] },
    notifications: [],
    steps: [],
  },
};

function toDraft(workflow: Workflow): WorkflowDraft {
  const { name, description, enabled, definition } = workflow;
  return { name, description, enabled, definition };
}

function download(filename: string, content: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type: 'application/yaml' }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function WorkflowEditorPage({ workflowId }: { workflowId?: string }) {
  const meta = useLoad(api.meta);
  const secrets = useLoad(api.secrets);
  const requirements = useLoad(() => (workflowId ? api.requirements(workflowId) : Promise.resolve(undefined)), workflowId);
  const sandbox = useLoad(api.sandbox);
  const [saved, setSaved] = useState<Workflow>();
  const [draft, setDraft] = useState<WorkflowDraft>(NEW_WORKFLOW);
  const [tab, setTab] = useState<Tab>('Blocks');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    if (!workflowId) return;
    api.workflow(workflowId).then(
      (workflow) => (setSaved(workflow), setDraft(toDraft(workflow))),
      (reason: Error) => setError(reason.message),
    );
  }, [workflowId]);

  const dirty = saved ? JSON.stringify(toDraft(saved)) !== JSON.stringify(draft) : true;
  const setDefinition = (changes: Partial<WorkflowDraft['definition']>) => setDraft({ ...draft, definition: { ...draft.definition, ...changes } });
  const fail = (reason: Error) => (setError(reason.message), setNotice(undefined));

  const save = async (): Promise<Workflow | undefined> => {
    try {
      const workflow = workflowId ? await api.updateWorkflow(workflowId, draft) : await api.createWorkflow(draft);
      setSaved(workflow);
      setDraft(toDraft(workflow));
      setError(undefined);
      setNotice('Saved');
      requirements.reload();
      if (!workflowId) navigate(`/workflows/${workflow.id}`);
      return workflow;
    } catch (reason) {
      fail(reason as Error);
    }
  };

  const runNow = async () => {
    const workflow = dirty ? await save() : saved;
    if (workflow) api.runWorkflow(workflow.id).then((run) => navigate(`/runs/${run.id}`), fail);
  };

  const exportFormula = () => saved && api.exportFormula(saved.id).then((yaml) => download(`${saved.name.replace(/\W+/g, '-').toLowerCase()}.formula.yaml`, yaml), fail);

  const remove = () => {
    if (saved && window.confirm(`Delete the workflow "${saved.name}"? Its runs stay in the history.`)) {
      api.deleteWorkflow(saved.id).then(() => navigate('/workflows'), fail);
    }
  };

  if (!meta.data || (workflowId && !saved)) return <ErrorNote message={error ?? meta.error} />;

  return (
    <>
      <PageHeader title={workflowId ? draft.name || 'Workflow' : 'New workflow'}>
        {notice && !dirty && <span className="muted">{notice}</span>}
        {saved && <button onClick={exportFormula}>Export formula</button>}
        {saved && (
          <button className="danger" onClick={remove}>
            Delete
          </button>
        )}
        <button onClick={runNow} disabled={!draft.name}>
          Run now
        </button>
        <button className="primary" onClick={save} disabled={!dirty || !draft.name}>
          Save
        </button>
      </PageHeader>
      <ErrorNote message={error} />

      <section className="card workflow-basics">
        <label className="field">
          <span>Name</span>
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="ClickUp task to pull request" />
        </label>
        <label className="field grow">
          <span>Description</span>
          <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
          <span>Enabled</span>
          <small>Disabled workflows ignore their triggers.</small>
        </label>
      </section>

      <div className="tabs">
        {TABS.map((name) => (
          <button key={name} className={tab === name ? 'tab active' : 'tab'} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>

      {tab === 'Blocks' && (
        <BlockPipeline
          meta={meta.data}
          triggers={draft.definition.triggers}
          steps={draft.definition.steps}
          secretNames={secrets.data ?? []}
          hooks={saved && { workflowId: saved.id, secret: saved.hookSecret }}
          onTriggersChange={(triggers) => setDefinition({ triggers })}
          onStepsChange={(steps) => setDefinition({ steps })}
        />
      )}
      {tab === 'Environment' && (
        <EnvironmentEditor environment={draft.definition.environment} secretNames={secrets.data ?? []} requirements={requirements.data} egressEnforced={sandbox.data?.egressEnforced} onChange={(environment) => setDefinition({ environment })} />
      )}
      {tab === 'Notifications' && <NotificationsEditor notifications={draft.definition.notifications} onChange={(notifications) => setDefinition({ notifications })} />}
      {tab === 'Code' && <CodeView draft={draft} onApply={(applied) => (setDraft(applied), setTab('Blocks'))} />}
    </>
  );
}
