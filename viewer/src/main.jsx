import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import UpdateNotice from './UpdateNotice.jsx';
import { startSync } from './sync.js';
import './styles.css';

// Offline fallback, see public/sw.js. Skipped on the dev server, where a
// caching worker would only get in the way of hot reload.
if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('/sw.js');
}

// Does nothing until a sync key is entered, see sync.js.
startSync();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <UpdateNotice />
  </StrictMode>,
);
