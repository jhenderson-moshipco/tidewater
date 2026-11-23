import { IconLock } from '@tabler/icons-react';
import { useState, type FormEvent } from 'react';
import { messageOf } from '../api/errors';
import { restoreFocusIfLost } from '../shell/focus';
import { useDialogStore } from '../store/dialogs';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';
import { fieldText } from '../utils/forms';
import classes from './servers.module.css';

export function LockedPanel() {
  const reason = useServerStore((state) => state.store?.reason ?? null);

  return (
    <div className={classes.panel}>
      <h3 className={classes.check}>
        <IconLock size={16} aria-hidden />
        Saved servers are locked
      </h3>
      {reason && <p className={classes.muted}>{reason}</p>}
      <button type="button" className={classes.button} onClick={() => useDialogStore.getState().show({ kind: 'start-fresh' })}>
        Start fresh
      </button>
    </div>
  );
}

type Attempt = { busy: boolean; error: string | null };

export function PassphrasePanel() {
  const has_saved_file = useServerStore((state) => state.store?.has_saved_file === true);
  const [attempt, setAttempt] = useState<Attempt>({ busy: false, error: null });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const passphrase = fieldText(new FormData(event.currentTarget), 'passphrase');
    setAttempt({ busy: true, error: null });
    try {
      await useServerStore.getState().unlock(passphrase);
      void useTreeStore.getState().reopen();
      restoreFocusIfLost();
    } catch (error) {
      setAttempt({ busy: false, error: messageOf(error) });
    }
  };

  return (
    <form className={classes.panel} aria-labelledby="passphrase-title" onSubmit={(event) => void submit(event)}>
      <h3 id="passphrase-title" className={classes.check}>
        <IconLock size={16} aria-hidden />
        {has_saved_file ? 'Unlock saved servers' : 'Set a passphrase'}
      </h3>
      {!has_saved_file && <p className={classes.muted}>This system has no keychain, so saved servers are encrypted with a passphrase you choose.</p>}
      <label className={classes.field}>
        <span className={classes.label}>Passphrase</span>
        <input name="passphrase" type="password" className={classes.input} autoComplete="current-password" required />
      </label>
      {attempt.error && (
        <p role="alert" className={classes.error}>
          {attempt.error}
        </p>
      )}
      <button type="submit" className={`${classes.button} ${classes.primary}`} disabled={attempt.busy}>
        {has_saved_file ? 'Unlock' : 'Set passphrase'}
      </button>
    </form>
  );
}
