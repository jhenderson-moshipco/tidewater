import classes from './shell.module.css';

export function StatusBar() {
  return (
    <footer className={classes.statusBar}>
      <span role="status">No connection</span>
    </footer>
  );
}
