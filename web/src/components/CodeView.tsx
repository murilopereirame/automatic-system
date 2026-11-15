/**
 * The workflow as formula YAML. The text is generated from the blocks when
 * the tab opens; "Apply" parses edited text back into blocks.
 */
import { useEffect, useState } from 'react';
import { api, type WorkflowDraft } from '../api.ts';
import { ErrorNote } from './common.tsx';

interface Props {
  draft: WorkflowDraft;
  onApply: (draft: WorkflowDraft) => void;
}

export function CodeView({ draft, onApply }: Props) {
  const [text, setText] = useState('');
  const [original, setOriginal] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.renderFormula(draft).then(
      ({ formula }) => (setText(formula), setOriginal(formula), setError(undefined)),
      (reason: Error) => setError(reason.message),
    );
  }, [draft]);

  const apply = () => api.parseFormula(text).then(onApply, (reason: Error) => setError(reason.message));

  return (
    <section className="card">
      <h2>Formula</h2>
      <p className="muted">The same workflow as code. Edit it here and apply, or keep this file in your repository and import it after a redeploy.</p>
      <textarea className="mono code-editor" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} rows={Math.max(20, text.split('\n').length + 1)} />
      <ErrorNote message={error} />
      <div className="actions">
        <button className="primary" disabled={text === original} onClick={apply}>
          Apply to blocks
        </button>
        <button disabled={text === original} onClick={() => setText(original)}>
          Discard edits
        </button>
      </div>
    </section>
  );
}
