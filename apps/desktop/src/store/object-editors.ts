import { create } from 'zustand';
import * as api from '../api/objects';
import { messageOf } from '../api/errors';
import type { ApplyFailure, AvailableExtension, ChangeOptions, ChangePlan, ObjectDefinition, ObjectRef, ObjectType } from '../generated/objects';
import { blankDefinition, capitalized, objectTypeOf, planStatements, qualifiedName, type_labels } from '../objects/describe';
import { restoreFocusIfLost } from '../shell/focus';
import { useDialogStore } from './dialogs';
import { useQueryTabStore } from './query-tabs';
import { useServerStore } from './servers';
import { useTreeStore } from './tree';
import { useWorkspaceStore, type EditorHost } from './workspace';

export type EditorMode = 'create' | 'edit' | 'drop';

export type ObjectEditor = {
  id: string;
  mode: EditorMode;
  host: EditorHost;
  server_id: string;
  database: string;
  object_type: ObjectType;
  /** The object being edited or dropped; `null` for a new one. */
  object: ObjectRef | null;
  /** The tree's name for the object, shown until its definition loads. */
  label: string;
  /** The schemas a new or moved object can go in. */
  schemas: ReadonlyArray<string>;
  /** For an extension's editor, what the server can install. */
  extensions: ReadonlyArray<AvailableExtension>;
  /** For a database's editor, the roles that can own it. */
  roles: ReadonlyArray<string>;
  loading: boolean;
  load_error: string | null;
  /** The definition as it is in the database; `null` for a new object. */
  original: ObjectDefinition | null;
  /** What the editor began with, so it can tell whether anything changed. */
  start: ObjectDefinition | null;
  draft: ObjectDefinition | null;
  options: ChangeOptions;
  /** Whether the SQL preview is catching up with the latest change. */
  planning: boolean;
  plan: ChangePlan | null;
  plan_error: string | null;
  step: 'edit' | 'review';
  /** What the user typed to confirm a change on a PROD server. */
  confirm_name: string;
  applying: boolean;
  failure: ApplyFailure | null;
  apply_error: string | null;
  /** Whether the editor is asking to discard its changes before it closes. */
  confirming_close: boolean;
};

export type EditorRequest = {
  mode: EditorMode;
  /** Where to open it, instead of the place Settings picks. */
  host?: EditorHost;
  server_id: string;
  database: string;
  object_type: ObjectType;
  object: ObjectRef | null;
  /** The schema a new object goes in. */
  schema: string | null;
  label: string;
};

/** How long typing pauses before the SQL preview is worked out again. */
export const plan_delay_ms = 250;

const plan_timers = new Map<string, number>();
const plan_runs = new Map<string, number>();
const openers = new Map<string, Element | null>();

