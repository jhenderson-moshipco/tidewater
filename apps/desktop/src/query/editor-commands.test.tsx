import { searchPanelOpen } from '@codemirror/search';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Workspace } from '../shell/workspace';
import { useObjectEditorStore } from '../store/object-editors';
import { useQueryTabStore } from '../store/query-tabs';
import { useServerStore } from '../store/servers';
import { changePlan, editor_basics, mockCommands, objectRef, routineDefinition, server, unlocked } from '../testing/backend';
import { renderWithUser } from '../testing/render';
import { findInEditor, formatEditor, formatSql } from './editor-commands';
import { insertName } from './tree-queries';

const tabs = () => useQueryTabStore.getState();

function editorOf(name: string): EditorView {
  return EditorView.findFromDOM(screen.getByRole('textbox', { name })) as EditorView;
}

function openQuery(text: string) {
  useServerStore.setState({ store: unlocked, servers: [server()] });
  const id = tabs().openTab({ server_id: 'orders-dev', database: 'orders' }, { text });
  renderWithUser(<Workspace />);
  return { id, view: editorOf(`SQL editor, ${tabs().tabs[id]?.title}`) };
}

describe('formatting SQL', () => {
  it('lays a statement out one clause per line with keywords in capitals', () => {
    expect(formatSql('select id, total from orders where total > 0')).toBe('SELECT\n  id,\n  total\nFROM\n  orders\nWHERE\n  total > 0');
  });

  it('formats the whole tab when nothing is selected, or only the selection, and says so', () => {
    const { id, view } = openQuery('select 1;\nselect   2');

    act(() => formatEditor());
    expect([tabs().tabs[id]?.text, tabs().announcement]).toEqual(['SELECT\n  1;\n\nSELECT\n  2', 'Formatted the SQL.']);
    act(() => view.dispatch({ selection: { anchor: 0, head: 11 } }));
    act(() => view.dispatch({ changes: { from: 0, to: 11, insert: 'select a' }, selection: { anchor: 0, head: 8 } }));
    act(() => void runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'ƒ', code: 'KeyF', keyCode: 70, shiftKey: true, altKey: true }), 'editor'));

    expect([tabs().tabs[id]?.text.startsWith('SELECT\n  a'), tabs().announcement]).toEqual([true, 'Formatted the selection.']);
  });

  it("leaves SQL it can't read alone and says why", () => {
    const { id } = openQuery("select 'unclosed");

    act(() => formatEditor());

    expect(tabs().tabs[id]?.text).toBe("select 'unclosed");
    expect(tabs().announcement).toMatch(/^The SQL couldn't be formatted: /);
  });
});

describe('finding in SQL', () => {
  it('opens find and replace in the active query tab, or in the field that has focus', async () => {
    const { view } = openQuery('SELECT 1');
    act(() => findInEditor());
    expect(searchPanelOpen(view.state)).toBe(true);

    mockCommands({
      ...editor_basics,
      list_schemas: () => ['public'],
      object_definition: () => routineDefinition(),
      plan_object_change: () => changePlan(),
    });
    act(() => void useObjectEditorStore.getState().open({ mode: 'edit', server_id: 'orders-dev', database: 'orders', object_type: 'function', object: objectRef({ object_type: 'function' }), schema: null, label: 'f' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Body' })).toBeTruthy());
    const body = editorOf('Body');
    act(() => body.focus());
    act(() => findInEditor());

    expect(searchPanelOpen(body.state)).toBe(true);
  });

  it('does nothing with no editor to find in', () => {
    expect(() => {
      findInEditor();
      formatEditor();
    }).not.toThrow();
  });
});

describe('inserting a name from the tree', () => {
  it('puts the name at the cursor of the query tab that is showing', () => {
    const { id, view } = openQuery('SELECT * FROM ');
    act(() => view.dispatch({ selection: { anchor: 14 } }));

    act(() => insertName({ server_id: 'orders-dev', object: objectRef(), name: 'public.open_orders' }));

    expect([tabs().tabs[id]?.text, tabs().order]).toEqual(['SELECT * FROM public.open_orders', [id]]);
  });
});
