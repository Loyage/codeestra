import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const tokenKey = 'codeestra.token';

/**
 * The CLI prints an address whose fragment carries the token, and fragments are never sent to the
 * server. Read everything the fragment carries once, then drop it from the address bar so it
 * leaves no trace in browser history or server logs.
 *
 * `codeestra open` also puts the project it trusted in the fragment, so the console starts on that
 * project instead of on whichever project happens to be listed first.
 */
function readFragment(): { readonly token: string | null; readonly projectId: string | null } {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const fragment = new URLSearchParams(hash);
  const fromFragment = fragment.get('token');
  const projectId = fragment.get('project');
  if (fromFragment !== null && fromFragment.length > 0) {
    window.sessionStorage.setItem(tokenKey, fromFragment);
    window.history.replaceState(null, '', window.location.pathname);
    return { token: fromFragment, projectId };
  }
  return { token: window.sessionStorage.getItem(tokenKey), projectId };
}

const container = document.getElementById('root');
if (container === null) throw new Error('The UI shell has no root element');

const fragment = readFragment();

createRoot(container).render(
  <StrictMode>
    <App initialToken={fragment.token} initialProjectId={fragment.projectId} tokenKey={tokenKey} />
  </StrictMode>,
);
