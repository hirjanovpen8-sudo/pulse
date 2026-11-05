const APP_BUILD = 'v16';
console.log('[pulse] build', APP_BUILD);
/* ============================================================
   PULSE · каркас приложения: роутер, тосты, модалки,
   обвязка плеера и контроллеры нижней панели.
   ============================================================ */

import { esc, fmtTime, storage, icon, clamp, debounce } from './js/util.js';
import { loadData, searchLocal, artistTracks, BASE_PATH } from './js/config.js';
import { greeting, pageHead, trackRows, coverHtml } from './js/ui.js';
import {
  initPlayer, playerOn, state, getTrack, isPlaying, getCurrentTime,
  playTracks, toggle, next, previous, seek, setVolume, toggleMute,
  setPlaybackRate, getPlaybackRate, getVideoSize, playerToggleSubtitles,
  toggleShuffle, cycleRepeat, getQueue, getIndex, sendFeedback, removeTrackById, appendTracks,
} from './js/player.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------- тосты ---------------- */

const toastRoot = $('#toasts');

export function toast(message, { action = '', onAction = null, timeout = 4200 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast-text">${esc(message)}</span>${
    action ? `<button class="toast-action" type="button">${esc(action)}</button>` : ''
  }`;
  toastRoot.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  const remove = () => {
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), 220);
  };
  if (action && onAction) el.querySelector('.toast-action').addEventListener('click', () => { onAction(); remove(); });
  setTimeout(remove, timeout);
}

/* ---------------- модалки ---------------- */

const modalRoot = $('#modalRoot');

export function openModal(html, { className = '', onMount = null } = {}) {
  closeModal();
  const wrap = document.createElement('div');
  wrap.className = `modal-backdrop ${className}`;
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <button class="modal-close icon-btn" type="button" aria-label="Закрыть">${icon('close')}</button>
    ${html}
  </div>`;
  modalRoot.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-in'));
  const close = () => closeModal();
  wrap.querySelector('.modal-close').addEventListener('click', close);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  function onKey(e) { if (e.key === 'Escape') close(); }
  wrap._onKey = onKey;
  if (onMount) onMount(wrap.querySelector('.modal'));
  return wrap;
}

export function closeModal() {
  const wrap = modalRoot.firstElementChild;
  if (!wrap) return;
  document.removeEventListener('keydown', wrap._onKey);
  wrap.classList.remove('is-in');
  setTimeout(() => wrap.remove(), 180);
}

/* ---------------- скелетоны ---------------- */

export const skeleton = {
  title: '<div class="sk sk-title"></div>',
  text: '<div class="sk sk-text"></div>',
  cards(count = 6) {
    return Array.from({ length: count }, () => `
      <div class="card card-sk"><div class="sk sk-cover"></div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div>
    `).join('');
  },
  rows(count = 6) {
    return `<div class="rows">${Array.from({ length: count }, () => `
      <div class="row row-sk"><div class="sk sk-cover-sm"></div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div>
    `).join('')}</div>`;
  },
};

/* ---------------- навигация ---------------- */

const routes = new Map();
let currentRoute = null;
let afterRoute = null;

export function registerRoute(path, handler) {
  routes.set(path, handler);
}

export function setAfterRoute(fn) {
  afterRoute = fn;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || '';
  const [path, query] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'home', parts, params: new URLSearchParams(query || '') };
}

export async function navigate() {
  const { name, parts, params } = parseHash();
  const page = $('#page');
  const key = parts[0] || 'home';
  $$('[data-route]').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.route === key || el.dataset.route === name);
  });
  page.dataset.page = name;
  page.innerHTML = '';
  const handler = routes.get(name) || routes.get('home');
  if (afterRoute) afterRoute();
  if (!handler) {
    page.innerHTML = `<div class="page-head"><h1 class="page-title">Страница не найдена</h1></div>`;
    return;
  }
  currentRoute = name;
  try {
    await handler(page, { name, parts, params });
  } catch (err) {
    page.innerHTML = `<div class="empty-state">
      <p class="empty-title">Не удалось загрузить</p>
      <button class="btn btn-secondary" type="button" id="retryPage">Повторить</button>
    </div>`;
    const btn = $('#retryPage');
    if (btn) btn.addEventListener('click', () => navigate());
  }
  window.scrollTo({ top: 0 });
}

/* ---------------- треки: общая утилита ---------------- */

/**
 * Ставит трек(и) на воспроизведение. Принимает один трек или список.
 * Если у трека нет исполнителя/обложки — добираем данные на сервере.
 */
async function playNow(trackOrList, startIndex = 0, label = '') {
  const list = Array.isArray(trackOrList) ? trackOrList : [trackOrList];
  const valid = list.filter((t) => t && t.id);
  if (!valid.length) {
    toast('Здесь нет треков для воспроизведения');
    return;
  }
  const start = valid[startIndex] || valid[0];
  if (!start.title || !start.artist) {
    await fetchMeta(start);
  }
  playTracks(valid, list.length > 1 ? startIndex : 0, label);
  if (valid.length === 1) {
    loadWithRetry(`related?id=${encodeURIComponent(start.id)}`)
      .then((d) => appendTracks((d.tracks || []).filter((t) => t.id !== start.id)))
      .catch(() => {});
  }
  // Метаданные уже приходят из статического каталога — отдельный запрос не нужен.
}

/** Жесткая проверка: отсекаем всё, что похоже на сборник или длиннее 10 минут. */
function isTrackValid(t) {
  if (!t || !t.id) return false;
  const dur = Number(t.duration) || 0;
  if (dur > 600) return false; // Больше 10 минут — это точно микс или подкаст
  const text = `${t.title || ''} ${t.album || ''}`.toLowerCase();
  if (/(микс|сборник|megamix|nonstop|non-stop|dance mix|hits 20\d\d|chill mix|диджейский|dj set|live set|подборка|клубн|хиты|час музыки|музыка для)/i.test(text)) return false;
  return true;
}