function same(left: ObjectDefinition | null, right: ObjectDefinition | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Whether closing the editor would lose changes not yet applied. */
export function isDirty(editor: ObjectEditor): boolean {
  return editor.mode !== 'drop' && !same(editor.draft, editor.start);
}

export function editorTitle(editor: ObjectEditor): string {
  if (editor.mode === 'create') return `New ${type_labels[editor.object_type]}`;
  const name = editor.original ? qualifiedName(editor.original) : editor.label;
  return editor.mode === 'drop' ? `Drop ${name}?` : name;
}

/** The server's name when a change to it must be confirmed by typing that name, as PROD servers ask. */
export function confirmationName(editor: ObjectEditor): string | null {
  const server = useServerStore.getState().servers.find((candidate) => candidate.id === editor.server_id);
  return server?.environment === 'prod' ? server.name : null;
}

/** Whether the plan is current, has statements, and could run. */
export function canReview(editor: ObjectEditor): boolean {
  return !editor.planning && !editor.applying && editor.plan !== null && planStatements(editor.plan).length > 0;
}

function appliedMessage(editor: ObjectEditor): string {
  const type = type_labels[editor.object_type];
  if (editor.mode === 'create') return `${capitalized(type)} ${qualifiedName(editor.draft as ObjectDefinition)} created.`;
  const name = qualifiedName(editor.original as ObjectDefinition);
  return editor.mode === 'drop' ? `${capitalized(type)} ${name} dropped.` : `Changes to ${name} applied.`;
}

/** Shows an applied change in the tree: a database's listing for most objects, the server's for a database itself. */
function refreshTree(editor: ObjectEditor, closed_database: string | null): Promise<void> {
  const tree = useTreeStore.getState();
  if (editor.object_type === 'database') return tree.refreshServer(editor.server_id, closed_database);
  return tree.refreshDatabase(editor.server_id, editor.database);
}

/** Puts focus back on what opened a dialog editor, such as the tree, once the dialog has gone. */
function returnFocus(id: string): void {
  const opener = openers.get(id);
  openers.delete(id);
  requestAnimationFrame(() => {
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    else restoreFocusIfLost();
  });
}

type ObjectEditorState = {
  editors: Readonly<Record<string, ObjectEditor>>;
  /** The latest sentence for the workspace's object status region. */
  announcement: string;
  open: (request: EditorRequest) => string;
  load: (id: string) => Promise<void>;
  change: (id: string, draft: ObjectDefinition) => void;
  /** Changes some of the draft's fields, by their names in the definition. */
  patch: (id: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void;
  setOptions: (id: string, options: Partial<ChangeOptions>) => void;
  plan: (id: string) => Promise<void>;
  review: (id: string) => void;
  backToEditing: (id: string) => void;
  setConfirmName: (id: string, name: string) => void;
  apply: (id: string) => Promise<void>;
  /** Opens the plan's statements in a new query tab, without running them. */
  copyToTab: (id: string) => void;
  /** Moves a dialog's editor into a tab, keeping its changes. */
  openInTab: (id: string) => void;
  /** Closes the editor, first asking when that would lose changes. */
  requestClose: (id: string) => void;
  keepEditing: (id: string) => void;
  closeEditor: (id: string) => void;
};

export const useObjectEditorStore = create<ObjectEditorState>()((set, get) => {
  const update = (id: string, change: Partial<ObjectEditor>) =>
    set((state) => {
      const editor = state.editors[id];
      return editor ? { editors: { ...state.editors, [id]: { ...editor, ...change } } } : {};
    });

  const schedulePlan = (id: string) => {
    window.clearTimeout(plan_timers.get(id));
    update(id, { planning: true });
    plan_timers.set(id, window.setTimeout(() => void get().plan(id), plan_delay_ms));
  };

  /**
   * After statements past the commit fail, the rest of the change is in the database: the tree shows it, and the editor
   * starts again from the object as it now is, with the failure still showing.
   */
  const keepCommitted = async (id: string, editor: ObjectEditor, failure: ApplyFailure) => {
    update(id, { applying: false, failure, plan: null });
    void refreshTree(editor, (editor.plan as ChangePlan).closes_database);
    if (!editor.object) return;
    try {
      const current = await api.objectDefinition(editor.server_id, editor.object as ObjectRef);
      update(id, { original: current, start: current, draft: current });
    } catch (error) {
      update(id, { apply_error: messageOf(error) });
    }
  };

  /** An editor already showing this object in a tab, so a second Edit switches to it. */
  const openTabFor = (request: EditorRequest) =>
    Object.values(get().editors).find(
      (editor) =>
        editor.host === 'tab' &&
        editor.mode === request.mode &&
        editor.server_id === request.server_id &&
        editor.object !== null &&
        JSON.stringify(editor.object) === JSON.stringify(request.object),
    );

  return {
    editors: {},
    announcement: '',

    open: (request) => {
      const host = request.mode === 'drop' ? 'dialog' : (request.host ?? useWorkspaceStore.getState().object_editor_host);
      const existing = host === 'tab' ? openTabFor(request) : undefined;
      if (existing) {
        useQueryTabStore.getState().selectTab(existing.id);
        return existing.id;
      }
      const id = `editor-${crypto.randomUUID()}`;
      const start = request.mode === 'create' ? blankDefinition(request.object_type, request.schema ?? 'public') : null;
      const editor: ObjectEditor = {
        id,
        mode: request.mode,
        host,
        server_id: request.server_id,
        database: request.database,
        object_type: request.object_type,
        object: request.object,
        label: request.label,
        schemas: request.schema ? [request.schema] : [],
        extensions: [],
        roles: [],
        loading: true,
        load_error: null,
        original: null,
        start,
        draft: start,
        options: { cascade: false, with_data: true, force: false },
        planning: false,
        plan: null,
        plan_error: null,
        step: request.mode === 'drop' ? 'review' : 'edit',
        confirm_name: '',
        applying: false,
        failure: null,
        apply_error: null,
        confirming_close: false,
      };
      openers.set(id, document.activeElement);
      set((state) => ({ editors: { ...state.editors, [id]: editor } }));
      if (host === 'tab') useQueryTabStore.getState().addTab(id);
      else useDialogStore.getState().show({ kind: 'object-editor', editor_id: id });
      void get().load(id);
      return id;
    },

    load: async (id) => {
      const editor = get().editors[id] as ObjectEditor;
      update(id, { loading: true, load_error: null });
      const editing = editor.mode !== 'drop';
      const wants = (type: ObjectType) => editing && editor.object_type === type;
      const wants_schemas = editing && editor.object_type !== 'schema' && editor.object_type !== 'database';
      try {
        const [schemas, extensions, roles, original] = await Promise.all([
          wants_schemas ? api.listSchemas(editor.server_id, editor.database) : editor.schemas,
          wants('extension') ? api.availableExtensions(editor.server_id, editor.database) : editor.extensions,
          wants('database') ? api.listRoles(editor.server_id, editor.database) : editor.roles,
          editor.object ? api.objectDefinition(editor.server_id, editor.object) : null,
        ]);
        update(id, { loading: false, schemas, extensions, roles, ...(original && { original, start: original, draft: original }) });
        if (editor.mode === 'drop') await get().plan(id);
      } catch (error) {
        update(id, { loading: false, load_error: messageOf(error) });
      }
    },

    change: (id, draft) => {
      update(id, { draft, object_type: objectTypeOf(draft), failure: null, apply_error: null });
      schedulePlan(id);
    },

    patch: (id, fields) => {
      const draft = get().editors[id]?.draft;
      if (draft) get().change(id, { ...draft, ...fields } as ObjectDefinition);
    },

    setOptions: (id, options) => {
      const editor = get().editors[id];
      if (!editor) return;
      update(id, { options: { ...editor.options, ...options }, failure: null, apply_error: null });
      if (editor.mode === 'drop') void get().plan(id);
      else schedulePlan(id);
    },

    plan: async (id) => {
      window.clearTimeout(plan_timers.get(id));
      const run = (plan_runs.get(id) ?? 0) + 1;
      plan_runs.set(id, run);
      const editor = get().editors[id];
      if (!editor) return;
      if (editor.mode !== 'drop' && !isDirty(editor)) {
        update(id, { planning: false, plan: null, plan_error: null });
        return;
      }
      update(id, { planning: true });
      const changed = editor.mode === 'drop' ? null : editor.draft;
      try {
        const plan = await api.planObjectChange(editor.server_id, editor.database, editor.object, editor.original, changed, editor.options);
        if (plan_runs.get(id) === run) update(id, { planning: false, plan, plan_error: null });
      } catch (error) {
        if (plan_runs.get(id) === run) update(id, { planning: false, plan: null, plan_error: messageOf(error) });
      }
    },

    review: (id) => {
      const editor = get().editors[id];
      if (editor && canReview(editor)) update(id, { step: 'review', confirm_name: '', failure: null, apply_error: null });
    },

    backToEditing: (id) => update(id, { step: 'edit', failure: null, apply_error: null }),

    setConfirmName: (id, name) => update(id, { confirm_name: name }),

    apply: async (id) => {
      const editor = get().editors[id];
      if (!editor || !canReview(editor)) return;
      const name = confirmationName(editor);
      if (name !== null && editor.confirm_name !== name) return;
      update(id, { applying: true, failure: null, apply_error: null });
      try {
        const plan = editor.plan as ChangePlan;
        const outcome = await api.applyObjectChange(editor.server_id, editor.database, plan);
        if (outcome.outcome === 'failed' && outcome.failure.committed) {
          await keepCommitted(id, editor, outcome.failure);
          return;
        }
        if (outcome.outcome === 'failed') {
          update(id, { applying: false, failure: outcome.failure });
          return;
        }
        set({ announcement: appliedMessage(editor) });
        get().closeEditor(id);
        await refreshTree(editor, plan.closes_database);
      } catch (error) {
        update(id, { applying: false, apply_error: messageOf(error) });
      }
    },

    copyToTab: (id) => {
      const editor = get().editors[id];
      if (!editor || !canReview(editor)) return;
      const statements = planStatements(editor.plan as ChangePlan);
      const text = `${statements.map((statement) => `${statement};`).join('\n\n')}\n`;
      const tabs = useQueryTabStore.getState();
      const tab_id = tabs.openTab({ server_id: editor.server_id, database: editor.database }, { text });
      const title = useQueryTabStore.getState().tabs[tab_id]?.title;
      set({ announcement: `The SQL is in ${title}. Nothing has run.` });
    },

    openInTab: (id) => {
      const editor = get().editors[id];
      if (editor?.host !== 'dialog') return;
      openers.delete(id);
      update(id, { host: 'tab', confirming_close: false });
      useDialogStore.getState().close();
      useQueryTabStore.getState().addTab(id);
    },

    requestClose: (id) => {
      const editor = get().editors[id];
      if (!editor) return;
      if (!isDirty(editor)) {
        get().closeEditor(id);
        return;
      }
      if (editor.host === 'tab') useQueryTabStore.getState().selectTab(id);
      update(id, { confirming_close: true });
    },

    keepEditing: (id) => update(id, { confirming_close: false }),

    closeEditor: (id) => {
      const editor = get().editors[id];
      if (!editor) return;
      window.clearTimeout(plan_timers.get(id));
      plan_timers.delete(id);
      plan_runs.delete(id);
      if (editor.host === 'tab') useQueryTabStore.getState().removeTab(id);
      set((state) => ({ editors: Object.fromEntries(Object.entries(state.editors).filter(([key]) => key !== id)) }));
      if (editor.host === 'tab') {
        openers.delete(id);
        restoreFocusIfLost();
        return;
      }
      const dialogs = useDialogStore.getState();
      if (dialogs.open?.kind === 'object-editor' && dialogs.open.editor_id === id) dialogs.close();
      returnFocus(id);
    },
  };
});
