import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { guardFileDrops } from './drop';
import './styles.css';
import { trackVisualViewport } from './viewport';

trackVisualViewport();
guardFileDrops();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
