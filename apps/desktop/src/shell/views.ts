import {
  IconActivity,
  IconDatabase,
  IconFileText,
  IconHistory,
  IconSearch,
  type Icon,
} from '@tabler/icons-react';
import type { WorkspaceView } from '../store/workspace';

export type ViewDefinition = {
  view: WorkspaceView;
  label: string;
  title: string;
  empty: string;
  icon: Icon;
};

/**
 * menu options for native OS toolbars
 */
export const workspace_views: ReadonlyArray<ViewDefinition> = [
  { view: 'explorer', label: 'Explorer', title: 'Servers', empty: 'No servers yet.', icon: IconDatabase },
  { view: 'search', label: 'Search', title: 'Search', empty: 'Connect to a server to search its objects.', icon: IconSearch },
  { view: 'files', label: 'Saved queries', title: 'Saved queries', empty: 'No saved queries.', icon: IconFileText },
  { view: 'history', label: 'History', title: 'History', empty: 'No queries run yet.', icon: IconHistory },
  { view: 'performance', label: 'Performance', title: 'Performance', empty: 'Connect to a server to watch it live.', icon: IconActivity },
];

export function findView(view: WorkspaceView): ViewDefinition {
  const found = workspace_views.find((definition) => definition.view === view);
  if (!found) throw new Error(`Unknown view: ${view}`);
  return found;
}