/** Карточка без названия — это ещё не запись каталога: для неё берём метаданные по ID. */
function fetchMeta(track) {
  if (!track || !track.id || track.title) return Promise.resolve();
  return fetch(`/api/meta?id=${encodeURIComponent(track.id)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data && data.meta && data.meta.id === track.id) Object.assign(track, data.meta);
    })
    .catch(() => {});
}

/* ---------------- плеер ---------------- */

const els = {
  cover: $('#playerCover'),
  title: $('#playerTitle'),
  artist: $('#playerArtist'),
  like: $('#btnLike'),
  play: $('#btnPlay'),
  prev: $('#btnPrev'),
  next: $('#btnNext'),
  shuffle: $('#btnShuffle'),
  repeat: $('#btnRepeat'),
  mute: $('#btnMute'),
  timeNow: $('#timeNow'),
  timeEnd: $('#timeEnd'),
  progress: $('#progress'),
  progressFill: $('#progressFill'),
  progressBuffer: $('#progressBuffer'),
  progressKnob: $('#progressKnob'),
  volume: $('#volumeBar'),
  volumeFill: $('#volumeFill'),
  queue: $('#btnQueue'),
  device: $('#btnDevice'),
  player: $('#player'),
  handle: $('#playerHandle'),
};

let scrubbing = false;
let scrubRatio = 0;

/** Лайки хранятся на клиенте; плеер только отображает состояние. */
const LIKES_KEY = 'pulse.likes';
export function getLikes() {
  const value = storage.get(LIKES_KEY, []);
  return Array.isArray(value) ? value : [];
}

export function isLiked(id) {
  return getLikes().some((t) => t.id === id);
}

export function toggleLike(track = getTrack()) {
  if (!track || !track.id) return false;
  const likes = getLikes();
  const at = likes.findIndex((t) => t.id === track.id);
  let liked;
  if (at >= 0) {
    likes.splice(at, 1);
    liked = false;
  } else {
    likes.unshift({
      id: track.id,
      type: 'track',
      title: track.title,
      artist: track.artist,
      album: track.album || '',
      duration: track.duration || 0,
      cover: track.cover || '',
      coverBig: track.coverBig || track.cover || '',
    });
    liked = true;
  }
  storage.set(LIKES_KEY, likes.slice(0, 2000));
  if (liked) sendFeedback('like', track);
  renderLike();
  document.dispatchEvent(new CustomEvent('likes-changed', { detail: { track, liked } }));
  return liked;
}

function renderLike() {
  const track = getTrack();
  const on = Boolean(track && isLiked(track.id));
  els.like.classList.toggle('is-on', on);
  els.like.setAttribute('aria-pressed', String(on));
  els.like.setAttribute('aria-label', on ? 'Убрать лайк' : 'Лайк');
}

let lastTrack = null;

function renderTrack(track) {
  lastTrack = track || null;
  if (!track) {
    els.title.textContent = 'Сейчас играет';
    els.artist.textContent = 'Выберите трек';
    els.cover.innerHTML = icon('music');
    els.cover.classList.remove('has-cover');
    document.title = 'Pulse';
    return;
  }
  els.title.textContent = track.title || 'Без названия';
  els.artist.textContent = track.artist || 'Неизвестный исполнитель';
  if (track.cover) {
    els.cover.innerHTML = `<img src="${esc(track.cover)}" alt="" loading="lazy">`;
    els.cover.classList.add('has-cover');
  } else {
    els.cover.innerHTML = icon('music');
    els.cover.classList.remove('has-cover');
  }
  document.title = `${track.title} — ${track.artist || 'Pulse'}`;
  renderLike();
}

let currentTime = 0;
let currentDuration = 0;

function renderProgress({ current = 0, duration = 0, buffered = 0 }) {
  const dur = Number(duration) || 0;
  const value = scrubbing ? dur * scrubRatio : Number(current) || 0;
  currentTime = value;
  currentDuration = dur;
  const pct = dur > 0 ? clamp((value / dur) * 100, 0, 100) : 0;
  const bufPct = dur > 0 ? clamp((Number(buffered) / dur) * 100, 0, 100) : 0;
  els.progressFill.style.width = `${pct}%`;
  els.progressBuffer.style.width = `${bufPct}%`;
  els.progressKnob.style.left = `${pct}%`;
  els.timeNow.textContent = fmtTime(value);
  els.timeEnd.textContent = fmtTime(dur);
  els.progress.setAttribute('aria-valuenow', String(Math.round(value)));
  els.progress.setAttribute('aria-valuemax', String(Math.round(dur)));
}

function renderVolume({ volume = state.settings.volume, muted = state.settings.muted } = {}) {
  const v = muted ? 0 : volume;
  els.volumeFill.style.width = `${clamp(v * 100, 0, 100)}%`;
  els.mute.classList.toggle('is-on', Boolean(muted));
  els.mute.setAttribute('aria-label', muted ? 'Включить звук' : 'Без звука');
  els.volume.setAttribute('aria-valuenow', String(Math.round(v * 100)));
}

function renderToggles() {
  els.shuffle.classList.toggle('is-on', Boolean(state.settings.shuffle));
  els.shuffle.setAttribute('aria-pressed', String(Boolean(state.settings.shuffle)));
  els.repeat.classList.toggle('is-on', state.settings.repeat !== 'off');
  els.repeat.classList.toggle('is-one', state.settings.repeat === 'one');
  els.repeat.setAttribute('aria-pressed', String(state.settings.repeat !== 'off'));
  els.repeat.setAttribute('aria-label', state.settings.repeat === 'one' ? 'Повтор трека' : state.settings.repeat === 'all' ? 'Повтор очереди' : 'Повтор');
}

function setPlaying(on) {
  els.player.classList.toggle('is-playing', Boolean(on));
  els.play.setAttribute('aria-label', on ? 'Пауза' : 'Слушать');
}

function bindSeek(el, { onRatio, onCommit, onCancel }) {
  const ratioFromEvent = (event) => {
    const rect = el.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / rect.width, 0, 1);
  };
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    el.setPointerCapture(event.pointerId);
    el.dataset.dragging = '1';
    onRatio(ratioFromEvent(event));
    const move = (e) => onRatio(ratioFromEvent(e));
    const up = (e) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      delete el.dataset.dragging;
      onCommit(ratioFromEvent(e));
    };
    const cancel = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      delete el.dataset.dragging;
      onCancel();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
  });
}

export function initPlayerUi() {
  initPlayer();

  playerOn('track', ({ track }) => renderTrack(track));
  playerOn('state', ({ playing }) => setPlaying(playing));  playerOn('time', (data) => renderProgress(data));
  playerOn('volume', (data) => renderVolume(data));
  playerOn('queue', () => renderToggles());
  playerOn('started', ({ track }) => {
    contextMenuTrack = track;
    if (track && (!track.title || !track.artist)) {
      fetchMeta(track).then(() => {
        if (lastTrack && lastTrack.id === track.id) renderTrack(track);
      });
    }
    // История прослушиваний: питает «Мою волну» и раздел «Недавно прослушанные».
    if (track && track.id) {
      const recent = storage.get('pulse.recent', []).filter((t) => t && t.id !== track.id);
      recent.unshift({
        id: track.id,
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        duration: track.duration || 0,
        cover: track.cover || '',
        coverBig: track.coverBig || '',
      });
      storage.set('pulse.recent', recent.slice(0, 60));
    }
  });
  playerOn('error', ({ message }) => {
    toast(message || 'Не удалось загрузить', {
      action: 'Повторить',
      onAction: () => { resetAndRetry(); },
    });
    setTimeout(() => {
      const now = lastTrack;
      if (!now || !now.id || now.title) return;
      fetch(`/api/meta?id=${encodeURIComponent(now.id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && d.meta && d.meta.id === now.id) {
            Object.assign(now, d.meta);
            if (lastTrack === now) renderTrack(now);
          }
        })
        .catch(() => {});
    }, 0);
  });

  els.play.addEventListener('click', () => toggle());
  els.prev.addEventListener('click', () => previous());
  els.next.addEventListener('click', () => next());
  els.shuffle.addEventListener('click', () => { toggleShuffle(); renderToggles(); toast(state.settings.shuffle ? 'Перемешать: включено' : 'Перемешать: выключено'); });
  els.repeat.addEventListener('click', () => {
    cycleRepeat();
    renderToggles();
    const label = state.settings.repeat === 'off' ? 'выключен' : state.settings.repeat === 'all' ? 'всё' : 'этот трек';
    toast(`Повтор: ${label}`);
  });
  els.mute.addEventListener('click', () => toggleMute());
  els.like.addEventListener('click', () => toggleLike(getTrack()));

  bindSeek(els.progress, {
    onRatio: (r) => { scrubbing = true; scrubRatio = r; renderProgress({ current: (getTrack()?.duration || 0) * r, duration: getTrack()?.duration || 0 }); },
    onCommit: (r) => {
      scrubbing = false;
      const dur = getTrack()?.duration || 0;
      seek(dur * r);
    },
    onCancel: () => { scrubbing = false; },
  });
  els.progress.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') { seek(Math.max(0, currentTime - (event.shiftKey ? 30 : 5))); event.preventDefault(); }
    if (event.key === 'ArrowRight') { seek(Math.min(currentDuration, currentTime + (event.shiftKey ? 30 : 5))); event.preventDefault(); }
  });

  bindSeek(els.volume, {
    onRatio: (r) => { setVolume(r); renderVolume({ volume: r, muted: false }); },
    onCommit: (r) => { setVolume(r); renderVolume({ volume: r, muted: state.settings.muted }); },
    onCancel: () => renderVolume(),
  });
  els.volume.addEventListener('keydown', (event) => {
    const v = state.settings.muted ? 0 : state.settings.volume;
    if (event.key === 'ArrowLeft') setVolume(clamp(v - 0.05, 0, 1));
    if (event.key === 'ArrowRight') setVolume(clamp(v + 0.05, 0, 1));
  });

  // Колесо мыши регулирует громкость, когда курсор над полосой.
  els.volume.addEventListener('wheel', (event) => {
    event.preventDefault();
    const v = state.settings.muted ? 0 : state.settings.volume;
    setVolume(clamp(v + (event.deltaY < 0 ? 0.05 : -0.05), 0, 1));
  }, { passive: false });

  els.queue.addEventListener('click', openQueue);

  els.device.addEventListener('click', () => {
    toast('Устройство: этот компьютер');
  });

  bindPlayerCollapse();
  renderVolume();
  renderToggles();
  renderTrack(getTrack());
  renderProgress({ current: 0, duration: 0 });
}

