/**
 * Icon and colour of each node on the flow canvas, by block or trigger type. Types the UI does not
 * know yet get a neutral square, so new server-side types still show up without a change here.
 */
import type { ReactNode } from 'react';

const ICONS: Record<string, ReactNode> = {
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  bolt: <path d="M13 3 5 14h6l-1 7 8-11h-6z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.8 3 2.8 14 0 17M12 3.5c-2.8 3-2.8 14 0 17" />
    </>
  ),
  terminal: <path d="M5 8l4 4-4 4M11 16.5h8" />,
  sparkle: <path d="M12 3.5c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.6 5.9-2.3 6.5-6.5zM18 15.5c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5z" />,
  person: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1-4 3.8-6 7-6s6 2 7 6" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="7.5" r="2.2" />
      <path d="M7 8.2v7.6M17 9.7c0 4-4 4.3-8.4 6.8" />
    </>
  ),
  pull: (
    <>
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="18" r="2.2" />
      <path d="M7 8.2v7.6M17 15.8V10a3 3 0 0 0-3-3h-3.5M12.5 5l-2 2 2 2" />
    </>
  ),
  bell: <path d="M6.5 16v-4.5a5.5 5.5 0 0 1 11 0V16l1.5 2h-14zM10 20.5a2 2 0 0 0 4 0" />,
  diamond: <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />,
  list: <path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  comment: <path d="M4.5 5.5h15v10h-9l-4.5 4v-4h-1.5z" />,
  square: <rect x="6" y="6" width="12" height="12" rx="2" />,
};

interface NodeStyle {
  icon: keyof typeof ICONS;
  /** CSS colour of the icon tile and the node's accent. */
  color: string;
}

const STYLES: Record<string, NodeStyle> = {
  manual: { icon: 'play', color: 'var(--accent)' },
  webhook: { icon: 'globe', color: '#8a63d2' },
  clickup: { icon: 'bolt', color: '#8a63d2' },
  claude: { icon: 'sparkle', color: '#c2703d' },
  shell: { icon: 'terminal', color: '#58657a' },
  git_clone: { icon: 'branch', color: 'var(--good)' },
  github_pr: { icon: 'pull', color: 'var(--good)' },
  approval: { icon: 'person', color: 'var(--attention)' },
  condition: { icon: 'diamond', color: 'var(--running)' },
  notify: { icon: 'bell', color: '#c2417a' },
  clickup_fetch_task: { icon: 'list', color: '#7b68ee' },
  clickup_comment: { icon: 'comment', color: '#7b68ee' },
};

export function nodeStyle(type: string): NodeStyle {
  return STYLES[type] ?? { icon: 'square', color: 'var(--muted)' };
}

export function NodeIcon({ type, size = 20 }: { type: string; size?: number }) {
  const { icon } = nodeStyle(type);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[icon]}
    </svg>
  );
}
