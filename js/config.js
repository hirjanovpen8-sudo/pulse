/* ============================================================
   PULSE · адрес API.
   Локально запросы идут на тот же origin (server.mjs),
   на хостинге — на отдельный Cloudflare Worker.
   ============================================================ */

const HOSTED_ORIGIN = window.__PULSE_API_ORIGIN || 'https://pulse-api.tidal-snapper.workers.dev';

export const API_BASE = (() => {
  const host = String(location.hostname || '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return '';
  return HOSTED_ORIGIN;
})();

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

/** Подменяет относительные /api/... на полный адрес API. */
export function installApiShim() {
  if (!API_BASE) return;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    let target = input;
    if (typeof input === 'string' && input.startsWith('/api/')) target = apiUrl(input);
    else if (input instanceof Request && input.url.includes('/api/')) {
      const rewritten = apiUrl(new URL(input.url, location.href).pathname + new URL(input.url, location.href).search);
      target = new Request(rewritten, input);
    }
    return nativeFetch(target, init);
  };
}
