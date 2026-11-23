import { DialogHost } from '../servers/server-dialogs';
import { useObjectEditorStore } from '../store/object-editors';
import { useWorkspaceStore } from '../store/workspace';
import { ActivityBar } from './activity-bar';
import { EditorArea } from './editor-area';
import { Sidebar } from './sidebar';
import { StatusBar } from './status-bar';
import classes from './shell.module.css';

export function Workspace() {
  const sidebar_open = useWorkspaceStore((state) => state.sidebar_open);
  const object_announcement = useObjectEditorStore((state) => state.announcement);

  return (
    <div className={classes.window}>
      <div className={classes.body}>
        <ActivityBar />
        {sidebar_open && <Sidebar />}
        <EditorArea />
      </div>
      <StatusBar />
      <DialogHost />
      <p role="status" className="visually-hidden">
        {object_announcement}
      </p>
    </div>
  );
}
