/* ============================================================
   PULSE · источник данных.
   На GitHub Pages данные берутся из статических JSON-файлов,
   которые обновляет GitHub Action (папка /api).
   Если статика недоступна — пробуем внешний API Worker.
   ============================================================ */

const WORKER = window.__PULSE_API_ORIGIN || 'https://pulse-api.keen-weather.workers.dev';

/** Базовый путь сайта: '/pulse' на GitHub Pages, '' локально. */
export const BASE_PATH = (() => {
  const host = String(location.hostname || '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return '';
  if (host.endsWith('github.io')) {
    const first = location.pathname.split('/').filter(Boolean)[0] || '';
    return first ? `/${first}` : '';
  }
  return '';
})();

/** Статика данных лежит рядом с сайтом. */
export const DATA_BASE = `${BASE_PATH}/api`;

export function apiUrl(path) {
  return `${DATA_BASE}${path}`;
}

const memory = new Map();

async function getJson(url, { timeout = 12000 } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : 0;
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller ? controller.signal : undefined });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Загружает данные: сначала статика сайта, потом Worker, потом кэш браузера.
 * Название файла без .json, например loadData('chart').
 */
export async function loadData(name) {
  if (memory.has(name)) return memory.get(name);
  const attempts = [
    `${DATA_BASE}/${name}.json`,
    `${WORKER}/api/${name}`,
  ];
  for (const url of attempts) {
    try {
      const data = await getJson(url);
      memory.set(name, data);
      return data;
    } catch { /* следующая попытка */ }
  }
  throw new Error(`data_unavailable_${name}`);
}

/** Поиск по локальному индексу: без сервера и запросов. */
export async function searchLocal(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  let feed = null;
  try {
    feed = await loadData('feed');
  } catch {
    feed = { index: [] };
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  const matches = (track) => {
    const hay = `${track.title || ''} ${track.artist || ''}`.toLowerCase();
    return tokens.every((token) => hay.includes(token));
  };
  return (feed.index || []).filter(matches).slice(0, 40);
}

/** Треки исполнителя из заранее собранного списка. */
export async function artistTracks(name) {
  const key = String(name || '').split(/\s*(?:,|&|feat\.?)\s*/i)[0].trim().toLowerCase();
  try {
    const data = await loadData('artists');
    return Array.isArray(data[key]) ? data[key] : [];
  } catch {
    return [];
  }
}

/** Совместимость: старый код ждал installApiShim. */
export function installApiShim() {
  // Ничего не подменяем: запросы идут через loadData/searchLocal.
}
