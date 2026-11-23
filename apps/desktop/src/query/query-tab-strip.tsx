import { IconPlus, IconX } from '@tabler/icons-react';
import type { KeyboardEvent } from 'react';
import server_classes from '../servers/servers.module.css';
import { environmentLabel } from '../servers/connection-form';
import { restoreFocusIfLost } from '../shell/focus';
import { useQueryTabStore } from '../store/query-tabs';
import { useServerStore } from '../store/servers';
import { openNewTab } from './open-tab';
import classes from './query.module.css';

export const query_panel_id = 'query-tab-panel';

export function queryTabId(id: string): string {
  return `${id}-tab`;
}

function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
  const { order, selectTab, requestClose } = useQueryTabStore.getState();
  if (event.key === 'Delete') {
    event.preventDefault();
    requestClose(order[index] as string);
    restoreFocusIfLost();
    return;
  }
  const keys: Readonly<Record<string, number>> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: order.length - 1 };
  const target = keys[event.key];
  if (target === undefined) return;
  event.preventDefault();
  const id = order[(target + order.length) % order.length] as string;
  selectTab(id);
  document.getElementById(queryTabId(id))?.focus();
}

function TabButton({ model }: { model: { id: string; index: number; active: boolean } }) {
  const title = useQueryTabStore((state) => state.tabs[model.id]?.title ?? '');
  const server_id = useQueryTabStore((state) => state.tabs[model.id]?.connection?.server_id ?? null);
  const environment = useServerStore((state) => state.servers.find((server) => server.id === server_id)?.environment ?? null);

  return (
    <div className={classes.tabItem} data-active={model.active}>
      <button
        type="button"
        role="tab"
        id={queryTabId(model.id)}
        aria-selected={model.active}
        aria-controls={query_panel_id}
        aria-keyshortcuts="Delete"
        tabIndex={model.active ? 0 : -1}
        className={classes.tab}
        onClick={() => useQueryTabStore.getState().selectTab(model.id)}
        onKeyDown={(event) => moveFocus(event, model.index)}
      >
        {title}
        {environment && (
          <span className={server_classes.badge} data-environment={environment}>
            {environmentLabel(environment)}
          </span>
        )}
      </button>
      <button
        type="button"
        aria-label={`Close ${title}`}
        title={`Close ${title}`}
        tabIndex={model.active ? 0 : -1}
        className={server_classes.iconButton}
        onClick={() => {
          useQueryTabStore.getState().requestClose(model.id);
          restoreFocusIfLost();
        }}
      >
        <IconX size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function QueryTabStrip() {
  const order = useQueryTabStore((state) => state.order);
  const active_id = useQueryTabStore((state) => state.active_id);

  return (
    <div className={classes.tabStrip}>
      <div role="tablist" aria-label="Query tabs" className={classes.tabs}>
        {order.map((id, index) => (
          <TabButton key={id} model={{ id, index, active: id === active_id }} />
        ))}
      </div>
      <button type="button" aria-label="New query tab" title="New query tab (⌘T)" className={server_classes.iconButton} onClick={openNewTab}>
        <IconPlus size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
