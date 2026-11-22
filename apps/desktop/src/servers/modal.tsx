import type { ReactNode } from 'react';
import { restoreFocusIfLost } from '../shell/focus';
import { useDialogStore } from '../store/dialogs';
import classes from './servers.module.css';

export type ModalModel = {
  title: string;
  title_id: string;
};

function showModal(element: HTMLDialogElement | null): void {
  if (element && !element.open) element.showModal();
}

/** Closes the dialog that contains `element`, so the browser returns focus to whatever opened it. */
export function closeDialogOf(element: Element): void {
  element.closest('dialog')?.close();
}

export function Modal({ model, children }: { model: ModalModel; children: ReactNode }) {
  const close = useDialogStore((state) => state.close);
  const closed = () => {
    close();
    restoreFocusIfLost();
  };

  return (
    <dialog ref={showModal} aria-labelledby={model.title_id} className={classes.modal} onClose={closed}>
      <h2 id={model.title_id} className={classes.modalTitle}>
        {model.title}
      </h2>
      {children}
    </dialog>
  );
}
