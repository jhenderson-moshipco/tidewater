import {
  IconChevronDown,
  IconChevronRight,
  IconFolderPlus,
  IconPencil,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import type { ServerGroup, ServerSummary } from '../generated/servers';
import { useDialogStore } from '../store/dialogs';
import { useExplorerStore } from '../store/explorer';
import { useServerStore, type ConnectionState } from '../store/servers';
import { environmentLabel } from './connection-form';
import { LockedPanel, PassphrasePanel } from './store-panels';
import classes from './servers.module.css';

const state_labels = {
  idle: 'not connected',
  connecting: 'connecting',
  connected: 'connected',
  failed: 'connection failed',
} as const;

function ServerRow({ model }: { model: { server: ServerSummary; grouped: boolean } }) {
  const { server, grouped } = model;
  const connection: ConnectionState | undefined = useServerStore((state) => state.connections[server.id]);
  const state = connection?.status ?? 'idle';
  const live = state === 'connected' || state === 'connecting';
  const toggle = () => {
    const servers = useServerStore.getState();
    void (live ? servers.disconnect(server.id) : servers.connect(server.id));
  };

  return (
    <li>
      <div className={classes.server} data-grouped={grouped}>
        <span aria-hidden className={classes.dot} data-state={state} />
        <span className={classes.serverName}>
          {server.name}
          <span className="visually-hidden">, {state_labels[state]}</span>
        </span>
        <span className={classes.badge} data-environment={server.environment}>
          {environmentLabel(server.environment)}
        </span>
        <button
          type="button"
          className={classes.iconButton}
          aria-label={`${live ? 'Disconnect' : 'Connect'} ${server.name}`}
          title={live ? 'Disconnect' : 'Connect'}
          disabled={state === 'connecting'}
          onClick={toggle}
        >
          {live ? <IconPlayerStop size={14} aria-hidden /> : <IconPlayerPlay size={14} aria-hidden />}
        </button>
        <button
          type="button"
          className={classes.iconButton}
          aria-label={`Edit ${server.name}`}
          title="Edit"
          onClick={() => useDialogStore.getState().openConnection(server)}
        >
          <IconPencil size={14} aria-hidden />
        </button>
        <button
          type="button"
          className={classes.iconButton}
          aria-label={`Delete ${server.name}`}
          title="Delete"
          onClick={() => useDialogStore.getState().show({ kind: 'delete-server', server })}
        >
          <IconTrash size={14} aria-hidden />
        </button>
      </div>
      {connection?.status === 'failed' && (
        <p role="alert" className={classes.serverError}>
          {connection.message}
        </p>
      )}
    </li>
  );
}

function GroupSection({ model }: { model: { group: ServerGroup; servers: Array<ServerSummary> } }) {
  const { group, servers } = model;
  const collapsed = useExplorerStore((state) => state.collapsed_groups[group.id] === true);
  const Chevron = collapsed ? IconChevronRight : IconChevronDown;
  const list_id = `group-${group.id}-servers`;

  return (
    <li>
      <div className={classes.groupHeader}>
        <button
          type="button"
          className={classes.groupToggle}
          aria-expanded={!collapsed}
          aria-controls={list_id}
          onClick={() => useExplorerStore.getState().toggleGroup(group.id)}
        >
          <Chevron size={12} aria-hidden />
          {group.name}
          <span className={classes.groupCount}>
            {servers.length}
            <span className="visually-hidden">{servers.length === 1 ? ' server' : ' servers'}</span>
          </span>
        </button>
        <button
          type="button"
          className={classes.iconButton}
          aria-label={`Rename ${group.name}`}
          title="Rename"
          onClick={() => useDialogStore.getState().show({ kind: 'group', editing: group })}
        >
          <IconPencil size={14} aria-hidden />
        </button>
        <button
          type="button"
          className={classes.iconButton}
          aria-label={`Delete ${group.name}`}
          title="Delete group"
          onClick={() => useDialogStore.getState().show({ kind: 'delete-group', group, server_count: servers.length })}
        >
          <IconTrash size={14} aria-hidden />
        </button>
      </div>
      {!collapsed && (
        <ul id={list_id} aria-label={group.name} className={classes.list}>
          {servers.map((server) => (
            <ServerRow key={server.id} model={{ server, grouped: true }} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function ExplorerActions() {
  const unlocked = useServerStore((state) => state.store?.status === 'unlocked');
  if (!unlocked) return null;

  return (
    <>
      <button
        type="button"
        className={classes.iconButton}
        aria-label="New connection"
        title="New connection"
        onClick={() => useDialogStore.getState().openConnection(null)}
      >
        <IconPlus size={15} aria-hidden />
      </button>
      <button
        type="button"
        className={classes.iconButton}
        aria-label="New group"
        title="New group"
        onClick={() => useDialogStore.getState().show({ kind: 'group', editing: null })}
      >
        <IconFolderPlus size={15} aria-hidden />
      </button>
    </>
  );
}

export function Explorer() {
  const status = useServerStore((state) => state.store?.status);
  const groups = useServerStore((state) => state.groups);
  const servers = useServerStore((state) => state.servers);

  if (status === 'locked') return <LockedPanel />;
  if (status === 'needs_passphrase') return <PassphrasePanel />;
  if (status !== 'unlocked') return null;

  if (groups.length === 0 && servers.length === 0) {
    return (
      <div className={classes.panel}>
        <p className={classes.muted}>No servers yet.</p>
        <button type="button" className={`${classes.button} ${classes.primary}`} onClick={() => useDialogStore.getState().openConnection(null)}>
          New connection
        </button>
      </div>
    );
  }

  const ungrouped = servers.filter((server) => server.group_id === null);

  return (
    <div className={classes.explorer}>
      <ul aria-label="Servers" className={classes.list}>
        {groups.map((group) => (
          <GroupSection key={group.id} model={{ group, servers: servers.filter((server) => server.group_id === group.id) }} />
        ))}
        {ungrouped.map((server) => (
          <ServerRow key={server.id} model={{ server, grouped: false }} />
        ))}
      </ul>
    </div>
  );
}
