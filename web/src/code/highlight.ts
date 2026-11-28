/**
 * Syntax highlighting for code shown in the UI: command lines, JSON payloads, the formula YAML,
 * code blocks in Claude's messages. Uses lowlight (highlight.js grammars, output as a syntax
 * tree) and turns the tree into React elements: no HTML strings, nothing set as innerHTML.
 * Only the languages listed here are bundled. Colours are in styles.css (".hl-*"). See docs/UI.md.
 */
import type { Root } from 'hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { createLowlight } from 'lowlight';
import type { ReactNode } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';

export const GRAMMARS = { bash, css, diff, dockerfile, go, ini, javascript, json, markdown, python, sql, typescript, xml, yaml };

/** Other names code blocks use for the same languages. */
export const ALIASES = { bash: ['sh', 'shell', 'zsh', 'console'], javascript: ['js', 'jsx', 'mjs', 'cjs'], typescript: ['ts', 'tsx'], yaml: ['yml'], xml: ['html', 'svg'], markdown: ['md'], ini: ['toml'], python: ['py'] };

export const lowlight = createLowlight(GRAMMARS);
lowlight.registerAlias(ALIASES);

/** Longer texts are shown plain: highlighting them would cost more than it helps. */
export const MAX_HIGHLIGHT_CHARS = 50_000;

/** The language name lowlight knows, for a name or alias such as "ts" or "yml". */
export function knownLanguage(language: string | undefined): string | undefined {
  return language && lowlight.registered(language) ? language : undefined;
}

/** The syntax tree of highlighted code, or undefined when it should be shown as plain text. */
export function highlightTree(code: string, language: string | undefined): Root | undefined {
  const known = knownLanguage(language);
  if (!known || code.length > MAX_HIGHLIGHT_CHARS) return undefined;
  return lowlight.highlight(known, code, { prefix: 'hl-' });
}

/** Highlighted code as React elements, or the code as it is. */
export function highlight(code: string, language: string | undefined): ReactNode {
  const tree = highlightTree(code, language);
  return tree ? toJsxRuntime(tree, { Fragment, jsx, jsxs }) : code;
}
