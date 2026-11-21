import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import './theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { listenToMenuCommands } from './shell/menu-commands';
import { Workspace } from './shell/workspace';

const root_element = document.getElementById('root');
if (!root_element) throw new Error('Missing #root element');

listenToMenuCommands();

createRoot(root_element).render(
  <StrictMode>
    <Workspace />
  </StrictMode>,
);
