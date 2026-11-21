import mark_on_dark from '../../../../assets/icons/svg/mark-on-dark.svg';
import mark_on_light from '../../../../assets/icons/svg/mark-on-light.svg';
import classes from './shell.module.css';

export function EditorArea() {
  return (
    <main className={classes.main}>
      <div className={classes.emptyState}>
        <img className="only-dark" src={mark_on_dark} alt="" width={72} height={72} />
        <img className="only-light" src={mark_on_light} alt="" width={72} height={72} />
        <h1 className={classes.emptyTitle}>Tidewater</h1>
        <p className={classes.muted}>No connections yet.</p>
      </div>
    </main>
  );
}