/* ---------------- мобильный плеер ---------------- */

function bindPlayerCollapse() {
  const player = els.player;
  const mq = window.matchMedia('(max-width: 760px)');
  const sync = () => player.classList.remove('is-expanded');
  mq.addEventListener ? mq.addEventListener('change', sync) : mq.addListener(sync);

  els.handle.addEventListener('click', () => {
    if (!mq.matches) return;
    player.classList.toggle('is-expanded');
  });
  els.title.addEventListener('click', () => {
    if (mq.matches) player.classList.toggle('is-expanded');
  });
}

/* ---------------- глобальные горячие клавиши ---------------- */

function bindHotkeys() {
  const react = (event) => {
    const target = event.target;
    const tag = (target && target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (target && target.isContentEditable)) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (document.visibilityState !== 'visible') return false;

    const key = event.key;

    if (event.code === 'Space') {
      event.preventDefault();
      // Повторное нажатие (repeat) не должно дёргать паузу туда-обратно.
      if (event.repeat) return true;
      toggle();
      return true;
    }

    if (key === 'ArrowRight') {
      event.preventDefault();
      if (event.shiftKey) seek(getCurrentTime() + 30);
      else if (!(target && target.closest && target.closest('.progress'))) seek(getCurrentTime() + 5);
      return true;
    }
    if (key === 'ArrowLeft') {
      event.preventDefault();
      if (event.shiftKey) seek(getCurrentTime() - 30);
      else if (!(target && target.closest && target.closest('.progress'))) seek(getCurrentTime() - 5);
      return true;
    }
    if (key === 'ArrowUp') {
      event.preventDefault();
      changeVolume(0.07);
      return true;
    }
    if (key === 'ArrowDown') {
      event.preventDefault();
      changeVolume(-0.07);
      return true;
    }
    if (key === 'm' || key === 'M' || key === 'ь') {
      if (event.shiftKey) return false;
      event.preventDefault();
      toggleMute();
      renderVolume();
      toast(state.settings.muted ? 'Звук выключен' : 'Звук включён', { timeout: 1200 });
      return true;
    }
    if (key === 'f' || key === 'F' || key === 'а') {
      if (event.shiftKey) return false;
      event.preventDefault();
      toggleFullscreen();
      return true;
    }
    if (key === 'c' || key === 'C' || key === 'с') {
      if (event.shiftKey) return false;
      event.preventDefault();
      toggleSubtitles();
      return true;
    }
    if (key === ',' && !event.shiftKey) {
      event.preventDefault();
      changeRate(-0.25);
      return true;
    }
    if (key === '.' && !event.shiftKey) {
      event.preventDefault();
      changeRate(0.25);
      return true;
    }
    return false;
  };

  // Shift-комбинации: D — отладка, S — снимок кадра.
  const reactShift = (event) => {
    const target = event.target;
    const tag = (target && target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (target && target.isContentEditable)) return false;
    if (document.visibilityState !== 'visible') return false;
    if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
    const lower = String(event.key || '').toLowerCase();
    if (lower === 'd' || lower === 'в') {
      event.preventDefault();
      toggleDebugOverlay();
      return true;
    }
    if (lower === 's' || lower === 'ы') {
      event.preventDefault();
      captureFrame();
      return true;
    }
    return false;
  };

  const onKeyDown = (event) => {
    if (react(event)) return;
    reactShift(event);
  };
  document.addEventListener('keydown', onKeyDown);
}

