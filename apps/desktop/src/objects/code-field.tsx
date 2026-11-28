import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { bracketMatching } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { sql_highlighting, sql_theme } from '../query/sql-editor';
import { useObjectEditorStore, type ObjectEditor } from '../store/object-editors';
import classes from './objects.module.css';

export type CodeFieldModel = { editor_id: string; field: 'query' | 'body'; label: string };

/** The draft's text for a view's query or a routine's body, edited with SQL highlighting and line numbers. */
export function CodeField({ model }: { model: CodeFieldModel }) {
  const mount = (element: HTMLDivElement) => {
    const store = useObjectEditorStore.getState;
    const draft = (store().editors[model.editor_id] as ObjectEditor).draft as unknown as Readonly<Record<string, string>>;
    const view = new EditorView({
      parent: element,
      state: EditorState.create({
        doc: draft[model.field],
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          sql({ dialect: PostgreSQL }),
          sql_highlighting,
          sql_theme,
          keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
          search({ top: true }),
          EditorView.contentAttributes.of({ 'aria-label': model.label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) store().patch(model.editor_id, { [model.field]: update.state.doc.toString() });
          }),
        ],
      }),
    });
    return () => view.destroy();
  };

  return <div ref={mount} className={classes.code} />;
}
