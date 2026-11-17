/**
 * The History tab of the workflow editor: every saved version, what changed in
 * each one, and a way back to any of them. See docs/VERSIONING.md.
 */
import { useEffect, useState } from 'react';
import { api, type VersionDiff, type VersionSummary, type Workflow } from '../api.ts';
import { Empty, ErrorNote, TimeAgo } from './common.tsx';

const SOURCE_LABEL: Record<VersionSummary['source'], string> = {
  created: 'Created',
  edited: 'Edited',
  imported: 'Imported',
  restored: 'Restored',
};

function describe(version: VersionSummary): string {
  if (version.message) return version.message;
  return version.source === 'restored' ? `Restored version ${version.restoredFrom}` : SOURCE_LABEL[version.source];
}

function DiffView({ diff }: { diff: VersionDiff }) {
  if (diff.hunks.length === 0) return <Empty>These two versions are the same.</Empty>;
  return (
    <div className="diff">
      {diff.hunks.map((hunk, index) => (
        <div className="diff-hunk" key={index}>
          {hunk.lines.map((line, lineIndex) => (
            <div className={`diff-line diff-${line.kind}`} key={lineIndex}>
              <span className="diff-number">{line.oldLine ?? ''}</span>
              <span className="diff-number">{line.newLine ?? ''}</span>
              <span className="diff-sign">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
              <span className="diff-text">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface Props {
  workflow: Workflow;
  /** True when the editor has changes that are not saved. Restoring would replace them. */
  dirty: boolean;
  onRestored: (workflow: Workflow) => void;
  onExport: () => void;
}

export function VersionHistory({ workflow, dirty, onRestored, onExport }: Props) {
  const [versions, setVersions] = useState<VersionSummary[]>();
  const [selected, setSelected] = useState(workflow.version);
  /** Which version the selected one is compared with. `undefined` means the one before it. */
  const [against, setAgainst] = useState<number>();
  const [diff, setDiff] = useState<VersionDiff>();
  const [error, setError] = useState<string>();

  // Reload the list whenever the workflow gets a new version (a save or a restore).
  useEffect(() => {
    api.versions(workflow.id).then(setVersions, (reason: Error) => setError(reason.message));
    setSelected(workflow.version);
    setAgainst(undefined);
  }, [workflow.id, workflow.version]);

  useEffect(() => {
    setDiff(undefined);
    api.versionDiff(workflow.id, selected, against).then(setDiff, (reason: Error) => setError(reason.message));
  }, [workflow.id, selected, against]);

  const restore = (version: number) => {
    const unsaved = dirty ? ' Your unsaved changes in the editor will be discarded.' : '';
    if (!window.confirm(`Bring back version ${version}? It is saved as a new version ${workflow.version + 1}, so nothing in the history is lost.${unsaved}`)) return;
    api.restoreVersion(workflow.id, version).then(onRestored, (reason: Error) => setError(reason.message));
  };

  if (!versions) return <ErrorNote message={error} />;
  const current = versions.find((version) => version.version === selected);

  return (
    <div className="history-layout">
      <aside className="card versions">
        <header>
          <h2>Versions</h2>
          <button onClick={onExport} title="A formula that also carries every earlier version, so an import on a new deployment keeps the history">
            Export with history
          </button>
        </header>
        {versions.map((version) => (
          <button key={version.version} className={version.version === selected ? 'version selected' : 'version'} onClick={() => (setSelected(version.version), setAgainst(undefined))}>
            <span className="version-number">v{version.version}</span>
            <span className="version-main">
              <span className="version-message">{describe(version)}</span>
              <span className="meta">
                <TimeAgo time={version.createdAt} />
                {version.version === workflow.version && <span className="badge">current</span>}
                {version.runs > 0 && <span>{version.runs === 1 ? '1 run' : `${version.runs} runs`}</span>}
              </span>
            </span>
          </button>
        ))}
      </aside>

      <section className="card version-detail">
        <header>
          <h2>
            Version {selected}
            {current && <span className="muted"> · {SOURCE_LABEL[current.source]} {current.createdAt && <TimeAgo time={current.createdAt} />}</span>}
          </h2>
          {selected !== workflow.version && (
            <button className="primary" onClick={() => restore(selected)}>
              Restore this version
            </button>
          )}
        </header>
        <div className="diff-controls">
          <label className="field inline">
            <span>Compare with</span>
            <select value={against ?? ''} onChange={(event) => setAgainst(event.target.value === '' ? undefined : Number(event.target.value))}>
              <option value="">the version before</option>
              {versions
                .filter((version) => version.version !== selected)
                .map((version) => (
                  <option key={version.version} value={version.version}>
                    v{version.version}
                    {version.version === workflow.version ? ' (current)' : ''}
                  </option>
                ))}
            </select>
          </label>
          {diff && (
            <span className="muted">
              {diff.from === 0 ? 'First version' : `v${diff.from} → v${diff.to}`} · <span className="diff-count-added">+{diff.added}</span> <span className="diff-count-removed">−{diff.removed}</span>
            </span>
          )}
        </div>
        <ErrorNote message={error} />
        {diff && <DiffView diff={diff} />}
      </section>
    </div>
  );
}