function changeVolume(delta) {
  const base = state.settings.muted ? 0 : state.settings.volume;
  const value = clamp(base + delta, 0, 1);
  setVolume(value);
  if (state.settings.muted && value > 0) toggleMute();
  renderVolume({ volume: value, muted: state.settings.muted });
  toast(`Громкость ${Math.round(value * 100)}%`, { timeout: 1000 });
}

function changeRate(delta) {
  const nextRate = setPlaybackRate(getPlaybackRate() + delta);
  toast(`Скорость ${nextRate.toFixed(2)}×`, { timeout: 1000 });
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast('Полный экран недоступен', { timeout: 1600 });
  }
}

function toggleSubtitles() {
  const on = playerToggleSubtitles();
  toast(on ? 'Субтитры включены' : 'Субтитры выключены', { timeout: 1200 });
}

let debugOverlay = null;
let debugLoop = 0;

function toggleDebugOverlay() {
  if (debugOverlay) {
    window.clearTimeout(debugLoop);
    debugOverlay.remove();
    debugOverlay = null;
    toast('Отладка выключена', { timeout: 1100 });
    return;
  }
  debugOverlay = document.createElement('div');
  debugOverlay.className = 'debug-overlay';
  document.body.appendChild(debugOverlay);
  let last = performance.now();
  let frames = 0;
  let fps = 0;
  const loop = () => {
    if (!debugOverlay) return;
    frames += 1;
    const now = performance.now();
    if (now - last >= 500) {
      fps = Math.round((frames * 1000) / (now - last));
      frames = 0;
      last = now;
      renderDebug(fps);
    }
    debugLoop = window.requestAnimationFrame(loop);
  };
  renderDebug(0);
  debugLoop = window.requestAnimationFrame(loop);
  toast('Отладка включена', { timeout: 1100 });
}

function renderDebug(fps) {
  if (!debugOverlay) return;
  const track = getTrack();
  const size = getVideoSize();
  const buffer = $('#progressBuffer');
  const buffered = buffer ? parseFloat(buffer.style.width) || 0 : 0;
  const row = (label, value) => `<div><span>${label}</span><b>${esc(String(value))}</b></div>`;
  debugOverlay.innerHTML = [
    row('Трек', track ? track.title : '—'),
    row('ID', track ? track.id : '—'),
    row('Время', `${fmtTime(getCurrentTime())} / ${fmtTime(track ? (track.duration || 0) : 0)}`),
    row('Буфер', `${buffered.toFixed(0)}%`),
    row('Кадр', `${size.width}×${size.height}`),
    row('FPS', fps || '…'),
    row('Скорость', `${getPlaybackRate().toFixed(2)}×`),
  ].join('');
}

/**
 * Снимок кадра. Видео живёт в чужом iframe и прочитать его пиксели напрямую
 * нельзя, поэтому кадр берётся с сервера (прокси /api/frame) и сохраняется в PNG.
 */
function captureFrame() {
  const track = getTrack();
  if (!track) {
    toast('Нечего сохранять: нет трека', { timeout: 1600 });
    return;
  }
  const rawName = `${track.artist || 'Pulse'} — ${track.title || track.id}`;
  const fileName = rawName.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'pulse-frame';
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 1280;
    canvas.height = img.naturalHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      toast('Не удалось сохранить кадр', { timeout: 1600 });
      return;
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) {
        toast('Не удалось сохранить кадр', { timeout: 1600 });
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${fileName}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 3000);
      toast('Снимок кадра сохранён', { timeout: 1600 });
    }, 'image/png');
  };
  img.onerror = () => toast('Не удалось сохранить кадр', { timeout: 1600 });
  img.src = `/api/frame?id=${encodeURIComponent(track.id)}&t=${Math.round(getCurrentTime())}`;
}

/* ---------------- настройки (общий каркас) ---------------- */

export let contextMenuTrack = null;

