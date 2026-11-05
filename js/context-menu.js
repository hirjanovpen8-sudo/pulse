/* ============================================================
   PULSE · самодельное контекстное меню (ПКМ по треку).
   Отдельный слой поверх интерфейса, стили — pulse-enhancements.css.
   ============================================================ */

import { getTrack } from './player.js';
import { addToShelf, isOnShelf, togglePinShelf, readShelf } from './shelf.js';

const LIBRARY_KEY = 'pulse.library';
const MENU_CLASS = 'pulse-ctx';

let menuEl = null;
let targetTrack = null;
let openAt = { x: 0, y: 0 };

/* ---------------- библиотека (localStorage) ---------------- */

function readLibrary() {
  try {
    const value = JSON.parse(localStorage.getItem(LIBRARY_KEY) || '[]');
    return Array.isArray(value) ? value.filter((t) => t && t.id) : [];
  } catch {
    return [];
  }
}

function saveToLibrary(track) {
  if (!track || !track.id) return false;
  const list = readLibrary().filter((t) => t.id !== track.id);
  list.unshift({
    id: track.id,
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    duration: Number(track.duration) || 0,
    cover: track.cover || '',
    coverBig: track.coverBig || '',
    addedAt: Date.now(),
  });
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(list.slice(0, 1000)));
  } catch { /* хранилище недоступно */ }
  document.dispatchEvent(new CustomEvent('pulse:library-changed', { detail: { track } }));
  return true;
}

export function isInLibrary(id) {
  return readLibrary().some((t) => t.id === id);
}

/* ---------------- поиск трека по DOM ---------------- */

/** Собирает данные трека из карточки или строки списка. */
function trackFromElement(el) {
  const holder = el.closest('[data-list-id], [data-track-id]');
  if (!holder) return null;
  const id = holder.dataset.listId || holder.dataset.trackId;
  if (!id) return null;

  const title = holder.querySelector('.card-title, .row-title');
  const artist = holder.querySelector('.card-sub, .row-artist, [data-artist]');
  const img = holder.querySelector('.card-cover img, .row-cover img');
  const duration = holder.querySelector('.row-time');

  const current = getTrack();
  const base = current && current.id === id ? current : {};
  return {
    id,
    title: (base.title || (title ? title.textContent.trim() : '')) || '',
    artist: base.artist || (artist ? artist.textContent.trim() : ''),
    album: base.album || '',
    duration: base.duration || (duration ? parseTime(duration.textContent) : 0),
    cover: base.cover || (img ? img.getAttribute('src') || '' : ''),
    coverBig: base.coverBig || (img ? img.getAttribute('src') || '' : ''),
  };
}

function parseTime(text) {
  const parts = String(text || '').trim().split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/* ---------------- toast (без цикла импортов) ---------------- */

function notify(message) {
  const root = document.getElementById('toasts');
  if (!root) return;
  let el = root.querySelector('.pulse-toast-lite');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast pulse-toast-lite is-in';
    el.setAttribute('role', 'status');
    root.appendChild(el);
  }
  el.textContent = message;
  clearTimeout(el._hideTimer);
  el._hideTimer = window.setTimeout(() => el.remove(), 2400);
}

/* ---------------- микс ---------------- */

async function startMix(track) {
  if (!track || !track.id) return;
  try {
    const response = await fetch(`/api/related?id=${encodeURIComponent(track.id)}`);
    const data = response.ok ? await response.json() : { tracks: [] };
    const radio = Array.isArray(data.tracks) ? data.tracks.filter((t) => t && t.id) : [];
    const queue = [{ ...track }, ...radio.filter((t) => t.id !== track.id)];
    if (window.__pulse && typeof window.__pulse.playNow === 'function') {
      window.__pulse.playNow(queue, 0, `Микс: ${track.artist || track.title || ''}`.trim());
      notify('Микс запущен');
    }
  } catch {
    notify('Не удалось запустить микс');
  }
}

/* ---------------- меню ---------------- */

