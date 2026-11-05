/* ============================================================
   PULSE · режим «Только текст».
   Изолированный вид: своя разметка, стили и подписки.
   Управление звуком идёт через существующий модуль плеера,
   стандартный интерфейс только скрывается атрибутом data-view.
   ============================================================ */

import {
  playerOn, getTrack, getCurrentTime, isPlaying,
  toggle, next, previous, seek, cycleRepeat, toggleMute,
  setVolume, state,
} from './js/player.js';

const ROOT_ID = 'otmRoot';
const VIEW_KEY = 'pulse.view.mode';
const LIKED_KEY = 'liked_songs';
const LRC_API = 'https://lrclib.net/api/search';

let root = null;
let lines = [];
let activeLine = -1;
let activeWord = -1;
let pollTimer = 0;
let clockTimer = 0;
let lyricsToken = 0;
let currentLyricsFor = '';
let repeatOn = false;
let userScrollUntil = 0;

/* ---------------- утилиты ---------------- */

const pad2 = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');

function fmt(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function safeNow() {
  try {
    const value = getCurrentTime();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/* ---------------- liked_songs ---------------- */

export function readLiked() {
  try {
    const value = JSON.parse(localStorage.getItem(LIKED_KEY) || '[]');
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function isLiked(id) {
  return Boolean(id) && readLiked().includes(id);
}

export function toggleLiked(id) {
  if (!id) return false;
  const list = readLiked().filter((v) => v !== id);
  const liked = list.length === readLiked().length;
  if (liked) list.push(id);
  try {
    localStorage.setItem(LIKED_KEY, JSON.stringify(list));
  } catch { /* хранилище недоступно */ }
  document.dispatchEvent(new CustomEvent('pulse:liked-changed', { detail: { id, liked } }));
  return liked;
}

/* ---------------- LRC: строки и слова ---------------- */

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

function toSeconds(min, sec, frac) {
  return (Number(min) || 0) * 60 + (Number(sec) || 0) + (frac ? Number(`0.${frac}`) : 0);
}

/**
 * Разбирает LRC на [{ time, text, words: [{ time, text }] }].
 * Поддерживает Enhanced LRC с пословными таймкодами <mm:ss.xx>.
 * Возвращает null, если таймкодов нет вовсе.
 */
export function parseLrc(source) {
  const raw = String(source || '');
  if (!raw.trim()) return null;
  const result = [];
  let hasTime = false;

  for (const rawLine of raw.split(/\r?\n/)) {
    const times = [];
    let match;
    TIME_TAG.lastIndex = 0;
    while ((match = TIME_TAG.exec(rawLine)) !== null) {
      times.push(toSeconds(match[1], match[2], match[3]));
    }
    if (!times.length) continue;
    hasTime = true;

    let body = rawLine.replace(TIME_TAG, '').replace(WORD_TAG, '');
    body = body.trim();
    if (!body) continue;

    const words = [];
    const base = times[0];
    let cursor = 0;
    let wordMatch;
    let pending = null;
    WORD_TAG.lastIndex = 0;
    let rest = rawLine.replace(TIME_TAG, '');

    while ((wordMatch = WORD_TAG.exec(rest)) !== null) {
      if (pending) {
        const chunk = rest.slice(pending.at, wordMatch.index).trim();
        if (chunk) words.push({ time: pending.time, text: chunk });
      }
      pending = { time: toSeconds(wordMatch[1], wordMatch[2], wordMatch[3]), at: WORD_TAG.lastIndex };
    }
    if (pending) {
      const chunk = rest.slice(pending.at).trim();
      if (chunk) words.push({ time: pending.time, text: chunk });
    }

    // Нет пословных таймкодов — делим по длине слов внутри строки.
    if (!words.length) {
      const tokens = body.split(/\s+/).filter(Boolean);
      const totalChars = tokens.reduce((acc, w) => acc + w.length, 0) || 1;
      let acc = 0;
      for (const token of tokens) {
        const share = token.length / totalChars;
        words.push({ time: base + acc, text: token });
        acc += share;
      }
    }

    for (const time of times) {
      // Пословные таймкоды привязаны к началу строки — сдвигаем на дельту.
      const offset = time - base;
      result.push({
        time,
        text: body,
        words: words.map((w) => ({ time: w.time + offset, text: w.text })),
      });
    }
  }

  if (!hasTime) return null;
  return result.sort((a, b) => a.time - b.time);
}

function plainLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((t, i) => ({ time: null, text: t, words: null, index: i }));
}

/* ---------------- LRCLIB ---------------- */

async function fetchFromLrclib(track) {
  const artist = String(track.artist || '').split(/\s*(?:,|&|feat\.?|×)\s*/i)[0].trim();
  const title = String(track.title || '').replace(/\s*[([].*?[)\]]\s*$/g, '').trim();
  if (!title || !artist) return null;
  const params = new URLSearchParams({
    track_name: title,
    artist_name: artist,
    album_name: track.album || '',
  });
  if (track.duration) params.set('duration', String(Math.round(track.duration)));
  try {
    const response = await fetch(`${LRC_API}?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const list = await response.json();
    if (!Array.isArray(list) || !list.length) return null;
    // Предпочитаем синхронизированный текст.
    const synced = list.find((item) => item && item.syncedLyrics);
    if (synced) return { lyrics: synced.syncedLyrics, source: 'lrclib' };
    const plain = list.find((item) => item && item.plainLyrics);
    if (plain) return { lyrics: plain.plainLyrics, source: 'lrclib-plain' };
    return null;
  } catch {
    return null;
  }
}

/* ---------------- цвета из обложки ---------------- */

const colorCache = new Map();

function dominantColors(url) {
  if (!url) return Promise.resolve(null);
  if (colorCache.has(url)) return Promise.resolve(colorCache.get(url));
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        // Грубая кластеризация: квантуем цвет и берём два самых частых.
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 140) continue;
          const r = data[i] & 0xF8;
          const g = data[i + 1] & 0xF8;
          const b = data[i + 2] & 0xF8;
          const key = (r << 16) | (g << 8) | b;
          const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
          bucket.r += data[i];
          bucket.g += data[i + 1];
          bucket.b += data[i + 2];
          bucket.n += 1;
          buckets.set(key, bucket);
        }
        const sorted = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 2);
        if (!sorted.length) return resolve(null);
        const colors = sorted.map((b) => ({
          r: Math.round(b.r / b.n),
          g: Math.round(b.g / b.n),
          b: Math.round(b.b / b.n),
        }));
        colorCache.set(url, colors);
        resolve(colors);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function rgb({ r, g, b }, k = 1) {
  const clamp = (v) => Math.min(255, Math.max(0, Math.round(v * k)));
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}

function applyAmbient(colors) {
  if (!root) return;
  if (!colors || !colors.length) {
    root.style.removeProperty('--otm-c1');
    root.style.removeProperty('--otm-c2');
    root.style.removeProperty('--otm-ink');
    return;
  }
  const primary = colors[0];
  const secondary = colors[1] || colors[0];
  const luminance = (0.299 * primary.r + 0.587 * primary.g + 0.114 * primary.b) / 255;
  // Светлая пастельная основа + насыщенное второе пятно.
  root.style.setProperty('--otm-c1', rgb(primary, 1.55));
  root.style.setProperty('--otm-c2', rgb(secondary, 0.86));
  root.style.setProperty('--otm-ink', luminance < 0.42 ? '#FFFFFF' : '#0B0E14');
  root.style.setProperty('--otm-ink-soft', luminance < 0.42 ? 'rgba(255,255,255,.72)' : 'rgba(11,14,20,.6)');
  root.classList.toggle('otm--dark', luminance < 0.42);
}

/* ---------------- разметка ---------------- */

function template() {
  return `
    <div class="otm-bg" aria-hidden="true">
      <span class="otm-bg__blob otm-bg__blob--a"></span>
      <span class="otm-bg__blob otm-bg__blob--b"></span>
      <span class="otm-bg__grain"></span>
    </div>
    <div class="otm-shell">
      <header class="otm-top">
        <div class="otm-top__brand">Pulse <span>· только текст</span></div>
        <div class="otm-top__right">
          <time class="otm-clock" data-otm-clock>00:00</time>
          <button class="otm-switch" type="button" data-otm-action="close">Стандартный вид</button>
        </div>
      </header>

      <main class="otm-main">
        <section class="otm-card" aria-label="Сейчас играет">
          <div class="otm-cover" data-otm-cover></div>

          <div class="otm-meta">
            <div class="otm-meta__text">
              <h1 class="otm-title" data-otm-title>Ничего не играет</h1>
              <p class="otm-artist" data-otm-artist>Выберите трек в стандартном виде</p>
            </div>
            <button class="otm-like" type="button" data-otm-action="like" aria-label="Лайк" aria-pressed="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9z"/></svg>
            </button>
          </div>

          <div class="otm-timeline">
            <span class="otm-time" data-otm-now>0:00</span>
            <div class="otm-track" data-otm-track tabindex="0" role="slider" aria-label="Позиция трека" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
              <div class="otm-fill" data-otm-fill></div>
              <div class="otm-knob" data-otm-knob></div>
            </div>
            <span class="otm-time" data-otm-end>0:00</span>
          </div>

          <div class="otm-controls">
            <button class="otm-btn" type="button" data-otm-action="prev" aria-label="Назад">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6v12L8 12z"/><path d="M6 5v14"/></svg>
            </button>
            <button class="otm-btn otm-btn--play" type="button" data-otm-action="toggle" aria-label="Слушать">
              <svg class="otm-icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
              <svg class="otm-icon-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
            </button>
            <button class="otm-btn" type="button" data-otm-action="next" aria-label="Вперёд">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6v12l10-6z"/><path d="M18 5v14"/></svg>
            </button>
            <button class="otm-btn otm-btn--repeat" type="button" data-otm-action="repeat" aria-label="Повтор" aria-pressed="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
            </button>
          </div>

          <div class="otm-volume">
            <button class="otm-vol-btn" type="button" data-otm-action="mute" aria-label="Без звука">
              <svg class="otm-vol-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path class="otm-vol-wave" d="M15 9a4 4 0 0 1 0 6"/><path class="otm-vol-wave" d="M18 6a8 8 0 0 1 0 12"/></svg>
              <svg class="otm-vol-muted" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/></svg>
            </button>
            <div class="otm-vol-track" data-otm-voltrack tabindex="0" role="slider" aria-label="Громкость" aria-valuemin="0" aria-valuemax="100" aria-valuenow="80">
              <div class="otm-vol-fill" data-otm-volfill></div>
              <div class="otm-vol-knob" data-otm-volknob></div>
            </div>
          </div>
        </section>

        <section class="otm-lyrics" aria-label="Текст песни">
          <div class="otm-lyrics__fade otm-lyrics__fade--top" aria-hidden="true"></div>
          <div class="otm-lyrics__scroll" data-otm-scroll>
            <div class="otm-lyrics__inner" data-otm-lines>
              <p class="otm-lyrics__hint">Текст песни появится, когда заиграет трек.</p>
            </div>
          </div>
          <div class="otm-lyrics__fade otm-lyrics__fade--bottom" aria-hidden="true"></div>
        </section>
      </main>
    </div>
  `;
}

function ensureRoot() {
  if (root) return root;
  root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'otm';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = template();
  document.body.appendChild(root);
  bindControls(root);
  return root;
}

/* ---------------- управление ---------------- */

function applyRepeat() {
  const target = repeatOn ? 'one' : 'off';
  for (let i = 0; i < 4 && state.settings.repeat !== target; i += 1) cycleRepeat();
}

function bindControls(el) {
  el.addEventListener('click', (event) => {
    const button = event.target.closest('[data-otm-action]');
    if (!button) return;
    const action = button.dataset.otmAction;
    if (action === 'toggle') toggle();
    else if (action === 'next') next();
    else if (action === 'prev') previous();
    else if (action === 'close') setMode('default');
    else if (action === 'mute') { toggleMute(); renderVolume(); }
    else if (action === 'like') {
      const track = getTrack();
      if (!track || !track.id) return;
      toggleLiked(track.id);
      renderLike(track);
    } else if (action === 'repeat') {
      repeatOn = !repeatOn;
      applyRepeat();
      button.setAttribute('aria-pressed', String(repeatOn));
      button.classList.toggle('is-on', repeatOn);
    }
  });

  const seekTrack = el.querySelector('[data-otm-track]');
  seekTrack.addEventListener('click', (event) => {
    const rect = seekTrack.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const track = getTrack();
    seek(ratio * ((track && track.duration) || 0));
  });
  seekTrack.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    seek(safeNow() + (event.key === 'ArrowRight' ? 5 : -5));
  });

  const vol = el.querySelector('[data-otm-voltrack]');
  const setFromEvent = (event) => {
    const rect = vol.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    if (state.settings.muted && ratio > 0) toggleMute();
    setVolume(ratio);
    renderVolume();
  };
  let dragging = false;
  vol.addEventListener('pointerdown', (event) => {
    dragging = true;
    vol.setPointerCapture(event.pointerId);
    setFromEvent(event);
  });
  vol.addEventListener('pointermove', (event) => {
    if (dragging) setFromEvent(event);
  });
  vol.addEventListener('pointerup', (event) => {
    dragging = false;
    try { vol.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
  });
  vol.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const base = state.settings.muted ? 0 : state.settings.volume;
    setVolume(Math.min(1, Math.max(0, base + (event.key === 'ArrowRight' ? 0.05 : -0.05))));
    renderVolume();
  });

  // Прокрутка колесом над текстом — ручная, автопрокрутка на паузу.
  el.querySelector('[data-otm-scroll]').addEventListener('wheel', () => {
    userScrollUntil = Date.now() + 4000;
  }, { passive: true });
}

/* ---------------- рендер ---------------- */

function renderTrack(track) {
  if (!root) return;
  const cover = root.querySelector('[data-otm-cover]');
  const title = root.querySelector('[data-otm-title]');
  const artist = root.querySelector('[data-otm-artist]');
  const end = root.querySelector('[data-otm-end]');

  if (!track) {
    cover.innerHTML = '<span class="otm-cover__empty">♪</span>';
    title.textContent = 'Ничего не играет';
    artist.textContent = 'Выберите трек в стандартном виде';
    end.textContent = '0:00';
    applyAmbient(null);
    renderLike(null);
    return;
  }
  const image = track.coverBig || track.cover || '';
  cover.innerHTML = image
    ? `<img src="${escapeHtml(image)}" alt="" data-otm-cover-img>`
    : '<span class="otm-cover__empty">♪</span>';
  title.textContent = track.title || 'Без названия';
  artist.textContent = track.artist || '';
  end.textContent = fmt(track.duration || 0);
  renderLike(track);
  applyAmbient(null);
  dominantColors(image).then(applyAmbient);
}

function renderLike(track) {
  if (!root) return;
  const button = root.querySelector('[data-otm-action="like"]');
  const on = Boolean(track && isLiked(track.id));
  button.classList.toggle('is-liked', on);
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', on ? 'Убрать лайк' : 'Лайк');
  button.disabled = !track;
}

function renderState(playing) {
  if (!root) return;
  const button = root.querySelector('[data-otm-action="toggle"]');
  button.classList.toggle('is-playing', Boolean(playing));
  button.setAttribute('aria-label', playing ? 'Пауза' : 'Слушать');
}

function renderVolume() {
  if (!root) return;
  const muted = Boolean(state.settings.muted);
  const value = muted ? 0 : Math.min(1, Math.max(0, Number(state.settings.volume) || 0));
  root.querySelector('[data-otm-volfill]').style.width = `${value * 100}%`;
  root.querySelector('[data-otm-volknob]').style.left = `${value * 100}%`;
  root.querySelector('[data-otm-voltrack]').setAttribute('aria-valuenow', String(Math.round(value * 100)));
  root.classList.toggle('is-muted', muted);
}

function renderProgress() {
  if (!root) return;
  const track = getTrack();
  const now = safeNow();
  const duration = (track && track.duration) || 0;
  const ratio = duration > 0 ? Math.min(1, Math.max(0, now / duration)) : 0;
  root.querySelector('[data-otm-fill]').style.width = `${ratio * 100}%`;
  root.querySelector('[data-otm-knob]').style.left = `${ratio * 100}%`;
  root.querySelector('[data-otm-now]').textContent = fmt(now);
  root.querySelector('[data-otm-track]').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  if (duration) root.querySelector('[data-otm-end]').textContent = fmt(duration);
  highlight(now);
}

function renderClock() {
  const el = root && root.querySelector('[data-otm-clock]');
  if (!el) return;
  const now = new Date();
  el.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  el.setAttribute('datetime', now.toISOString());
}

/* ---------------- текст ---------------- */

function paintLines(synced) {
  if (!root) return;
  const holder = root.querySelector('[data-otm-lines]');
  if (!lines.length) {
    holder.innerHTML = '<p class="otm-lyrics__hint">Текст не найден. Попробуйте другой трек или зайдите позже.</p>';
    return;
  }
  holder.innerHTML = lines
    .map((line, i) => {
      if (!synced || !line.words) {
        return `<p class="otm-line otm-line--plain" data-otm-line="${i}">${escapeHtml(line.text)}</p>`;
      }
      const words = line.words
        .map((word, wi) => `<span class="otm-word" data-otm-word="${wi}">${escapeHtml(word.text)}</span>`)
        .join(' ');
      return `<p class="otm-line" data-otm-line="${i}">${words}</p>`;
    })
    .join('');
  activeLine = -1;
  activeWord = -1;
}

function highlight(time) {
  if (!root || !lines.length) return;
  const synced = lines.some((l) => l.time !== null && Array.isArray(l.words));
  if (!synced) {
    const track = getTrack();
    const duration = (track && track.duration) || 0;
    if (!duration) return;
    const index = Math.min(lines.length - 1, Math.floor((time / duration) * lines.length));
    setActiveLine(index, -1);
    return;
  }

  let lineIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].time <= time + 0.12) lineIndex = i;
    else break;
  }
  if (lineIndex < 0) {
    setActiveLine(-1, -1);
    return;
  }
  const line = lines[lineIndex];
  let wordIndex = -1;
  if (line && Array.isArray(line.words)) {
    for (let i = 0; i < line.words.length; i += 1) {
      if (line.words[i].time <= time + 0.08) wordIndex = i;
      else break;
    }
  }
  setActiveLine(lineIndex, wordIndex);
}

function setActiveLine(lineIndex, wordIndex) {
  if (lineIndex === activeLine && wordIndex === activeWord) return;
  const lineChanged = lineIndex !== activeLine;
  activeLine = lineIndex;
  activeWord = wordIndex;
  const holder = root.querySelector('[data-otm-lines]');
  if (!holder) return;

  if (lineChanged) {
    holder.querySelectorAll('.otm-line').forEach((el, i) => {
      const on = i === lineIndex;
      el.classList.toggle('active', on);
      el.setAttribute('aria-current', on ? 'true' : 'false');
    });
  }
  const activeEl = holder.querySelector('.otm-line.active');
  if (activeEl) {
    activeEl.querySelectorAll('.otm-word').forEach((el, i) => {
      el.classList.toggle('is-sung', i < wordIndex);
      el.classList.toggle('is-active', i === wordIndex);
    });
    if (lineChanged && Date.now() > userScrollUntil) {
      try {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch {
        activeEl.scrollIntoView();
      }
    }
  }
}

async function loadLyrics(track) {
  if (!root) return;
  if (!track || !track.id) {
    lines = [];
    paintLines(false);
    return;
  }
  if (currentLyricsFor === track.id) return;
  currentLyricsFor = track.id;
  const token = ++lyricsToken;
  lines = [];
  activeLine = -1;
  root.querySelector('[data-otm-lines]').innerHTML = '<p class="otm-lyrics__hint">Ищем текст песни…</p>';

  const fromLrclib = await fetchFromLrclib(track);
  if (token !== lyricsToken) return;

  let source = fromLrclib && fromLrclib.lyrics;
  if (!source) {
    try {
      const response = await fetch(`/api/lyrics?id=${encodeURIComponent(track.id)}`);
      const data = response.ok ? await response.json() : { lyrics: '' };
      source = data.lyrics || '';
    } catch {
      source = '';
    }
  }
  if (token !== lyricsToken) return;

  const parsed = parseLrc(source);
  if (parsed && parsed.length) {
    lines = parsed;
    paintLines(true);
  } else {
    lines = plainLines(source);
    paintLines(false);
  }
  activeLine = -1;
  highlight(safeNow());
}

/* ---------------- режим ---------------- */

function setMode(mode) {
  const onlyText = mode === 'text';
  const el = ensureRoot();
  el.classList.toggle('is-open', onlyText);
  el.setAttribute('aria-hidden', String(!onlyText));
  document.documentElement.dataset.view = onlyText ? 'text' : 'default';
  const standard = document.getElementById('player');
  if (standard) standard.setAttribute('aria-hidden', String(onlyText));
  const app = document.querySelector('.app');
  if (app) app.setAttribute('aria-hidden', String(onlyText));
  document.body.classList.toggle('otm-active', onlyText);
  try { localStorage.setItem(VIEW_KEY, onlyText ? 'text' : 'default'); } catch { /* ignore */ }
  updateSwitchButton(onlyText);

  if (onlyText) {
    renderTrack(getTrack());
    renderState(isPlaying());
    renderVolume();
    renderProgress();
    renderClock();
    loadLyrics(getTrack());
    window.clearInterval(pollTimer);
    pollTimer = window.setInterval(renderProgress, 100);
    window.clearInterval(clockTimer);
    clockTimer = window.setInterval(renderClock, 15000);
  } else {
    window.clearInterval(pollTimer);
    window.clearInterval(clockTimer);
    pollTimer = 0;
    clockTimer = 0;
  }
}

function updateSwitchButton(onlyText) {
  const button = document.getElementById('otmSwitch');
  if (!button) return;
  button.textContent = onlyText ? 'Стандартный вид' : 'Только текст';
  button.setAttribute('aria-pressed', String(onlyText));
}

/* ---------------- запуск ---------------- */

function start() {
  ensureRoot();
  updateSwitchButton(false);

  const switchBtn = document.getElementById('otmSwitch');
  if (switchBtn) {
    switchBtn.addEventListener('click', (event) => {
      event.preventDefault();
      window.__pulseOnlyText.toggle();
    });
  }

  playerOn('track', ({ track }) => {
    renderTrack(track);
    loadLyrics(track);
  });
  playerOn('state', ({ playing }) => renderState(playing));
  playerOn('volume', () => renderVolume());
  playerOn('time', () => {
    if (root && root.classList.contains('is-open')) renderProgress();
  });

  // Колесо мыши над текстом не должно дёргать автопрокрутку.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root && root.classList.contains('is-open')) setMode('default');
  });

  let saved = 'default';
  try { saved = localStorage.getItem(VIEW_KEY) || 'default'; } catch { /* ignore */ }
  if (saved === 'text') setMode('text');
}

window.__pulseOnlyText = {
  enable: () => setMode('text'),
  disable: () => setMode('default'),
  toggle: () => setMode(root && root.classList.contains('is-open') ? 'default' : 'text'),
  parseLrc,
  isOpen: () => Boolean(root && root.classList.contains('is-open')),
  liked: readLiked,
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