export function openSettings() {
  const theme = storage.get('pulse.theme', 'dark');
  const accent = storage.get('pulse.accent', 'yellow');
  openModal(`
    <h2 class="modal-title">Настройки</h2>
    <section class="settings-group">
      <h3 class="settings-title">Внешний вид</h3>
      <div class="settings-row">
        <span>Акцентный цвет</span>
        <div class="accent-switch" role="radiogroup" aria-label="Акцентный цвет">
          <button class="accent-dot" type="button" data-accent="yellow" data-on="${accent === 'yellow'}" style="--dot:#FFD600" aria-label="Жёлтый"></button>
          <button class="accent-dot" type="button" data-accent="white" data-on="${accent === 'white'}" style="--dot:#FFFFFF" aria-label="Белый"></button>
        </div>
      </div>
      <div class="settings-row">
        <span>Тема</span>
        <div class="segmented" id="themeSeg">
          <button type="button" data-theme="dark" class="${theme === 'dark' ? 'is-on' : ''}">Тёмная</button>
          <button type="button" data-theme="light" class="${theme === 'light' ? 'is-on' : ''}">Светлая</button>
        </div>
      </div>
    </section>
    <section class="settings-group">
      <h3 class="settings-title">Горячие клавиши</h3>
      <dl class="shortcut-list">
        <div><dt><kbd>Space</kbd></dt><dd>Пауза и воспроизведение</dd></div>
        <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Перемотка на 5 секунд</dd></div>
        <div><dt><kbd>Shift</kbd> + <kbd>←</kbd> <kbd>→</kbd></dt><dd>Перемотка на 30 секунд</dd></div>
        <div><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Громкость</dd></div>
        <div><dt><kbd>M</kbd></dt><dd>Без звука</dd></div>
        <div><dt><kbd>F</kbd></dt><dd>Полный экран</dd></div>
        <div><dt><kbd>C</kbd></dt><dd>Субтитры</dd></div>
        <div><dt><kbd>,</kbd> <kbd>.</kbd></dt><dd>Скорость ±0.25</dd></div>
        <div><dt><kbd>Shift</kbd> + <kbd>D</kbd></dt><dd>Отладочная панель</dd></div>
        <div><dt><kbd>Shift</kbd> + <kbd>S</kbd></dt><dd>Снимок кадра в PNG</dd></div>
      </dl>
    </section>
    <section class="settings-group">
      <h3 class="settings-title">Связаться с нами</h3>
      <a class="settings-link" href="https://t.me/stesha_me" target="_blank" rel="noopener">Связаться с нами: @stesha_me</a>
    </section>
  `, {
    onMount: (modal) => {
      modal.querySelectorAll('[data-accent]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const value = btn.dataset.accent;
          storage.set('pulse.accent', value);
          document.documentElement.dataset.accent = value;
          modal.querySelectorAll('[data-accent]').forEach((b) => b.dataset.on = String(b === btn));
        });
      });
      modal.querySelectorAll('[data-theme]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const value = btn.dataset.theme;
          storage.set('pulse.theme', value);
          document.documentElement.dataset.theme = value;
          modal.querySelectorAll('[data-theme]').forEach((b) => b.classList.toggle('is-on', b === btn));
        });
      });
    },
  });
}

/* ---------------- страницы: каркас ---------------- */

function trackCard(t) {
  return `<article class="card" data-list-id="${esc(t.id)}" tabindex="0" role="button">
    <div class="card-cover">${coverHtml(t.cover)}<span class="card-play">${icon('play')}</span></div>
    <p class="card-title">${esc(t.title || 'Без названия')}</p>
    <p class="card-sub">${esc(t.artist || '')}</p>
  </article>`;
}

/** Клик по имени исполнителя ведёт на его страницу, а не запускает трек. */
function artistFromEvent(event) {
  const link = event.target.closest('[data-artist]');
  if (!link) return '';
  const name = String(link.dataset.artist || '').trim();
  if (!name) return '';
  location.hash = `#/artist?name=${encodeURIComponent(name)}`;
  return name;
}

/** Заливает карточки в контейнер и вешает один обработчик на всю сетку. */
function fillCards(box, items, label) {
  box.innerHTML = items.map(trackCard).join('');
  box.onclick = (event) => {
    if (artistFromEvent(event)) return;
    const card = event.target.closest('[data-list-id]');
    if (!card) return;
    const i = items.findIndex((t) => t.id === card.dataset.listId);
    if (i >= 0) playNow(items, i, label);
  };
}

/** Заливает строки треков и вешает один обработчик на весь список. */
function fillRows(box, items, label) {
  box.innerHTML = trackRows(items);
  box.onclick = (event) => {
    if (artistFromEvent(event)) return;
    const row = event.target.closest('.row[data-track-id]');
    if (!row) return;
    const i = items.findIndex((t) => t.id === row.dataset.trackId);
    if (i >= 0) playNow(items, i, label);
  };
}

const MOODS = [
  ['Спокойное', 'спокойная музыка'],
  ['Энергичное', 'энергичная музыка для тренировки'],
  ['В дороге', 'музыка в дорогу'],
  ['Романтика', 'романтические песни'],
  ['Русский рок', 'русский рок'],
  ['Хип-хоп', 'русский хип-хоп'],
];

function renderHome(page) {
  page.innerHTML = `
    <header class="page-head">
      <div>
        <h1 class="page-title">${esc(greeting())}</h1>
        <p class="page-subtitle">Чарт, новинки и волна, собранная под вас</p>
      </div>
    </header>

    <section class="section" aria-labelledby="sec-chart">
      <div class="section-head">
        <h2 class="section-title" id="sec-chart">Чарт</h2>
        <span class="section-link">Русский чарт</span>
      </div>
      <div class="card-grid" id="chartGrid">${skeleton.cards(6)}</div>
    </section>

    <section class="section" aria-labelledby="sec-new">
      <div class="section-head">
        <h2 class="section-title" id="sec-new">Новинки</h2>
      </div>
      <div id="newRows">${skeleton.rows(4)}</div>
    </section>

    <section class="section" aria-labelledby="sec-wave">
      <div class="section-head">
        <h2 class="section-title" id="sec-wave">Моя волна</h2>
        <button class="section-link" type="button" id="homeWavePlay">Слушать волну</button>
      </div>
      <div id="waveRows">${skeleton.rows(5)}</div>
    </section>

    <section class="section" aria-labelledby="sec-mood">
      <div class="section-head">
        <h2 class="section-title" id="sec-mood">Настроение</h2>
      </div>
      <div class="chips">
        ${MOODS.map(([title, query]) => `<a class="chip" href="#/search?q=${encodeURIComponent(query)}">${esc(title)}</a>`).join('')}
      </div>
    </section>
  `;

  const chartBox = $('#chartGrid', page);
  const waveBox = $('#waveRows', page);
  const newBox = $('#newRows', page);

  // Три запроса идут параллельно: каждый блок рисуется сразу, как придут данные.
  // На нестабильной мобильной сети делаем несколько попыток.
  loadWithRetry('/api/chart')
    .then((data) => {
      const items = (data.tracks || []).filter(isTrackValid).slice(0, 18);
      if (!items.length) throw new Error('empty');
      fillCards(chartBox, items, 'Чарт');
    })
    .catch(() => {
      chartBox.innerHTML = '<div class="empty-state"><p class="empty-title">Не удалось загрузить чарт</p><button class="btn btn-secondary" type="button" data-retry="chart">Повторить</button></div>';
      bindRetry(chartBox);
    });

  // Новинки берём из пула свежих треков (обновляется вместе с данными).
  loadData('feed')
    .then((data) => {
      const pools = data.pools || {};
      const fresh = [...(pools.mood_energy || []), ...(pools.pop || []), ...(pools.hiphop || [])];
      const items = uniqById(fresh).filter(isTrackValid).slice(0, 10);
      if (!items.length) throw new Error('empty');
      fillRows(newBox, items, 'Новинки');
    })
    .catch(() => {
      newBox.innerHTML = '<div class="empty-state"><p class="empty-title">Не удалось загрузить новинки</p><button class="btn btn-secondary" type="button" data-retry="new">Повторить</button></div>';
      bindRetry(newBox);
    });

  loadWithRetry('/api/wave')
    .then((data) => {
      const items = (data.tracks || []).filter(isTrackValid);
      if (!items.length) throw new Error('empty');
      fillRows(waveBox, items.slice(0, 8), 'Моя волна');
      const playAll = $('#homeWavePlay', page);
      if (playAll) playAll.addEventListener('click', () => playNow(items, 0, 'Моя волна'));
    })
    .catch(() => {
      waveBox.innerHTML = '<div class="empty-state"><p class="empty-title">Не удалось загрузить волну</p><button class="btn btn-secondary" type="button" data-retry="wave">Повторить</button></div>';
      bindRetry(waveBox);
    });
}

