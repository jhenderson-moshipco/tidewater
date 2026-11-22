import { Modal, closeDialogOf } from '../servers/modal';
import classes from '../servers/servers.module.css';
import { useSettingsStore } from '../store/settings';

export function SettingsDialog() {
  const key_storage = useSettingsStore((state) => state.key_storage);
  const busy = useSettingsStore((state) => state.busy);
  const error = useSettingsStore((state) => state.error);
  const notice = useSettingsStore((state) => state.notice);

  return (
    <Modal model={{ title: 'Settings', title_id: 'settings-title' }}>
      <div className={classes.modalBody}>
        <fieldset className={classes.fieldset}>
          <legend className={classes.sectionTitle}>Saved servers</legend>
          <label className={classes.check}>
            <input
              type="checkbox"
              aria-describedby="key-storage-hint"
              checked={key_storage === 'keychain'}
              disabled={key_storage === null || busy}
              onChange={(event) => void useSettingsStore.getState().setKeyStorage(event.currentTarget.checked ? 'keychain' : 'file')}
            />
            Keep the encryption key in the system keychain
          </label>
          <p id="key-storage-hint" className={classes.hint}>
            Off, the key is kept in a file only your user account can read. On, the system keychain keeps it and may ask for your
            password when Tidewater starts.
          </p>
        </fieldset>
        <p role="status" className="visually-hidden">
          {notice}
        </p>
        {error && (
          <p role="alert" className={classes.error}>
            {error}
          </p>
        )}
      </div>
      <div className={classes.modalFooter}>
        <span className={classes.spacer} />
        <button type="button" className={classes.button} onClick={(event) => closeDialogOf(event.currentTarget)}>
          Done
        </button>
      </div>
    </Modal>
  );
}
