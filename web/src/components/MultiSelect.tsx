/**
 * Picks several values from a list: the chosen ones show as chips (× removes one), and a dropdown
 * with a search box adds more. Keyboard: type to search, ↑/↓ to move, Enter to pick or unpick,
 * Escape to close, Backspace in an empty search removes the last chip.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface Option {
  value: string;
  /** Shown next to the value, e.g. "no value stored". */
  note?: ReactNode;
}

interface Props {
  options: Option[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  /** Shown in the dropdown when there is nothing to pick from at all. */
  emptyText?: string;
  label: string;
}

/** Options whose value contains the query, ignoring case. Exported for tests. */
export function matchOptions(options: Option[], query: string): Option[] {
  const needle = query.trim().toLowerCase();
  return needle ? options.filter((option) => option.value.toLowerCase().includes(needle)) : options;
}

export function MultiSelect({ options, selected, onChange, placeholder = 'Search…', emptyText = 'Nothing to pick from.', label }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const matches = useMemo(() => matchOptions(options, query), [options, query]);
  const notes = new Map(options.map((option) => [option.value, option.note]));

  // Close when focus or a click goes elsewhere.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => root.current?.contains(event.target as Node) || setOpen(false);
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = matches[active];
      if (open && option) toggle(option.value);
      setOpen(true);
    } else if (event.key === 'Escape') {
      setOpen(false);
    } else if (event.key === 'Backspace' && query === '' && selected.length > 0) {
      onChange(selected.slice(0, -1));
    }
  };

  return (
    <div className={`multiselect${open ? ' open' : ''}`} ref={root}>
      <div className="multiselect-control" onClick={() => (setOpen(true), input.current?.focus())}>
        {selected.map((value) => (
          <span key={value} className="chip">
            <code>{value}</code>
            {notes.get(value)}
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${value}`}
              onClick={(event) => {
                event.stopPropagation();
                toggle(value);
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          value={query}
          placeholder={selected.length ? '' : placeholder}
          onChange={(event) => (setQuery(event.target.value), setOpen(true))}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        />
      </div>
      {open && (
        <ul className="multiselect-menu" id={listId} role="listbox" aria-multiselectable="true" aria-label={label}>
          {options.length === 0 && <li className="multiselect-empty">{emptyText}</li>}
          {options.length > 0 && matches.length === 0 && <li className="multiselect-empty">No match for "{query}".</li>}
          {matches.map((option, index) => {
            const isSelected = selected.includes(option.value);
            return (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={isSelected}
                className={`multiselect-option${index === active ? ' active' : ''}${isSelected ? ' selected' : ''}`}
                onPointerEnter={() => setActive(index)}
                // Keep focus in the search box, so typing and the keyboard keep working.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => toggle(option.value)}
              >
                <span className="multiselect-check" aria-hidden="true">
                  {isSelected ? '✓' : ''}
                </span>
                <code>{option.value}</code>
                {option.note}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
