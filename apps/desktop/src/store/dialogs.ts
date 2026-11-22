import { create } from 'zustand';
import type { ProbeResult } from '../generated/connections';
import type { Environment, ServerGroup, ServerSummary, TlsMode } from '../generated/servers';

export type ConnectionDraft = {
  url: string;
  name: string;
  group_id: string;
  environment: Environment;
  host: string;
  port: number | '';
  database: string;
  user: string;
  password: string;
  tls: TlsMode;
  read_only: boolean;
  statement_timeout_s: number | '';
};

export type OpenDialog =
  | { kind: 'connection'; editing: ServerSummary | null }
  | { kind: 'group'; editing: ServerGroup | null }
  | { kind: 'delete-server'; server: ServerSummary }
  | { kind: 'delete-group'; group: ServerGroup; server_count: number }
  | { kind: 'start-fresh' }
  | { kind: 'settings' };

type DialogState = {
  open: OpenDialog | null;
  /** The connection form's starting values; the form is re-keyed by `draft_version` each time the dialog opens. */
  draft: ConnectionDraft;
  draft_version: number;
  probe: Array<ProbeResult> | null;
  busy: 'testing' | 'saving' | null;
  error: string | null;
  /** A short message for screen readers, such as which fields a pasted URL filled. */
  notice: string | null;
  openConnection: (editing: ServerSummary | null) => void;
  show: (dialog: Exclude<OpenDialog, { kind: 'connection' }>) => void;
  close: () => void;
  setProbe: (probe: Array<ProbeResult> | null) => void;
  setBusy: (busy: 'testing' | 'saving' | null) => void;
  setError: (error: string | null) => void;
  setNotice: (notice: string | null) => void;
};

export const empty_draft: ConnectionDraft = {
  url: '',
  name: '',
  group_id: '',
  environment: 'dev',
  host: 'localhost',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: '',
  tls: 'prefer',
  read_only: false,
  statement_timeout_s: '',
};

function draftFrom(server: ServerSummary): ConnectionDraft {
  return {
    url: '',
    name: server.name,
    group_id: server.group_id ?? '',
    environment: server.environment,
    host: server.host,
    port: server.port,
    database: server.database,
    user: server.user,
    password: '',
    tls: server.tls,
    read_only: server.session.read_only,
    statement_timeout_s: server.session.statement_timeout_ms === null ? '' : server.session.statement_timeout_ms / 1000,
  };
}

export const useDialogStore = create<DialogState>()((set) => ({
  open: null,
  draft: empty_draft,
  draft_version: 0,
  probe: null,
  busy: null,
  error: null,
  notice: null,
  openConnection: (editing) =>
    set((state) => ({
      open: { kind: 'connection', editing },
      draft: editing ? draftFrom(editing) : empty_draft,
      draft_version: state.draft_version + 1,
      probe: null,
      busy: null,
      error: null,
      notice: null,
    })),
  show: (dialog) => set({ open: dialog, busy: null, error: null, notice: null }),
  close: () => set({ open: null, probe: null, busy: null, error: null, notice: null }),
  setProbe: (probe) => set({ probe }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
}));
