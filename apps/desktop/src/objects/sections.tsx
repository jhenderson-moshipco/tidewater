import { useState, type KeyboardEvent, type ReactNode } from 'react';
import classes from './objects.module.css';

export type SectionItem = { key: string; label: string; count?: number; content: ReactNode };

function moveAmong(event: KeyboardEvent<HTMLButtonElement>, index: number, items: ReadonlyArray<SectionItem>, show: (key: string) => void): void {
  const keys: Readonly<Record<string, number>> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: items.length - 1 };
  const target = keys[event.key];
  if (target === undefined) return;
  event.preventDefault();
  const next = (target + items.length) % items.length;
  show((items[next] as SectionItem).key);
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
}

function tabId(id: string, key: string): string {
  return `${id}-section-${key}`;
}

/** The tab buttons, the shown one in the tab order. */
function tabs(model: { id: string; items: ReadonlyArray<SectionItem> }, current: SectionItem, show: (key: string) => void) {
  return model.items.map((item, index) => (
    <button
      key={item.key}
      type="button"
      role="tab"
      id={tabId(model.id, item.key)}
      aria-selected={item === current}
      aria-controls={`${model.id}-section-panel`}
      tabIndex={item === current ? 0 : -1}
      className={classes.section}
      onClick={() => show(item.key)}
      onKeyDown={(event) => moveAmong(event, index, model.items, show)}
    >
      {item.label}
      {item.count !== undefined && <span className={classes.muted}> {item.count}</span>}
    </button>
  ));
}

/** An editor's sections as tabs, one shown at a time, moved between with the arrow keys, Home and End. */
export function Sections({ model }: { model: { id: string; label: string; items: ReadonlyArray<SectionItem> } }) {
  const [shown, setShown] = useState((model.items[0] as SectionItem).key);
  const current = model.items.find((item) => item.key === shown) as SectionItem;

  return (
    <>
      <div role="tablist" aria-label={model.label} className={classes.sections}>
        {tabs(model, current, setShown)}
      </div>
      <div role="tabpanel" id={`${model.id}-section-panel`} aria-labelledby={tabId(model.id, current.key)} className={classes.sectionPanel}>
        {current.content}
      </div>
    </>
  );
}
