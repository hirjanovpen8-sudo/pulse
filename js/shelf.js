/* ============================================================
   PULSE · «Послушать ещё раз» — локальная полка поверх плеера.
   Хранит треки в localStorage. Закреплённые всегда идут первыми,
   остальные — по дате добавления (сначала свежие).
   ============================================================ */

export const SHELF_KEY = 'pulse.shelf.replay';

/** Читает полку из localStorage. Устойчива к битым данным. */
export function readShelf() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHELF_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((t) => t && typeof t.id === 'string' && t.id.length > 0)
      .map((t) => ({
        id: t.id,
        title: String(t.title || ''),
        artist: String(t.artist || ''),
        album: String(t.album || ''),
        duration: Number(t.duration) || 0,
        cover: String(t.cover || ''),
        coverBig: String(t.coverBig || ''),
        pinned: Boolean(t.pinned),
        addedAt: Number(t.addedAt) || 0,
      }));
  } catch {
    return [];
  }
}

function writeShelf(list) {
  try {
    localStorage.setItem(SHELF_KEY, JSON.stringify(list.slice(0, 200)));
  } catch { /* хранилище переполнено или отключено */ }
}

/** Закреплённые — первыми, затем по дате добавления (новые выше). */
export function sortShelf(list) {
  return list.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.addedAt - a.addedAt;
  });
}

/** Возвращает полку в порядке показа. */
export function getReplayShelf() {
  return sortShelf(readShelf());
}

export function isOnShelf(id) {
  return readShelf().some((t) => t.id === id);
}

/** Добавляет трек на полку. Повторное добавление обновляет метаданные. */
export function addToShelf(track, { pinned = false } = {}) {
  if (!track || !track.id) return false;
  const list = readShelf();
  const at = list.findIndex((t) => t.id === track.id);
  if (at >= 0) {
    list[at] = {
      ...list[at],
      title: track.title || list[at].title,
      artist: track.artist || list[at].artist,
      album: track.album || list[at].album,
      duration: Number(track.duration) || list[at].duration,
      cover: track.cover || list[at].cover,
      coverBig: track.coverBig || list[at].coverBig,
      pinned: pinned ? true : list[at].pinned,
    };
  } else {
    list.push({
      id: track.id,
      title: String(track.title || ''),
      artist: String(track.artist || ''),
      album: String(track.album || ''),
      duration: Number(track.duration) || 0,
      cover: String(track.cover || ''),
      coverBig: String(track.coverBig || ''),
      pinned: Boolean(pinned),
      addedAt: Date.now(),
    });
  }
  writeShelf(list);
  notify();
  return true;
}

export function removeFromShelf(id) {
  const list = readShelf();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  writeShelf(next);
  notify();
  return true;
}

/** Переключает закрепление. Закреплённый трек поднимается наверх. */
export function togglePinShelf(id) {
  const list = readShelf();
  const item = list.find((t) => t.id === id);
  if (!item) return null;
  item.pinned = !item.pinned;
  writeShelf(list);
  notify();
  return item.pinned;
}

function notify() {
  document.dispatchEvent(new CustomEvent('pulse:shelf-changed', { detail: { items: getReplayShelf() } }));
}
