import { ObjectEditorView } from '../objects/object-editor';
import { useObjectEditorStore } from '../store/object-editors';
import { useQueryTabStore } from '../store/query-tabs';
import { QueryTabStrip, query_panel_id, queryTabId } from './query-tab-strip';
import { QueryToolbar } from './query-toolbar';
import { ResultsPanel } from './results-panel';
import { SqlEditor } from './sql-editor';
import classes from './query.module.css';

function QueryTabContent({ tab_id }: { tab_id: string }) {
  const title = useQueryTabStore((state) => state.tabs[tab_id]?.title ?? '');
  return (
    <>
      <QueryToolbar tab_id={tab_id} />
      <div className={classes.editorPane}>
        <SqlEditor key={tab_id} model={{ tab_id, title }} />
      </div>
      <ResultsPanel tab_id={tab_id} />
    </>
  );
}

function ActiveTab({ tab_id }: { tab_id: string }) {
  const is_editor = useObjectEditorStore((state) => state.editors[tab_id] !== undefined);
  return (
    <div role="tabpanel" id={query_panel_id} aria-labelledby={queryTabId(tab_id)} className={classes.tabPanel}>
      {is_editor ? <ObjectEditorView model={{ editor_id: tab_id, title_id: `${tab_id}-heading` }} /> : <QueryTabContent tab_id={tab_id} />}
    </div>
  );
}

/** The query tabs, plus a status region that announces each run's outcome. */
export function QueryArea() {
  const active_id = useQueryTabStore((state) => state.active_id);
  const announcement = useQueryTabStore((state) => state.announcement);

  return (
    <div className={classes.area}>
      <p role="status" className="visually-hidden">
        {announcement}
      </p>
      {active_id && (
        <>
          <QueryTabStrip />
          <ActiveTab key={active_id} tab_id={active_id} />
        </>
      )}
    </div>
  );
}
