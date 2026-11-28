/** Read-only code with syntax highlighting. See code/highlight.ts. */
import { forwardRef, useMemo, type UIEvent } from 'react';
import { highlight } from '../code/highlight.ts';

interface Props {
  code: string;
  /** A language or alias lowlight knows (json, yaml, bash, ts, ...). Unknown or missing: plain text. */
  language?: string;
  className?: string;
  onScroll?: (event: UIEvent<HTMLPreElement>) => void;
}

export const CodeBlock = forwardRef<HTMLPreElement, Props>(function CodeBlock({ code, language, className, onScroll }, ref) {
  const content = useMemo(() => highlight(code, language), [code, language]);
  return (
    <pre ref={ref} className={`code-block${className ? ` ${className}` : ''}`} onScroll={onScroll} data-language={language}>
      <code>{content}</code>
    </pre>
  );
});
