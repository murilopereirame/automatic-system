/**
 * A textarea with syntax highlighting: the text is typed in a transparent textarea laid exactly
 * over a highlighted copy of it. Editing stays a plain textarea (undo, selection, IME, spell check off).
 */
import { useMemo, useRef } from 'react';
import { highlight } from '../code/highlight.ts';

interface Props {
  value: string;
  onChange: (value: string) => void;
  language: string;
  rows?: number;
  placeholder?: string;
  'aria-label'?: string;
}

export function CodeEditor({ value, onChange, language, rows = 10, placeholder, ...rest }: Props) {
  const layer = useRef<HTMLPreElement>(null);
  // A trailing newline needs a character after it, or the highlighted copy is one line short.
  const content = useMemo(() => highlight(value.endsWith('\n') ? `${value} ` : value, language), [value, language]);
  return (
    <div className="code-editor-wrap" style={{ ['--rows' as string]: rows }}>
      <pre ref={layer} className="code-editor-layer" aria-hidden="true">
        <code>{content}</code>
      </pre>
      <textarea
        className="code-editor-input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (layer.current) {
            layer.current.scrollTop = event.currentTarget.scrollTop;
            layer.current.scrollLeft = event.currentTarget.scrollLeft;
          }
        }}
        aria-label={rest['aria-label']}
      />
    </div>
  );
}
