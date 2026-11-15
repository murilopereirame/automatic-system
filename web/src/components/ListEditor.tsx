/** Editable list of rows (runtimes, variables, mounts, ...). Each row is rendered by the caller. */
import type { ReactNode } from 'react';

interface Props<T> {
  items: T[];
  onChange: (items: T[]) => void;
  /** A blank row, used when the user presses "Add". */
  blank: () => T;
  addLabel: string;
  children: (item: T, update: (changes: Partial<T>) => void) => ReactNode;
}

export function ListEditor<T>({ items, onChange, blank, addLabel, children }: Props<T>) {
  const updateAt = (index: number, changes: Partial<T>) => onChange(items.map((item, at) => (at === index ? { ...item, ...changes } : item)));
  const removeAt = (index: number) => onChange(items.filter((_, at) => at !== index));

  return (
    <div className="list-editor">
      {items.map((item, index) => (
        <div className="list-row" key={index}>
          {children(item, (changes) => updateAt(index, changes))}
          <button type="button" className="ghost danger" onClick={() => removeAt(index)} aria-label="Remove">
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="ghost" onClick={() => onChange([...items, blank()])}>
        + {addLabel}
      </button>
    </div>
  );
}
