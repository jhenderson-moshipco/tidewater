import type { ChangeEvent, FormEvent } from 'react';
import { Modal, closeDialogOf } from '../servers/modal';
import server_classes from '../servers/servers.module.css';
import { environmentLabel } from '../servers/connection-form';
import { useQueryTabStore, type RunMode } from '../store/query-tabs';
import type { ServerSummary } from '../generated/servers';
import { useServerStore } from '../store/servers';
import { fieldText } from '../utils/forms';

export function ConnectionPicker({ model }: { model: { tab_id: string; then_run: RunMode | null } }) {
  const servers = useServerStore((state) => state.servers);
  const current = useQueryTabStore((state) => state.tabs[model.tab_id]?.connection ?? null);
  const initial = servers.find((server) => server.id === current?.server_id) ?? servers[0];

  const serverChanged = (event: ChangeEvent<HTMLSelectElement>) => {
    const select = event.currentTarget;
    const database = (select.form as HTMLFormElement).elements.namedItem('database') as HTMLInputElement;
    database.value = (servers[select.selectedIndex] as ServerSummary).database;
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const tabs = useQueryTabStore.getState();
    tabs.setConnection(model.tab_id, { server_id: fieldText(data, 'server_id'), database: fieldText(data, 'database').trim() });
    closeDialogOf(event.currentTarget);
    if (model.then_run) void tabs.run(model.tab_id, model.then_run);
  };

  return (
    <Modal model={{ title: 'Choose a connection', title_id: 'connection-picker-title' }}>
      {initial ? (
        <form onSubmit={submit}>
          <div className={server_classes.modalBody}>
            <label className={server_classes.field}>
              <span className={server_classes.label}>Server</span>
              <select name="server_id" className={server_classes.input} defaultValue={initial.id} onChange={serverChanged}>
                {servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.name} ({environmentLabel(server.environment)})
                  </option>
                ))}
              </select>
            </label>
            <label className={server_classes.field}>
              <span className={server_classes.label}>Database</span>
              <input
                name="database"
                className={server_classes.input}
                defaultValue={current?.server_id === initial.id ? current.database : initial.database}
                required
              />
            </label>
          </div>
          <div className={server_classes.modalFooter}>
            <span className={server_classes.spacer} />
            <button type="button" className={server_classes.button} onClick={(event) => closeDialogOf(event.currentTarget)}>
              Cancel
            </button>
            <button type="submit" className={`${server_classes.button} ${server_classes.primary}`}>
              {model.then_run ? 'Use and run' : 'Use connection'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className={server_classes.modalBody}>
            <p>No saved servers yet. Add one with New connection.</p>
          </div>
          <div className={server_classes.modalFooter}>
            <span className={server_classes.spacer} />
            <button type="button" className={server_classes.button} onClick={(event) => closeDialogOf(event.currentTarget)}>
              Close
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
