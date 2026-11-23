import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import './theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { listenToMenuCommands } from './shell/menu-commands';
import { App } from './shell/boot';
import { useServerStore } from './store/servers';
import { useTreeStore } from './store/tree';

const root_element = document.getElementById('root');
if (!root_element) throw new Error('Missing #root element');

listenToMenuCommands();
void useServerStore
  .getState()
  .load()
  .then(() => useTreeStore.getState().reopen());

createRoot(root_element).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
