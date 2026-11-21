import { useWorkspaceStore } from '../store/workspace';
import classes from './shell.module.css';
import { workspace_views } from './views';

export function ActivityBar() {
  const active_view = useWorkspaceStore((state) => state.active_view);
  const sidebar_open = useWorkspaceStore((state) => state.sidebar_open);
  const selectView = useWorkspaceStore((state) => state.selectView);

  return (
    <nav aria-label="Views" className={classes.activityBar}>
      {workspace_views.map((definition) => {
        const ViewIcon = definition.icon;
        return (
          <button
            key={definition.view}
            type="button"
            aria-label={definition.label}
            aria-pressed={sidebar_open && active_view === definition.view}
            title={definition.label}
            className={classes.activityButton}
            onClick={() => selectView(definition.view)}
          >
            <ViewIcon size={20} stroke={1.75} aria-hidden />
          </button>
        );
      })}
    </nav>
  );
}
