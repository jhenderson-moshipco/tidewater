import { IconChevronDown, IconLock, IconPlayerPlay } from '@tabler/icons-react';
import server_classes from '../servers/servers.module.css';
import { environmentLabel } from '../servers/connection-form';
import { useDialogStore } from '../store/dialogs';
import { useQueryTabStore } from '../store/query-tabs';
import { useServerStore } from '../store/servers';
import classes from './query.module.css';

export function QueryToolbar({ tab_id }: { tab_id: string }) {
  const connection = useQueryTabStore((state) => state.tabs[tab_id]?.connection ?? null);
  const status = useQueryTabStore((state) => state.tabs[tab_id]?.status ?? 'idle');
  const path = useQueryTabStore((state) => state.tabs[tab_id]?.file?.path ?? null);
  const server = useServerStore((state) => state.servers.find((candidate) => candidate.id === connection?.server_id));
  const tabs = () => useQueryTabStore.getState();
  const pick = () => useDialogStore.getState().show({ kind: 'pick-connection', tab_id, then_run: null });
  const timeout_ms = server?.session.statement_timeout_ms ?? null;
  const limits = [server?.session.read_only ? 'Read-only' : null, timeout_ms === null ? null : `timeout ${timeout_ms / 1000} s`].filter(Boolean);

  return (
    <div className={classes.toolbar}>
      {server && connection ? (
        <button
          type="button"
          aria-label={`Connection: ${server.name}, database ${connection.database}. Change connection`}
          className={classes.connectionButton}
          onClick={pick}
        >
          <span className={server_classes.badge} data-environment={server.environment}>
            {environmentLabel(server.environment)}
          </span>
          {server.name}
          <span className={classes.muted}>/ {connection.database}</span>
          <IconChevronDown size={12} aria-hidden="true" />
        </button>
      ) : (
        <button type="button" className={classes.connectionButton} onClick={pick}>
          Choose a connection
          <IconChevronDown size={12} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        aria-keyshortcuts="Meta+Enter"
        className={`${server_classes.button} ${server_classes.primary} ${classes.toolbarButton}`}
        disabled={status !== 'idle'}
        onClick={() => void tabs().run(tab_id, 'statement')}
      >
        {status === 'running' ? (
          <>
            <span aria-hidden="true" className="spinner" />
            Running…
          </>
        ) : (
          <>
            <IconPlayerPlay size={12} aria-hidden="true" />
            Run <span className={classes.shortcut}>⌘↵</span>
          </>
        )}
      </button>
      <button
        type="button"
        aria-keyshortcuts="Meta+Shift+Enter"
        className={`${server_classes.button} ${classes.toolbarButton}`}
        disabled={status !== 'idle'}
        onClick={() => void tabs().run(tab_id, 'all')}
      >
        Run all
      </button>
      <button
        type="button"
        aria-keyshortcuts="Meta+."
        className={`${server_classes.button} ${classes.toolbarButton}`}
        disabled={status !== 'running'}
        onClick={() => void tabs().cancel(tab_id)}
      >
        Cancel
      </button>
      <span className={server_classes.spacer} />
      {path && <span className={classes.filePath}>{path}</span>}
      {limits.length > 0 && (
        <span className={classes.limits}>
          <IconLock size={13} aria-hidden="true" />
          {limits.join(' · ')}
        </span>
      )}
    </div>
  );
}
