import { IconEye, IconEyeOff, IconFolderPlus, IconPlus } from '@tabler/icons-react';
import { useDialogStore } from '../store/dialogs';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';
import { ServerTree } from './server-tree';
import { LockedPanel, PassphrasePanel } from './store-panels';
import classes from './servers.module.css';

export function ExplorerActions() {
  const unlocked = useServerStore((state) => state.store?.status === 'unlocked');
  const show_system = useTreeStore((state) => state.show_system);
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
      <button
        type="button"
        className={classes.iconButton}
        aria-label="Show system objects"
        aria-pressed={show_system}
        title="Show system objects"
        onClick={() => useTreeStore.getState().toggleSystem()}
      >
        {show_system ? <IconEye size={15} aria-hidden /> : <IconEyeOff size={15} aria-hidden />}
      </button>
    </>
  );
}

export function Explorer() {
  const status = useServerStore((state) => state.store?.status);
  const is_empty = useServerStore((state) => state.groups.length === 0 && state.servers.length === 0);

  if (status === 'locked') return <LockedPanel />;
  if (status === 'needs_passphrase') return <PassphrasePanel />;
  if (status !== 'unlocked') return null;

  if (is_empty) {
    return (
      <div className={classes.panel}>
        <p className={classes.muted}>No servers yet.</p>
        <button type="button" className={`${classes.button} ${classes.primary}`} onClick={() => useDialogStore.getState().openConnection(null)}>
          New connection
        </button>
      </div>
    );
  }

  return <ServerTree />;
}
