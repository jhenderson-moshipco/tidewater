import { useServerStore } from '../store/servers';
import classes from './shell.module.css';

export function StatusBar() {
  const connected = useServerStore(
    (state) => Object.values(state.connections).filter((connection) => connection.status === 'connected').length,
  );
  const label = connected === 0 ? 'No connection' : connected === 1 ? '1 connection' : `${connected} connections`;

  return (
    <footer className={classes.statusBar}>
      <span role="status">{label}</span>
    </footer>
  );
}
