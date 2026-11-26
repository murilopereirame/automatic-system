/**
 * A prompt for Claude that the person can read formatted or edit as text.
 * Used where a prompt can be changed: at a pause before a block, and on the run page.
 */
import { useState } from 'react';
import { Markdown } from './Markdown.tsx';

interface Props {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  /** Which tab is open first. Reading is the common case, so it defaults to the preview. */
  initialMode?: 'preview' | 'edit';
}

export function PromptEditor({ value, onChange, rows = 8, initialMode = 'preview' }: Props) {
  const [mode, setMode] = useState(initialMode);
  return (
    <div className="prompt-editor-box">
      <div className="tabs compact" role="tablist">
        <button role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'tab active' : 'tab'} onClick={() => setMode('preview')}>
          Preview
        </button>
        <button role="tab" aria-selected={mode === 'edit'} className={mode === 'edit' ? 'tab active' : 'tab'} onClick={() => setMode('edit')}>
          Edit
        </button>
      </div>
      {mode === 'edit' ? (
        <textarea className="prompt-editor" rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <div className="prompt-preview" onDoubleClick={() => setMode('edit')} title="Double-click to edit">
          {value.trim() ? <Markdown text={value} /> : <p className="muted">The prompt is empty.</p>}
        </div>
      )}
    </div>
  );
}
