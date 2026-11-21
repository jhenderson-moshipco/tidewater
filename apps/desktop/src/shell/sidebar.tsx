import { useWorkspaceStore } from '../store/workspace';
import classes from './shell.module.css';
import { findView } from './views';

export function Sidebar() {
  const active_view = useWorkspaceStore((state) => state.active_view);
  const definition = findView(active_view);

  return (
    <aside aria-labelledby="sidebar-title" className={classes.sidebar}>
      <h2 id="sidebar-title" className={classes.sidebarHeader}>
        {definition.title}
      </h2>
      <p className={classes.sidebarEmpty}>{definition.empty}</p>
    </aside>
  );
}