/**
 * Запрос данных с повторами. Источник — статические JSON с GitHub Pages,
 * с фолбэком на Worker. Мобильная сеть часто обрывает первую попытку.
 */
async function loadWithRetry(path, attempts = 4) {
  const name = String(path).replace(/^\/api\//, '').replace(/\.json.*$/, '').split('?')[0];
  const query = new URLSearchParams(String(path).split('?')[1] || '');

  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      // Поиск обслуживаем локальным индексом: мгновенно и без сервера.
      if (name === 'search') {
        const q = query.get('q') || '';
        const tracks = await searchLocal(q);
        if (tracks.length) return { tracks };
        throw new Error('empty_search');
      }
      if (name === 'artist') {
        const tracks = await artistTracks(query.get('name') || '');
        if (tracks.length) return { name: query.get('name'), count: tracks.length, tracks };
        throw new Error('empty_artist');
      }
      if (name === 'wave') {
        const data = await loadData('feed');
        const pools = Object.values(data.pools || {}).flat();
        const unique = [];
        const seen = new Set();
        for (const track of pools) {
          if (!track || seen.has(track.id)) continue;
          seen.add(track.id);
          unique.push(track);
        }
        // Перемешиваем на клиенте: каждый заход — новая волна.
        for (let k = unique.length - 1; k > 0; k -= 1) {
          const j = Math.floor(Math.random() * (k + 1));
          [unique[k], unique[j]] = [unique[j], unique[k]];
        }
        return { tracks: unique.slice(0, 30) };
      }
      if (name === 'related') {
        // Микс строим из локального индекса по тому же исполнителю.
        const id = query.get('id') || '';
        const feed = await loadData('feed');
        const source = (feed.index || []).find((t) => t.id === id);
        const artist = source ? String(source.artist || '').toLowerCase() : '';
        const similar = (feed.index || []).filter((t) => t.id !== id
          && (artist ? String(t.artist || '').toLowerCase() === artist : true));
        return { id, tracks: similar.slice(0, 25) };
      }
      return await loadData(name);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
    }
  }
  throw lastError || new Error('failed');
}

/** Убирает дубли по id, сохраняя порядок. */
function uniqById(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** Кнопка «Повторить» перерисовывает главную. */
function bindRetry(box) {
  const button = box.querySelector('[data-retry]');
  if (!button) return;
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = 'Загружаем…';
    if (typeof navigate === 'function') navigate();
  });
}

function extractVideoId(value) {
  const text = String(value || '').trim();
  const direct = text.match(/^[\w-]{11}$/);
  if (direct) return direct[0];
  const fromUrl = text.match(/(?:v=|\/watch\/|\/shorts\/|youtu\.be\/)([\w-]{11})/);
  if (fromUrl) return fromUrl[1];
  return '';
}

/* ---------------- очередь ---------------- */

function openQueue() {
  const queue = getQueue();
  const current = getIndex();
  if (!queue.length) {
    toast('Очередь пуста');
    return;
  }
  const upcoming = queue.slice(Math.max(current, 0));
  openModal(`
    <h2 class="modal-title">Очередь</h2>
    <div class="rows queue-list">${upcoming.map((t, i) => `
      <div class="row${i === 0 ? ' is-active' : ''}" data-queue-id="${esc(t.id)}">
        <span class="row-num">${i + 1}</span>
        <div class="row-cover">${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy">` : icon('music')}</div>
        <div class="row-main">
          <div class="row-title">${esc(t.title || '')}</div>
          <div class="row-artist">${esc(t.artist || '')}</div>
        </div>
        <div class="row-album"></div>
        <div class="row-time">${i > 0 ? `<button class="icon-btn queue-remove" type="button" data-remove-id="${esc(t.id)}" aria-label="Удалить">${icon('close')}</button>` : ''}</div>
      </div>
    `).join('')}</div>
  `, {
    onMount: (modal) => {
      modal.querySelectorAll('[data-remove-id]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          removeTrackById(btn.dataset.removeId);
          btn.closest('.row').remove();
        });
      });
    },
  });
}

/* ---------------- подписка на события ---------------- */

function bindPageEvents() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest && event.target.closest('.row[data-track-id]');
    if (!row) return;
    event.preventDefault();
    row.click();
  });
  document.addEventListener('click', (event) => {
    const row = event.target.closest('.row[data-track-id]');
    if (!row) return;
    const id = row.dataset.trackId;
    const track = findTrack(id);
    if (track) playNow(track);
  });
}

function findTrack(id) {
  const queue = getQueue();
  return queue.find((t) => t.id === id) || null;
}

/* ---------------- запуск ---------------- */

function applyStoredTheme() {
  const theme = storage.get('pulse.theme', 'dark');
  const accent = storage.get('pulse.accent', 'yellow');
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.accent = accent;
}

