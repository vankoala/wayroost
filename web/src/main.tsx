import './tokens.css';
import '@fontsource/young-serif';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@fontsource/outfit/400.css';
import '@fontsource/outfit/700.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { guardFileDrops } from './drop';
import { initTheme } from './theme';
import './styles.css';
import './shell.css';
import { trackVisualViewport } from './viewport';

initTheme();
trackVisualViewport();
guardFileDrops();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
