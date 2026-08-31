import { setBaseUrl } from '@dua/api-client-react';

// Single source of truth for the backend origin.
//
// In Vite dev, "/api" requests are proxied to the backend (see vite.config.ts),
// so the browser only needs the same-origin "/api" path.  When the frontend is
// served from a different origin than the API (e.g. a static preview build or
// a container), set VITE_API_URL to the full backend origin, e.g.
//   VITE_API_URL=http://localhost:8000
// The value is trimmed of trailing slashes so "/api" is always appended once.
const rawBase = import.meta.env.VITE_API_URL as string | undefined;

const apiBase = rawBase && rawBase.trim() !== '' ? rawBase.replace(/\/+$/, '') : '';

// When a full origin is configured we point everything at it; otherwise the
// generated client already targets relative "/api/*" URLs which the dev server
// proxies to the backend.
if (apiBase) {
  setBaseUrl(apiBase);
}

export { apiBase };