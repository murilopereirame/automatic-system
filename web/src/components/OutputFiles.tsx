/**
 * The files a run put in its output folder, with download links. The folder
 * is outside the repository, so this is how screenshots, reports and build
 * artifacts get out of the container. See docs/OUTPUTS.md.
 */
import { useEffect, useState } from 'react';
import { api, type OutputListing, type Run } from '../api.ts';
import { ErrorNote, TimeAgo } from './common.tsx';

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Reloads whenever the run changes (each block start and finish), which is when new files usually appear. */
export function OutputFiles({ run }: { run: Run }) {
  const [listing, setListing] = useState<OutputListing>();
  const [error, setError] = useState<string>();
  const load = () => api.runOutputs(run.id).then((value) => (setListing(value), setError(undefined)), (reason: Error) => setError(reason.message));
  useEffect(() => void load(), [run.id, run.updatedAt]);

  if (!listing) return <ErrorNote message={error} />;
  const { dir, files, truncated } = listing;
  return (
    <section className="card outputs">
      <header>
        <h2>Output files</h2>
        <div className="actions">
          <button onClick={load}>Refresh</button>
          {files.length > 0 && (
            <a className="button" href={api.outputArchiveUrl(run.id)} download>
              Download all (.tar.gz)
            </a>
          )}
        </div>
      </header>
      <ErrorNote message={error} />
      <p className="muted">
        Files Claude, commands or you in the shell put in <code>{dir}</code> (<code>$AUTOWORKER_OUTPUT_DIR</code>). The folder is outside the repository and is kept when the workspace is cleaned up.
      </p>
      {files.length === 0 ? (
        <p className="empty">Nothing here yet.</p>
      ) : (
        <ul className="output-list">
          {files.map((file) => (
            <li key={file.path}>
              <a href={api.outputFileUrl(run.id, file.path)} download>
                {file.path}
              </a>
              <span className="muted">
                {formatSize(file.size)} · <TimeAgo time={file.modifiedAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {truncated && <p className="muted">Only the newest {files.length} files are listed. Download all to get the rest.</p>}
    </section>
  );
}
