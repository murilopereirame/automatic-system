/**
 * Create or edit a workflow: the name in the header, then tabs for the blocks (a flow canvas),
 * the workflow's settings, environment, notifications, the formula as code, and its version history.
 */
import { useEffect, useState } from 'react';
import { api, type CleanupWhen, type Workflow, type WorkflowDraft } from '../api.ts';
import { CodeView } from '../components/CodeView.tsx';
import { ErrorNote, LoadingOrError, PageHeader } from '../components/common.tsx';
import { EnvironmentEditor } from '../components/EnvironmentEditor.tsx';
import { NotificationsEditor } from '../components/NotificationsEditor.tsx';
import { useRunNow } from '../components/RunNowDialog.tsx';
import { VersionHistory } from '../components/VersionHistory.tsx';
import { FlowEditor } from '../flow/FlowEditor.tsx';
import { useLoad } from '../hooks.ts';
import { navigate } from '../router.ts';

const TABS = ['Blocks', 'Settings', 'Environment', 'Notifications', 'Code', 'History'] as const;
type Tab = (typeof TABS)[number];

const NEW_WORKFLOW: WorkflowDraft = {
  name: '',
  description: '',
  enabled: true,
  definition: {
    triggers: [],
    inputs: [],
    environment: { runtimes: [], mcpServers: {}, memory: [], skills: [], services: [], network: { allow: [] }, env: {}, secrets: [], mounts: [] },
    notifications: [],
    steps: [],
    cleanup: { when: 'never' },
  },
};

