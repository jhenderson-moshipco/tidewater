import mark_on_dark from '../../../../assets/icons/svg/mark-on-dark.svg';
import mark_on_light from '../../../../assets/icons/svg/mark-on-light.svg';
import { useServerStore } from '../store/servers';
import { Workspace } from './workspace';
import classes from './shell.module.css';

function StartupScreen() {
  return (
    <div className={classes.startup}>
      <img className="only-dark" src={mark_on_dark} alt="" width={96} height={96} />
      <img className="only-light" src={mark_on_light} alt="" width={96} height={96} />
      <h1 className={classes.emptyTitle}>Tidewater</h1>
      <span aria-hidden="true" className={classes.spinner} />
      <p role="status" className={classes.muted}>
        Starting…
      </p>
    </div>
  );
}

/** The startup screen until the saved servers are loaded, then the workspace. */
export function App() {
  const booted = useServerStore((state) => state.booted);
  return booted ? <Workspace /> : <StartupScreen />;
}
