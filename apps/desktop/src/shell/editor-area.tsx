import mark_on_dark from '../../../../assets/icons/svg/mark-on-dark.svg';
import mark_on_light from '../../../../assets/icons/svg/mark-on-light.svg';
import { openNewTab } from '../query/open-tab';
import { QueryArea } from '../query/query-area';
import server_classes from '../servers/servers.module.css';
import { useDialogStore } from '../store/dialogs';
import { useQueryTabStore } from '../store/query-tabs';
import { useServerStore } from '../store/servers';
import classes from './shell.module.css';

export function EditorArea() {
  const unlocked = useServerStore((state) => state.store?.status === 'unlocked');
  const has_servers = useServerStore((state) => state.servers.length > 0);
  const has_tabs = useQueryTabStore((state) => state.order.length > 0);

  if (has_tabs) {
    return (
      <main id="workspace-main" tabIndex={-1} className={classes.mainFilled}>
        <QueryArea />
      </main>
    );
  }

  return (
    <main id="workspace-main" tabIndex={-1} className={classes.main}>
      <div className={classes.emptyState}>
        <img className="only-dark" src={mark_on_dark} alt="" width={72} height={72} />
        <img className="only-light" src={mark_on_light} alt="" width={72} height={72} />
        <h1 className={classes.emptyTitle}>Tidewater</h1>
        <p className={classes.muted}>{has_servers ? 'No query tab open.' : 'No connections yet.'}</p>
        {unlocked && has_servers && (
          <button type="button" className={`${server_classes.button} ${server_classes.primary}`} onClick={() => openNewTab()}>
            New query
          </button>
        )}
        {unlocked && (
          <button
            type="button"
            className={has_servers ? server_classes.button : `${server_classes.button} ${server_classes.primary}`}
            onClick={() => useDialogStore.getState().openConnection(null)}
          >
            New connection
          </button>
        )}
      </div>
    </main>
  );
}
