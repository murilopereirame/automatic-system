/**
 * The files a run put in its output folder, grouped by folder, with download links. The folder
 * is outside the repository, so this is how screenshots, reports and build artifacts get out of
 * the container. See docs/OUTPUTS.md and docs/RUN_VIEW.md.
 *
 * Files only download: none is opened in the page, so a file Claude wrote cannot run as part of it.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type OutputFile, type OutputListing, type Run } from '../api.ts';
import { ErrorNote, TimeAgo } from '../components/common.tsx';
import { baseName, fileKind, formatSize, groupFiles, totalSize, type FileKind, type SortOrder } from './output-files.ts';

/** From this many files on, the list gets a filter box. */
const FILTER_FROM = 6;

const ICONS: Record<FileKind | 'folder', ReactNode> = {
  folder: <path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />,
  image: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m5 17 4.5-4.5 3 3 2.5-2.5L19.5 17.5" />
    </>
  ),
  document: <path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4M9.5 12h6M9.5 15h6M9.5 18h4" />,
  data: (
    <>
      <ellipse cx="12" cy="6.5" rx="7" ry="3" />
      <path d="M5 6.5v11c0 1.7 3.1 3 7 3s7-1.3 7-3v-11M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>
  ),
  code: <path d="m9 8-4 4 4 4M15 8l4 4-4 4M13 6l-2 12" />,
  archive: <path d="M4.5 5.5h15v4h-15zM5.5 9.5v9h13v-9M10 13h4" />,
  log: <path d="M5 8l4 4-4 4M11 16.5h8" />,
  other: <path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4" />,
};

function FileIcon({ kind }: { kind: FileKind | 'folder' }) {
  return (
    <span className={`output-icon output-icon-${kind}`} aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {ICONS[kind]}
      </svg>
    </span>
  );
}

const fingerprint = (file: OutputFile) => `${file.size}:${file.modifiedAt}`;

/** Reloads whenever the run changes (each block start and finish), which is when new files usually appear. */
export function OutputFiles({ run }: { run: Run }) {
  const [listing, setListing] = useState<OutputListing>();
  const [error, setError] = useState<string>();
  const [order, setOrder] = useState<SortOrder>('newest');
  const [filter, setFilter] = useState('');
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState(false);
  // Files as first loaded: anything added or changed after that is marked as new while the page is open.
  const known = useRef<Map<string, string> | undefined>(undefined);

  const load = () =>
    api.runOutputs(run.id).then(
      (value) => {
        known.current ??= new Map(value.files.map((file) => [file.path, fingerprint(file)]));
        setListing(value);
        setError(undefined);
      },
      (reason: Error) => setError(reason.message),
    );
  useEffect(() => void load(), [run.id, run.updatedAt]);

  const folders = useMemo(() => groupFiles(listing?.files ?? [], order, filter), [listing, order, filter]);

  if (!listing) return <ErrorNote message={error} />;
  const { dir, files, truncated } = listing;
  const shown = folders.reduce((sum, folder) => sum + folder.files.length, 0);
  const isNew = (file: OutputFile) => known.current !== undefined && known.current.get(file.path) !== fingerprint(file);
  const toggle = (path: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const copyPath = () =>
    navigator.clipboard?.writeText(dir).then(
      () => (setCopied(true), window.setTimeout(() => setCopied(false), 1500)),
      () => {},
    );

  return (
    <section className="card outputs">
      <header className="outputs-header">
        <div className="outputs-title">
          <h2>Output files</h2>
          {files.length > 0 && (
            <span className="badge">
              {files.length}
              {truncated ? '+' : ''} file{files.length === 1 ? '' : 's'} · {formatSize(totalSize(files))}
            </span>
          )}
        </div>
        <div className="actions">
          <button className="ghost" onClick={load} title="Look for new files now">
            Refresh
          </button>
          {files.length > 0 && (
            <a className="button" href={api.outputArchiveUrl(run.id)} download>
              Download all (.tar.gz)
            </a>
          )}
        </div>
      </header>
      <ErrorNote message={error} />
      <p className="outputs-where muted">
        Saved to <code>$AUTOWORKER_OUTPUT_DIR</code> by Claude, commands or you in the shell. Kept when the workspace is cleaned up.{' '}
        <button className="link-button" onClick={copyPath} title={dir}>
          {copied ? 'Path copied' : 'Copy folder path'}
        </button>
      </p>

      {files.length === 0 ? (
        <div className="outputs-empty">
          <FileIcon kind="folder" />
          <p>
            Nothing here yet. Files written to <code>$AUTOWORKER_OUTPUT_DIR</code> show up here as the run goes.
          </p>
        </div>
      ) : (
        <>
          {files.length >= FILTER_FROM && (
            <div className="outputs-toolbar">
              <input type="search" placeholder="Filter by name" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter files by name" />
              <label className="outputs-sort">
                <span className="muted">Sort</span>
                <select value={order} onChange={(event) => setOrder(event.target.value as SortOrder)}>
                  <option value="newest">Newest first</option>
                  <option value="name">Name</option>
                  <option value="size">Largest first</option>
                </select>
              </label>
            </div>
          )}
          {shown === 0 && <p className="empty">No file matches "{filter}".</p>}
          <div className="output-folders">
            {folders.map((folder) => {
              const isFolded = folded.has(folder.path);
              return (
                <div key={folder.path} className="output-folder">
                  {folder.path && (
                    <button className="output-folder-header" onClick={() => toggle(folder.path)} aria-expanded={!isFolded}>
                      <span className="activity-chevron" aria-hidden="true" />
                      <FileIcon kind="folder" />
                      <span className="output-folder-name">{folder.path}/</span>
                      <span className="muted">
                        {folder.files.length} file{folder.files.length === 1 ? '' : 's'} · {formatSize(folder.size)}
                      </span>
                    </button>
                  )}
                  {!isFolded && (
                    <ul className={`output-list${folder.path ? ' nested' : ''}`}>
                      {folder.files.map((file) => (
                        <li key={file.path} className={isNew(file) ? 'new' : undefined}>
                          <a href={api.outputFileUrl(run.id, file.path)} download title={`Download ${file.path}`}>
                            <FileIcon kind={fileKind(file.path)} />
                            <span className="output-name">{baseName(file.path)}</span>
                            {isNew(file) && <span className="badge output-new">new</span>}
                          </a>
                          <span className="output-size">{formatSize(file.size)}</span>
                          <span className="output-time">
                            <TimeAgo time={file.modifiedAt} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {truncated && <p className="muted">Only the newest {files.length} files are listed. Download all to get the rest.</p>}
    </section>
  );
}
