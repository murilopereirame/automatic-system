/**
 * Renders text that Claude wrote, or that came from a task Claude read, as Markdown (GitHub flavour).
 * That text is untrusted, so this component is built not to run anything it contains.
 * See docs/MARKDOWN.md.
 *
 *  - No HTML strings are made and nothing goes through innerHTML: react-markdown builds React elements.
 *  - Raw HTML in the text (`<script>`, `<img onerror>`, ...) is not rendered. It is shown as the literal text.
 *  - Links keep only http, https and mailto addresses and anchors on the page. Anything else, such as
 *    `javascript:` or `data:`, becomes an empty address. Links open in a new tab without a referrer.
 *  - Images are not loaded. Loading one would tell whoever owns the address that the page was opened,
 *    and the address could carry data from the run. They are shown as a link the person can open.
 */
import { memo, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:'];

/** Keeps an address only when it is http(s), mailto or an anchor on this page. */
export function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith('#')) return trimmed;
  try {
    // An address without a scheme would resolve against this page, so it is refused like a bad scheme.
    const parsed = new URL(trimmed);
    return SAFE_PROTOCOLS.includes(parsed.protocol) ? trimmed : '';
  } catch {
    return '';
  }
}

function Link({ node: _node, href, children, ...rest }: ComponentProps<'a'> & { node?: unknown }) {
  if (!href) return <span className="md-dead-link">{children}</span>;
  const external = !href.startsWith('#');
  return (
    <a {...rest} href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}>
      {children}
    </a>
  );
}

function Image({ src, alt }: ComponentProps<'img'> & { node?: unknown }) {
  const label = alt || 'image';
  if (typeof src !== 'string' || !src) return <span className="md-image">[{label}]</span>;
  return (
    <a className="md-image" href={src} target="_blank" rel="noopener noreferrer nofollow" title="Images are not loaded here. Open it in a new tab.">
      [image: {label}]
    </a>
  );
}

const COMPONENTS: Components = { a: Link, img: Image };
const PLUGINS = [remarkGfm];

function MarkdownView({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `markdown ${className}` : 'markdown'}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS} urlTransform={safeUrl}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Parsing is the costly part, so the same text is not parsed again when a parent re-renders. */
export const Markdown = memo(MarkdownView);
