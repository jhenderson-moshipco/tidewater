import { DialogHost } from '../servers/server-dialogs';
import { useWorkspaceStore } from '../store/workspace';
import { ActivityBar } from './activity-bar';
import { EditorArea } from './editor-area';
import { Sidebar } from './sidebar';
import { StatusBar } from './status-bar';
import classes from './shell.module.css';

export function Workspace() {
  const sidebar_open = useWorkspaceStore((state) => state.sidebar_open);

  return (
    <div className={classes.window}>
      <div className={classes.body}>
        <ActivityBar />
        {sidebar_open && <Sidebar />}
        <EditorArea />
      </div>
      <StatusBar />
      <DialogHost />
    </div>
  );
}
