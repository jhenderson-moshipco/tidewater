import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import './theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { listenToQueryEvents } from './query/query-events';
import { restoreTabs, startSavingDrafts } from './query/tab-drafts';
import { listenToMenuCommands } from './shell/menu-commands';
import { App } from './shell/boot';
import { useServerStore } from './store/servers';

const root_element = document.getElementById('root');
if (!root_element) throw new Error('Missing #root element');

listenToMenuCommands();
listenToQueryEvents();
void (async () => {
  try {
    await useServerStore.getState().load();
  } finally {
    await restoreTabs();
    startSavingDrafts();
  }
})();

createRoot(root_element).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
