import { openSearchPanel } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { format } from 'sql-formatter';
import { messageOf } from '../api/errors';
import { useQueryTabStore } from '../store/query-tabs';
import { editorViewOf } from './sql-editor';

/** The SQL editor that has focus, such as a function body in an object editor, else the active query tab's. */
export function targetEditor(): EditorView | null {
  const focused = document.activeElement?.closest<HTMLElement>('.cm-editor');
  if (focused) return EditorView.findFromDOM(focused);
  const active = useQueryTabStore.getState().active_id;
  return (active && editorViewOf(active)) || null;
}

/** Postgres SQL laid out one clause per line, keywords in capitals. */
export function formatSql(sql: string): string {
  return format(sql, { language: 'postgresql', keywordCase: 'upper', tabWidth: 2 });
}

/** Formats the editor's selection, or all of it when nothing is selected, as one undo step. */
export function formatView(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  const range = from === to ? { from: 0, to: view.state.doc.length } : { from, to };
  const tabs = useQueryTabStore.getState();
  try {
    const formatted = formatSql(view.state.sliceDoc(range.from, range.to));
    view.dispatch({ changes: { ...range, insert: formatted }, selection: { anchor: range.from + formatted.length } });
    tabs.announce(from === to ? 'Formatted the SQL.' : 'Formatted the selection.');
  } catch (error) {
    tabs.announce(`The SQL couldn't be formatted: ${messageOf(error)}`);
  }
}

/** Opens find and replace in the editor that has focus, else the active query tab's. */
export function findInEditor(): void {
  const view = targetEditor();
  if (view) openSearchPanel(view);
}

/** Formats the editor that has focus, else the active query tab's. */
export function formatEditor(): void {
  const view = targetEditor();
  if (view) formatView(view);
}
