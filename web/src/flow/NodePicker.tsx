/**
 * The "add a node" panel of the flow editor: a searchable list of block or trigger types.
 * Arrow keys move through the list, Enter adds the highlighted type, Escape closes.
 */
import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { BlockType } from '../api.ts';
import { NodeIcon, nodeStyle } from './node-style.tsx';

interface Props {
  types: BlockType[];
  /** What is being added, e.g. "Add a block after Clone the repository". */
  title: string;
  onPick: (type: BlockType) => void;
  onClose: () => void;
}

export function NodePicker({ types, title, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = types.filter((type) => {
    const text = `${type.title} ${type.description} ${type.type}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const active = Math.min(highlighted, shown.length - 1);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') setHighlighted(Math.min(shown.length - 1, active + 1));
    else if (event.key === 'ArrowUp') setHighlighted(Math.max(0, active - 1));
    else if (event.key === 'Enter' && shown[active]) onPick(shown[active]);
    else if (event.key === 'Escape') onClose();
    else return;
    event.preventDefault();
  };

  return (
    <>
      <header className="flow-panel-header">
        <span className="flow-panel-title">
          <strong>{title}</strong>
        </span>
        <button className="ghost icon-button" onClick={onClose} aria-label="Close" title="Close (Esc)">
          ✕
        </button>
      </header>
      <div className="flow-panel-body">
        <input autoFocus type="search" placeholder="Search…" value={query} onChange={(event) => (setQuery(event.target.value), setHighlighted(0))} onKeyDown={onKeyDown} aria-label="Search types" />
        <div className="node-picker" role="listbox">
          {shown.map((type, index) => (
            <button
              key={type.type}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'node-picker-item active' : 'node-picker-item'}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => onPick(type)}
            >
              <span className="flow-node-icon" style={{ '--node-color': nodeStyle(type.type).color } as CSSProperties}>
                <NodeIcon type={type.type} />
              </span>
              <span className="node-picker-text">
                <strong>{type.title}</strong>
                <span className="muted">{type.description}</span>
              </span>
            </button>
          ))}
          {shown.length === 0 && <p className="empty">Nothing matches "{query}".</p>}
        </div>
      </div>
    </>
  );
}