/** The choices of the cleanup setting, in the words the editor shows. */
const CLEANUP_LABELS: Record<CleanupWhen, string> = {
  never: 'Keep them until I clean up',
  succeeded: 'Delete them when a run succeeds',
  finished: 'Delete them when a run ends, also failed or cancelled',
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
  /** Optional description of the change, kept with the version the next save creates. */
  const [changeNote, setChangeNote] = useState('');
  /** Open runs that still use the definition from before the last save. */
  const [outdatedRuns, setOutdatedRuns] = useState(0);

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
      const workflow = workflowId ? await api.updateWorkflow(workflowId, draft, changeNote) : await api.createWorkflow(draft);
      setSaved(workflow);
      setDraft(toDraft(workflow));
      setChangeNote('');
      setError(undefined);
      setNotice(`Saved as version ${workflow.version}`);
      requirements.reload();
      if (workflowId) api.outdatedRuns(workflow.id).then((found) => setOutdatedRuns(found.length), () => setOutdatedRuns(0));
      if (!workflowId) navigate(`/workflows/${workflow.id}`);
      return workflow;
    } catch (reason) {
      fail(reason as Error);
    }
  };

  const applyToRuns = () =>
    saved &&
    api.applyToRuns(saved.id).then((applied) => {
      setOutdatedRuns(0);
      setNotice(`Saved and applied to ${applied.length} run${applied.length === 1 ? '' : 's'}`);
    }, fail);

  const { runNow, dialog } = useRunNow(fail);
  const saveAndRun = async () => {
    const workflow = dirty ? await save() : saved;
    if (workflow) runNow(workflow);
  };

  const exportFormula = (withHistory = false) =>
    saved && api.exportFormula(saved.id, withHistory).then((yaml) => download(`${saved.name.replace(/\W+/g, '-').toLowerCase()}.formula.yaml`, yaml), fail);

  const restored = (workflow: Workflow) => {
    setSaved(workflow);
    setDraft(toDraft(workflow));
    setNotice(`Restored as version ${workflow.version}`);
    setError(undefined);
    requirements.reload();
  };

  const remove = () => {
    if (saved && window.confirm(`Delete the workflow "${saved.name}"? Its runs stay in the history.`)) {
      api.deleteWorkflow(saved.id).then(() => navigate('/workflows'), fail);
    }
  };

  if (!meta.data || (workflowId && !saved)) return <LoadingOrError error={error ?? meta.error} />;

  return (
    <>
      <PageHeader
        title={
          <>
            {/* The sizer repeats the text invisibly so the input grows and shrinks with the name. */}
            <span className="title-sizer" data-value={draft.name || 'New workflow name'}>
              <input
                className="title-input"
                size={1}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder={workflowId ? 'Name this workflow' : 'New workflow name'}
                aria-label="Workflow name"
                autoFocus={!workflowId}
              />
            </span>
            {saved && (
              <span className="badge" title="Current version. See the History tab.">
                v{saved.version}
              </span>
            )}
            {!draft.enabled && (
              <span className="badge" title="Disabled workflows ignore their triggers. Change it in the Settings tab.">
                disabled
              </span>
            )}
          </>
        }
      >
        {notice && !dirty && <span className="muted">{notice}</span>}
        {saved && dirty && <input className="change-note" value={changeNote} onChange={(event) => setChangeNote(event.target.value)} placeholder="What changed? (optional)" aria-label="Describe this change" />}
        {saved && <button onClick={() => exportFormula()}>Export formula</button>}
        {saved && (
          <button className="danger" onClick={remove}>
            Delete
          </button>
        )}
        <button onClick={saveAndRun} disabled={!draft.name}>
          Run now
        </button>
        <button className="primary" onClick={save} disabled={!dirty || !draft.name}>
          Save
        </button>
      </PageHeader>
      <ErrorNote message={error} />
      {outdatedRuns > 0 && !dirty && (
        <section className="card apply-latest">
          <header>
            <strong>
              {outdatedRuns} open run{outdatedRuns === 1 ? '' : 's'} still use{outdatedRuns === 1 ? 's' : ''} the workflow from before this save
            </strong>
            <div className="actions">
              <button className="primary" onClick={applyToRuns} title="Blocks those runs already finished keep their results; the rest use the saved workflow">
                Apply to {outdatedRuns === 1 ? 'it' : 'them'}
              </button>
              <button onClick={() => setOutdatedRuns(0)}>Keep as they are</button>
            </div>
          </header>
          <p className="muted">Blocks those runs already finished keep their results. A block that is running right now finishes as it is. You can also apply the changes to one run from its page.</p>
        </section>
      )}

      <div className="tabs">
        {TABS.filter((name) => name !== 'History' || saved).map((name) => (
          <button key={name} className={tab === name ? 'tab active' : 'tab'} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>

      {/* Keyed by the tab so each one fades in when it opens. */}
      <div className="tab-panel" key={tab}>
        {tab === 'Blocks' && (
          <FlowEditor
            meta={meta.data}
            triggers={draft.definition.triggers}
            inputs={draft.definition.inputs ?? []}
            steps={draft.definition.steps}
            secretNames={secrets.data ?? []}
            hooks={saved && { workflowId: saved.id, secret: saved.hookSecret }}
            onTriggersChange={(triggers) => setDefinition({ triggers })}
            onInputsChange={(inputs) => setDefinition({ inputs })}
            onStepsChange={(steps) => setDefinition({ steps })}
          />
        )}
        {tab === 'Settings' && (
          <section className="card workflow-settings">
            <label className="field">
              <span>Description</span>
              <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </label>
            <label className="field checkbox">
              <input type="checkbox" role="switch" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
              <span>Enabled</span>
              <small>Disabled workflows ignore their triggers.</small>
            </label>
            <label className="field">
              <span>Files of finished runs</span>
              <select value={draft.definition.cleanup?.when ?? 'never'} onChange={(event) => setDefinition({ cleanup: { when: event.target.value as CleanupWhen } })}>
                {(Object.keys(CLEANUP_LABELS) as CleanupWhen[]).map((when) => (
                  <option key={when} value={when}>
                    {CLEANUP_LABELS[when]}
                  </option>
                ))}
              </select>
              <small>The workspace with its clones, and Claude's conversation. A run whose files are gone cannot be retried.</small>
            </label>
          </section>
        )}
        {tab === 'Environment' && (
          <EnvironmentEditor
            environment={draft.definition.environment}
            secretNames={secrets.data ?? []}
            requirements={requirements.data}
            egressEnforced={sandbox.data?.egressEnforced}
            onChange={(environment) => setDefinition({ environment })}
          />
        )}
        {tab === 'Notifications' && <NotificationsEditor notifications={draft.definition.notifications} onChange={(notifications) => setDefinition({ notifications })} workflowName={draft.name} inputs={draft.definition.inputs} />}
        {tab === 'History' && saved && <VersionHistory workflow={saved} dirty={dirty} onRestored={restored} onExport={() => exportFormula(true)} />}
        {tab === 'Code' && <CodeView draft={draft} onApply={(applied) => (setDraft(applied), setTab('Blocks'))} />}
      </div>
      {dialog}
    </>
  );
}
