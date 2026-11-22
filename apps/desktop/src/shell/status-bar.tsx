import { transaction_labels } from '../query/describe';
import { lineColumn } from '../query/statements';
import { useQueryTabStore } from '../store/query-tabs';
import { useServerStore } from '../store/servers';
import classes from './shell.module.css';

function ActiveQuery() {
  const tab = useQueryTabStore((state) => (state.active_id ? state.tabs[state.active_id] : undefined));
  const server_name = useServerStore((state) => state.servers.find((server) => server.id === tab?.connection?.server_id)?.name);
  if (!tab?.connection || !server_name) return null;
  const { line, column } = lineColumn(tab.text, tab.selection.to);
  const transaction = transaction_labels[tab.transaction ?? 'idle'];

  return (
    <>
      <span>
        {server_name} · {tab.connection.database} · {transaction}
      </span>
      <span className={classes.statusSpacer} />
      <span>
        Ln {line}, Col {column}
      </span>
    </>
  );
}

export function StatusBar() {
  const connected = useServerStore(
    (state) => Object.values(state.connections).filter((connection) => connection.status === 'connected').length,
  );
  const label = connected === 0 ? 'No connection' : connected === 1 ? '1 connection' : `${connected} connections`;

  return (
    <footer className={classes.statusBar}>
      <span role="status">{label}</span>
      <ActiveQuery />
    </footer>
  );
}
