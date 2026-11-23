import { Explorer, ExplorerActions } from '../servers/explorer';
import { useWorkspaceStore } from '../store/workspace';
import classes from './shell.module.css';
import { SidebarResizer } from './sidebar-resizer';
import { findView } from './views';

export function Sidebar() {
  const active_view = useWorkspaceStore((state) => state.active_view);
  const definition = findView(active_view);
  const width = useWorkspaceStore((state) => state.sidebar_width);

  return (
    <aside aria-labelledby="sidebar-title" className={classes.sidebar} style={{ width }}>
      <div className={classes.sidebarHeader}>
        <h2 id="sidebar-title" tabIndex={-1} className={classes.sidebarTitle}>
          {definition.title}
        </h2>
        {active_view === 'explorer' && <ExplorerActions />}
      </div>
      {active_view === 'explorer' ? <Explorer /> : <p className={classes.sidebarEmpty}>{definition.empty}</p>}
      <SidebarResizer />
    </aside>
  );
}