function buildMenu(track) {
  const pinned = readShelf().some((t) => t.id === track.id && t.pinned);
  const onShelf = isOnShelf(track.id);
  const inLibrary = isInLibrary(track.id);
  const items = [
    { action: 'mix', label: 'Включить микс', icon: 'sparkle' },
    { action: 'library', label: inLibrary ? 'Уже в библиотеке' : 'Сохранить в библиотеке', icon: 'heart', disabled: inLibrary },
    {
      action: 'shelf',
      label: pinned ? 'Открепить от «Послушать ещё раз»' : 'Закрепить в «Послушать ещё раз»',
      icon: 'pin',
      disabled: !onShelf && false,
    },
  ];
  return `<div class="${MENU_CLASS}__head">
      <span class="${MENU_CLASS}__title">${escapeHtml(track.title || 'Без названия')}</span>
      <span class="${MENU_CLASS}__artist">${escapeHtml(track.artist || '')}</span>
    </div>
    <div class="${MENU_CLASS}__list">
      ${items.map((item) => `<button class="${MENU_CLASS}__item" type="button" role="menuitem" data-action="${item.action}"${item.disabled ? ' disabled' : ''}>
        <span class="${MENU_CLASS}__icon">${iconSvg(item.icon)}</span>${escapeHtml(item.label)}
      </button>`).join('')}
    </div>`;
}

function iconSvg(name) {
  const paths = {
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    heart: '<path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9z"/>',
    pin: '<path d="M9 4h6l-1 6 3 3v1H7v-1l3-3z"/><path d="M12 14v6"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg>`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function ensureMenu() {
  if (menuEl) return menuEl;
  menuEl = document.createElement('div');
  menuEl.className = MENU_CLASS;
  menuEl.setAttribute('role', 'menu');
  menuEl.setAttribute('aria-hidden', 'true');
  document.body.appendChild(menuEl);
  menuEl.addEventListener('click', (event) => {
    const button = event.target.closest(`.${MENU_CLASS}__item`);
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    const track = targetTrack;
    closeMenu();
    if (!track) return;
    if (action === 'mix') startMix(track);
    else if (action === 'library') {
      saveToLibrary(track);
      notify('Сохранено в библиотеке');
    } else if (action === 'shelf') {
      const wasPinned = readShelf().some((t) => t.id === track.id && t.pinned);
      if (wasPinned) {
        togglePinShelf(track.id);
        notify('Откреплено');
      } else {
        addToShelf(track, { pinned: true });
        notify('Закреплено в «Послушать ещё раз»');
      }
    }
  });
  return menuEl;
}

function placeMenu(x, y) {
  const el = ensureMenu();
  el.style.visibility = 'hidden';
  el.style.left = '0px';
  el.style.top = '0px';
  const rect = el.getBoundingClientRect();
  const pad = 8;
  let left = x;
  let top = y;
  if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - rect.width - pad);
  if (top + rect.height + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - rect.height - pad);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.visibility = 'visible';
}

export function openMenu(track, x, y) {
  if (!track) return;
  targetTrack = track;
  const el = ensureMenu();
  el.innerHTML = buildMenu(track);
  openAt = { x, y };
  placeMenu(x, y);
  el.setAttribute('aria-hidden', 'false');
  el.classList.add('is-open');
  const first = el.querySelector(`.${MENU_CLASS}__item:not(:disabled)`);
  if (first) first.focus({ preventScroll: true });
}

export function closeMenu() {
  if (!menuEl) return;
  menuEl.classList.remove('is-open');
  menuEl.setAttribute('aria-hidden', 'true');
}

function isMenuOpen() {
  return Boolean(menuEl && menuEl.classList.contains('is-open'));
}

/* ---------------- привязка событий ---------------- */

export function initContextMenu() {
  document.addEventListener('contextmenu', (event) => {
    const holder = event.target.closest('[data-list-id], [data-track-id]');
    if (!holder) return;
    const track = trackFromElement(holder);
    if (!track) return;
    event.preventDefault();
    openMenu(track, event.clientX, event.clientY);
  });

  document.addEventListener('click', (event) => {
    if (!isMenuOpen()) return;
    if (event.target.closest(`.${MENU_CLASS}`)) return;
    closeMenu();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!isMenuOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = Array.from(menuEl.querySelectorAll(`.${MENU_CLASS}__item:not(:disabled)`));
      const current = items.indexOf(document.activeElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (current + step + items.length) % items.length;
      if (items[next]) items[next].focus({ preventScroll: true });
    }
  });

  window.addEventListener('scroll', () => closeMenu(), { passive: true });
  window.addEventListener('resize', () => closeMenu());
  window.addEventListener('blur', () => closeMenu());
}

/* Для отладки из консоли. */
window.__pulseContextMenu = { openMenu, closeMenu, openAt: () => openAt };