function bindShell() {
  $('#openSettings').addEventListener('click', openSettings);
  $('#quickSearch').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const q = event.target.value.trim();
    if (!q) return;
    location.hash = `#/search?q=${encodeURIComponent(q)}`;
  });
  const back = $('#navBack');
  const fwd = $('#navForward');
  back.addEventListener('click', () => history.back());
  fwd.addEventListener('click', () => history.forward());
  const syncHistory = () => {
    back.hidden = !history.length || history.length <= 1;
    fwd.hidden = true;
  };
  window.addEventListener('popstate', syncHistory);
  window.addEventListener('hashchange', () => { navigate(); syncHistory(); });

  document.addEventListener('click', (event) => {
    const open = event.target.closest('[data-open-settings]');
    if (open) { event.preventDefault(); openSettings(); }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
  document.addEventListener('likes-changed', () => renderLike());
}

function resetAndRetry() {
  const track = getTrack();
  if (track) playNow(track);
}

function boot() {
  applyStoredTheme();
  bindShell();
  initPlayerUi();
  // Отладочный доступ к запуску воспроизведения (нужен для тестов из консоли).
  window.__pulse = { playNow, navigate };
  bindHotkeys();
  bindPageEvents();
  renderLike();

  registerRoute('home', renderHome);
  registerRoute('search', (page, { params }) => {
    const q = (params.get('q') || '').trim();
    const input = $('#quickSearch');
    if (q && input.value !== q) input.value = q;
    const history = storage.get('pulse.searchHistory', []).filter((x) => x && x !== q);
    page.innerHTML = `
      ${pageHead(q ? `Поиск: ${q}` : 'Поиск', q ? '' : 'Что включить? Найдите трек, исполнителя или альбом')}
      <div id="searchResults">${q ? skeleton.rows(6) : ''}</div>
    `;
    const box = $('#searchResults', page);
    const bindRows = (tracks) => {
      box.addEventListener('click', (event) => {
        if (artistFromEvent(event)) return;
        const row = event.target.closest('.row[data-track-id]');
        if (!row) return;
        const i = tracks.findIndex((t) => t.id === row.dataset.trackId);
        if (i >= 0) playNow(tracks, i, 'Поиск');
      });
    };
    if (!q) {
      box.innerHTML = history.length
        ? `<p class="page-subtitle">История поиска</p><div class="rows">${history.slice(0, 10).map((h) => `
          <div class="row" data-search-query="${esc(h)}" tabindex="0" role="button">
            <span class="row-num"></span>
            <div class="row-cover">${icon('search')}</div>
            <div class="row-main"><div class="row-title">${esc(h)}</div></div>
            <div class="row-album"></div><div class="row-time"></div>
          </div>`).join('')}</div>`
        : '<p class="page-subtitle">Введите запрос в строке поиска сверху</p>';
      box.addEventListener('click', (event) => {
        const row = event.target.closest('[data-search-query]');
        if (row) location.hash = `#/search?q=${encodeURIComponent(row.dataset.searchQuery)}`;
      });
      return;
    }
    storage.set('pulse.searchHistory', [q, ...history].slice(0, 20));
    box.innerHTML = skeleton.rows(6);
    loadWithRetry(`search?q=${encodeURIComponent(q)}`)
      .then((data) => {
        const tracks = Array.isArray(data.tracks) ? data.tracks.filter(isTrackValid) : [];
        if (!tracks.length) {
          box.innerHTML = '<p class="page-subtitle">Ничего не найдено</p>';
          return;
        }
        box.innerHTML = trackRows(tracks);
        bindRows(tracks);
      })
      .catch(() => { box.innerHTML = '<p class="page-subtitle">Не удалось загрузить</p>'; });
  });
  registerRoute('collection', (page, { parts }) => {
    const kind = parts[1] || '';
    if (kind === 'artists') {
      // Подписки: исполнители из лайков и истории — тот круг, что вы реально слушаете.
      const seen = new Map();
      const collect = (list) => {
        for (const t of list) {
          const names = String(t.artist || '').split(/\s*(?:,|&|feat\.?|при уч\.?|×)\s*/i);
          for (const raw of names) {
            const name = raw.trim();
            if (!name || name.length < 2) continue;
            const key = name.toLowerCase();
            if (!seen.has(key)) {
              seen.set(key, { name, cover: t.coverBig || t.cover || '', tracks: 0 });
            }
            seen.get(key).tracks += 1;
          }
        }
      };
      collect(getLikes());
      collect(storage.get('pulse.recent', []).filter((t) => t && t.id));
      const artists = [...seen.values()].sort((a, b) => b.tracks - a.tracks);
      page.innerHTML = `
        ${pageHead('Подписки', artists.length ? `${artists.length} ${artists.length === 1 ? 'исполнитель' : artists.length < 5 ? 'исполнителя' : 'исполнителей'} из ваших лайков и истории` : 'Исполнители, которых вы слушаете')}
        ${artists.length
          ? `<div class="card-grid">${artists.map((a) => `
              <article class="card" data-artist-card="${esc(a.name)}" tabindex="0" role="button">
                <div class="card-cover artist-avatar">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy">` : icon('artist')}</div>
                <p class="card-title">${esc(a.name)}</p>
                <p class="card-sub">${a.tracks} ${a.tracks === 1 ? 'трек' : a.tracks < 5 ? 'трека' : 'треков'}</p>
              </article>`).join('')}</div>`
          : `<div class="empty-state"><p class="empty-title">Пока пусто</p><p class="page-subtitle">Полайкайте треки или послушайте музыку — исполнители появятся здесь</p><a class="btn" href="#/wave">Включить волну</a></div>`}
      `;
      page.addEventListener('click', (event) => {
        const card = event.target.closest('[data-artist-card]');
        if (!card) return;
        location.hash = `#/artist?name=${encodeURIComponent(card.dataset.artistCard)}`;
      });
      return;
    }

    const liked = kind === 'likes';
    const list = liked
      ? getLikes().filter(isTrackValid)
      : storage.get('pulse.recent', []).filter((t) => t && t.id);
    const title = liked ? 'Любимые треки' : 'Недавно прослушанные';
    const subtitle = liked
      ? (list.length ? (list.length === 1 ? '1 трек' : list.length < 5 ? `${list.length} трека` : `${list.length} треков`) : 'Всё, что вам понравилось, будет здесь')
      : (list.length ? (list.length === 1 ? '1 последний трек' : list.length < 5 ? `${list.length} последних трека` : `${list.length} последних треков`) : 'История прослушиваний');
    page.innerHTML = `
      ${pageHead(title, subtitle, list.length ? `<button class="btn" type="button" id="collectionPlay">${icon('play')}Слушать</button>` : '')}
      <div id="collectionTracks">${list.length ? trackRows(list) : ''}</div>
      ${list.length ? '' : `<div class="empty-state">
        <p class="empty-title">${liked ? 'Ещё нет любимых треков' : 'История пока пуста'}</p>
        <p class="page-subtitle">${liked ? 'Нажмите на сердечко у трека в плеере — он появится здесь' : 'Включите любой трек — он появится здесь'}</p>
        <a class="btn" href="#/">На главную</a>
      </div>`}
    `;
    const box = $('#collectionTracks', page);
    if (list.length && box) {
      box.onclick = (event) => {
        if (artistFromEvent(event)) return;
        const row = event.target.closest('.row[data-track-id]');
        if (!row) return;
        const i = list.findIndex((t) => t.id === row.dataset.trackId);
        if (i >= 0) playNow(list, i, title);
      };
      const playAll = $('#collectionPlay', page);
      if (playAll) playAll.addEventListener('click', () => playNow(list, 0, title));
    }
  });
  registerRoute('wave', (page) => {
    page.innerHTML = `
      ${pageHead('Моя волна', 'Бесконечный поток, собранный под вас', `<button class="btn" type="button" id="waveRefresh">${icon('sparkle')}Обновить волну</button>`)}
      <div id="waveResults">${skeleton.rows(8)}</div>
    `;
    const box = $('#waveResults', page);
    let waveTracks = [];

    /* Передаём серверу вкусы: лайки и историю, чтобы волна была «моей». */
    const waveUrl = () => {
      const recentList = storage.get('pulse.recent', []).filter((t) => t && t.id);
      const likes = getLikes().map((t) => t.id).filter(Boolean).slice(0, 50);
      const recent = [...new Set(recentList.map((t) => t.id))].slice(0, 50);
      const params = new URLSearchParams();
      if (likes.length) params.set('likes', likes.join(','));
      if (recent.length) params.set('recent', recent.join(','));
      // Метаданные недавних треков — чтобы сервер знал исполнителей без лишних запросов.
      const meta = recentList.slice(0, 12).map((t) => ({
        id: t.id, title: t.title || '', artist: t.artist || '', album: t.album || '', duration: t.duration || 0,
        cover: t.cover || '', coverBig: t.coverBig || '',
      }));
      if (meta.length) params.set('meta', encodeURIComponent(JSON.stringify(meta)));
      const query = params.toString();
      return `/api/wave${query ? `?${query}` : ''}`;
    };

    const load = () => {
      box.innerHTML = skeleton.rows(8);
      fetch(waveUrl())
        .then((r) => (r.ok ? r.json() : { tracks: [] }))
        .then((data) => {
          waveTracks = Array.isArray(data.tracks) ? data.tracks.filter(isTrackValid) : [];
          if (!waveTracks.length) {
            box.innerHTML = '<p class="page-subtitle">Не удалось собрать волну</p>';
            return;
          }
          box.innerHTML = trackRows(waveTracks);
        })
        .catch(() => { box.innerHTML = '<p class="page-subtitle">Не удалось загрузить</p>'; });
    };
    box.addEventListener('click', (event) => {
      if (artistFromEvent(event)) return;
      const row = event.target.closest('.row[data-track-id]');
      if (!row || !waveTracks.length) return;
      const i = waveTracks.findIndex((t) => t.id === row.dataset.trackId);
      if (i >= 0) playNow(waveTracks, i, 'Моя волна');
    });
    $('#waveRefresh', page).addEventListener('click', load);
    load();
  });

  registerRoute('artist', (page, { params }) => {
    const name = (params.get('name') || '').trim();
    if (!name) {
      page.innerHTML = pageHead('Исполнитель', 'Не указано, какого исполнителя открыть');
      return;
    }
    page.innerHTML = `
      ${pageHead(name, 'Загрузка треков исполнителя…')}
      <div class="section-head">
        <h2 class="section-title">Треки</h2>
        <div class="section-actions">
          <button class="btn btn-secondary" type="button" id="artistMix">${icon('sparkle')}Микс исполнителя</button>
          <button class="btn" type="button" id="artistPlayAll">${icon('play')}Слушать</button>
        </div>
      </div>
      <div id="artistTracks">${skeleton.rows(8)}</div>
    `;
    const box = $('#artistTracks', page);
    let tracks = [];
    const render = () => {
      box.innerHTML = trackRows(tracks);
      box.onclick = (event) => {
        if (artistFromEvent(event)) return;
        const row = event.target.closest('.row[data-track-id]');
        if (!row) return;
        const i = tracks.findIndex((t) => t.id === row.dataset.trackId);
        if (i >= 0) playNow(tracks, i, name);
      };
      const subtitle = page.querySelector('.page-subtitle');
      if (subtitle) subtitle.textContent = `${tracks.length} треков в каталоге`;
    };
    loadWithRetry(`artist?name=${encodeURIComponent(name)}`)
      .then((data) => {
        tracks = Array.isArray(data.tracks) ? data.tracks.filter(isTrackValid) : [];
        if (!tracks.length) {
          box.innerHTML = '<p class="page-subtitle">Треки не найдены</p>';
          return;
        }
        render();
      })
      .catch(() => { box.innerHTML = '<p class="page-subtitle">Не удалось загрузить</p>'; });

    $('#artistPlayAll', page).addEventListener('click', () => {
      if (tracks.length) playNow(tracks, 0, name);
    });
    $('#artistMix', page).addEventListener('click', () => {
      // Микс исполнителя: его треки + похожие исполнители в одном потоке.
      if (!tracks.length) return;
      const first = tracks[0];
      playNow(tracks, 0, `Микс: ${name}`);
      loadWithRetry(`related?id=${encodeURIComponent(first.id)}`)
        .then((d) => appendTracks((d.tracks || []).filter((t) => t.id !== first.id)))
        .catch(() => {});
    });
  });

  navigate();
}

boot();

export { $, $$, esc, fmtTime, storage, icon, state, getTrack, isPlaying, getQueue, getIndex, debounce };
