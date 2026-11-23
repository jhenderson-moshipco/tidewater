import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { HighlightStyle, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useQueryTabStore, type QueryTab } from '../store/query-tabs';
import classes from './query.module.css';

/** Each tab's editor state while another tab is showing, so its undo history survives a tab switch. */
const saved_states = new Map<string, EditorState>();
const open_views = new Map<string, EditorView>();

const highlight_style = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--tw-syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--tw-syntax-string)' },
  { tag: [tags.function(tags.variableName), tags.standard(tags.name)], color: 'var(--tw-syntax-function)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--tw-syntax-number)' },
  { tag: [tags.lineComment, tags.blockComment], color: 'var(--tw-syntax-comment)', fontStyle: 'italic' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--tw-bg-editor)', color: 'var(--tw-text)' },
  '&.cm-focused': { outline: '2px solid var(--tw-accent)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'var(--tw-font-mono)', fontSize: 'var(--tw-font-size)', lineHeight: '20px' },
  '.cm-content': { caretColor: 'var(--tw-text)' },
  '.cm-cursor': { borderLeftColor: 'var(--tw-text)' },
  '.cm-gutters': { backgroundColor: 'var(--tw-bg-editor)', color: 'var(--tw-text-muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--tw-bg-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--tw-bg-hover)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--tw-selected)' },
});

function extensions(tab_id: string, title: string): Array<Extension> {
  const tabs = () => useQueryTabStore.getState();
  return [
    lineNumbers(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    bracketMatching(),
    sql({ dialect: PostgreSQL }),
    syntaxHighlighting(highlight_style),
    theme,
    keymap.of([
      { key: 'Mod-Enter', run: () => (void tabs().run(tab_id, 'statement'), true) },
      { key: 'Shift-Mod-Enter', run: () => (void tabs().run(tab_id, 'all'), true) },
      { key: 'Mod-.', run: () => (void tabs().cancel(tab_id), true) },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.contentAttributes.of({ 'aria-label': `SQL editor, ${title}` }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) tabs().setText(tab_id, update.state.doc.toString());
      if (update.docChanged || update.selectionSet) {
        const { from, to } = update.state.selection.main;
        tabs().setSelection(tab_id, from, to);
      }
    }),
  ];
}

/** Moves the tab's cursor to `position` and focuses its editor. */
export function revealInEditor(tab_id: string, position: number): void {
  const view = open_views.get(tab_id);
  if (!view) return;
  view.dispatch({ selection: { anchor: Math.min(position, view.state.doc.length) }, scrollIntoView: true });
  view.focus();
}

export function SqlEditor({ model }: { model: { tab_id: string; title: string } }) {
  const mount = (element: HTMLDivElement) => {
    const { text } = useQueryTabStore.getState().tabs[model.tab_id] as QueryTab;
    const state = saved_states.get(model.tab_id) ?? EditorState.create({ doc: text, extensions: extensions(model.tab_id, model.title) });
    const view = new EditorView({ state, parent: element });
    open_views.set(model.tab_id, view);
    return () => {
      open_views.delete(model.tab_id);
      if (useQueryTabStore.getState().tabs[model.tab_id]) saved_states.set(model.tab_id, view.state);
      else saved_states.delete(model.tab_id);
      view.destroy();
    };
  };

  return <div ref={mount} className={classes.editor} />;
}
