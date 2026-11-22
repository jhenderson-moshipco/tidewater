import type { FormEvent } from 'react';
import { messageOf } from '../api/errors';
import type { ServerGroup, ServerSummary } from '../generated/servers';
import { useDialogStore } from '../store/dialogs';
import { useServerStore } from '../store/servers';
import { fieldText } from '../utils/forms';
import { ConnectionDialog } from './connection-dialog';
import { Modal, closeDialogOf } from './modal';
import classes from './servers.module.css';

async function runAndClose(element: Element, action: () => Promise<unknown>): Promise<void> {
  const dialogs = useDialogStore.getState();
  dialogs.setBusy('saving');
  dialogs.setError(null);
  try {
    await action();
    closeDialogOf(element);
  } catch (error) {
    useDialogStore.getState().setError(messageOf(error));
    useDialogStore.getState().setBusy(null);
  }
}

function Footer({ model }: { model: { confirm_label: string; danger: boolean } }) {
  const busy = useDialogStore((state) => state.busy);
  const error = useDialogStore((state) => state.error);
  const confirm_class = `${classes.button} ${model.danger ? classes.danger : classes.primary}`;

  return (
    <>
      {error && (
        <div className={classes.modalBody}>
          <p role="alert" className={classes.error}>
            {error}
          </p>
        </div>
      )}
      <div className={classes.modalFooter}>
        <span className={classes.spacer} />
        <button type="button" className={classes.button} onClick={(event) => closeDialogOf(event.currentTarget)}>
          Cancel
        </button>
        <button type="submit" className={confirm_class} disabled={busy !== null}>
          {model.confirm_label}
        </button>
      </div>
    </>
  );
}

function GroupDialog({ editing }: { editing: ServerGroup | null }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = fieldText(new FormData(form), 'name');
    void runAndClose(form, () => useServerStore.getState().saveGroup({ id: editing?.id ?? null, name }));
  };

  return (
    <Modal model={{ title: editing ? 'Rename group' : 'New group', title_id: 'group-dialog-title' }}>
      <form onSubmit={submit}>
        <div className={classes.modalBody}>
          <label className={classes.field}>
            <span className={classes.label}>Name</span>
            <input name="name" className={classes.input} defaultValue={editing?.name ?? ''} required />
          </label>
        </div>
        <Footer model={{ confirm_label: 'Save', danger: false }} />
      </form>
    </Modal>
  );
}

function ConfirmDialog({ model }: { model: { title: string; message: string; confirm_label: string; action: () => Promise<unknown> } }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runAndClose(event.currentTarget, model.action);
  };

  return (
    <Modal model={{ title: model.title, title_id: 'confirm-dialog-title' }}>
      <form onSubmit={submit}>
        <div className={classes.modalBody}>
          <p>{model.message}</p>
        </div>
        <Footer model={{ confirm_label: model.confirm_label, danger: true }} />
      </form>
    </Modal>
  );
}

function deleteServerModel(server: ServerSummary) {
  return {
    title: `Delete ${server.name}?`,
    message: server.has_password ? 'Its saved settings and password are removed.' : 'Its saved settings are removed.',
    confirm_label: 'Delete',
    action: () => useServerStore.getState().deleteServer(server.id),
  };
}

function deleteGroupModel(group: ServerGroup, server_count: number) {
  const servers = server_count === 1 ? '1 server stays' : `${server_count} servers stay`;
  return {
    title: `Delete ${group.name}?`,
    message: server_count === 0 ? 'The group is empty.' : `Its ${servers} saved, without a group.`,
    confirm_label: 'Delete group',
    action: () => useServerStore.getState().deleteGroup(group.id),
  };
}

const start_fresh_model = {
  title: 'Start with no saved servers?',
  message: 'The locked file is kept next to the new one, renamed with the date, in case its key turns up.',
  confirm_label: 'Start fresh',
  action: () => useServerStore.getState().startFresh(),
};

export function DialogHost() {
  const open = useDialogStore((state) => state.open);
  if (!open) return null;

  switch (open.kind) {
    case 'connection':
      return <ConnectionDialog editing={open.editing} />;
    case 'group':
      return <GroupDialog editing={open.editing} />;
    case 'delete-server':
      return <ConfirmDialog model={deleteServerModel(open.server)} />;
    case 'delete-group':
      return <ConfirmDialog model={deleteGroupModel(open.group, open.server_count)} />;
    case 'start-fresh':
      return <ConfirmDialog model={start_fresh_model} />;
  }
}
