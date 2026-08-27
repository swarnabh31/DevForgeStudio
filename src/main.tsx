import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// CSRF hardening for LAN mode: the server gate rejects mutating
// (POST/PUT/PATCH/DELETE) requests from non-loopback clients unless the
// custom `x-devforge-csrf` header is present. Custom headers trigger a
// preflight cross-site, so this blocks drive-by form/fetch attackers while
// still allowing the app's own same-origin mutations.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const rawFetch = window.fetch.bind(window);
const csrfFetch: typeof window.fetch = (input, init) => {
  try {
    const method = (init?.method || (typeof input === 'object' && 'method' in (input as Request) ? (input as Request).method : 'GET') || 'GET').toUpperCase();
    if (MUTATING.has(method)) {
      const merged = { ...(init || {}) };
      const headers = new Headers(merged.headers);
      if (!headers.has('x-devforge-csrf')) headers.set('x-devforge-csrf', 'devforge');
      merged.headers = headers;
      return rawFetch(input as any, merged);
    }
  } catch {
    // Never block the request because of our own header wrapping
  }
  return rawFetch(input as any, init);
};
window.fetch = csrfFetch;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
