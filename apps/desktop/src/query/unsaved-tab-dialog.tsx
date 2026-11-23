import { Modal, closeDialogOf } from '../servers/modal';
import classes from '../servers/servers.module.css';
import { useQueryTabStore } from '../store/query-tabs';
import { saveTab } from './tab-files';

const rolled_back = { open: 'Its open transaction is rolled back too.', failed: 'Its failed transaction is rolled back too.' } as const;

export function UnsavedTabDialog({ model }: { model: { tab_id: string; title: string; transaction: 'open' | 'failed' | null } }) {
  return (
    <Modal model={{ title: `Save changes to ${model.title}?`, title_id: 'unsaved-tab-title' }}>
      <div className={classes.modalBody}>
        <p>Your changes are lost if you don't save them.{model.transaction && ` ${rolled_back[model.transaction]}`}</p>
      </div>
      <div className={classes.modalFooter}>
        <span className={classes.spacer} />
        <button type="button" className={classes.button} onClick={(event) => closeDialogOf(event.currentTarget)}>
          Cancel
        </button>
        <button
          type="button"
          className={classes.button}
          onClick={(event) => {
            closeDialogOf(event.currentTarget);
            useQueryTabStore.getState().closeTab(model.tab_id);
          }}
        >
          Don't save
        </button>
        <button
          type="button"
          className={`${classes.button} ${classes.primary}`}
          onClick={(event) => {
            closeDialogOf(event.currentTarget);
            void saveTab(model.tab_id, { then_close: true });
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}
