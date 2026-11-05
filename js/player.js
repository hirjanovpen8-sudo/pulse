/* ============================================================
   PULSE · аудиодвижок на официальном плеере YouTube (IFrame API).
   Он сам решает вопросы потоков и режимов предпросмотра,
   поэтому треки играют целиком, без подписок и токенов.
   ============================================================ */

import { clamp, storage } from './util.js';

const bus = new EventTarget();
const emit = (name, detail = {}) => bus.dispatchEvent(new CustomEvent(name, { detail }));

export function playerOn(name, fn) {
  const wrapped = (e) => fn(e.detail);
  bus.addEventListener(name, wrapped);
  return () => bus.removeEventListener(name, wrapped);
}

/* Состояние настроек плеера: живёт в localStorage, доступно всем модулям. */
export const state = {
  settings: {
    volume: 0.8,
    muted: false,
    shuffle: false,
    repeat: 'off',
    autoplay: true,
  },
};

function setSetting(key, value) {
  state.settings[key] = value;
  storage.set('pulse.settings', state.settings);
}

function loadSettings() {
  const saved = storage.get('pulse.settings', null);
  if (saved && typeof saved === 'object') {
    for (const key of Object.keys(state.settings)) {
      if (key in saved) state.settings[key] = saved[key];
    }
  }
  if (!['off', 'all', 'one'].includes(state.settings.repeat)) state.settings.repeat = 'off';
  state.settings.volume = clamp(Number(state.settings.volume) || 0, 0, 1);
  state.settings.shuffle = Boolean(state.settings.shuffle);
  state.settings.autoplay = state.settings.autoplay !== false;
}

/* ---------------- очередь и трек ---------------- */

let playQueue = [];
let baseQueue = [];
let index = -1;
let currentTrack = null;
let contextLabel = '';
let playing = false;
let rafId = 0;
let lastEmit = 0;
let askedMore = false;
let pendingNext = false;
let failed = new Set();
let requestId = 0;
let loading = false;

export const getTrack = () => currentTrack;
export const getQueue = () => playQueue;
export const getIndex = () => index;
export const getContext = () => contextLabel;
export const isPlaying = () => playing;
export const getCurrentTime = () => (player ? player.getCurrentTime() || 0 : 0);

/* ---------------- youtube iframe engine ---------------- */

let player = null;
let playerReady = null;
let playerWanted = false;
let pendingTrack = null;
let pendingAutoplay = false;
let startedSent = false;
let skipTimer = 0;

const YT_ERROR_SKIP = new Set([2, 100, 101, 150]);

function hostElement() {
  let host = document.getElementById('ytHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ytHost';
    host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(host);
  }
  return host;
}

function ensurePlayer() {
  if (playerReady) return playerReady;
  if (!playerWanted) {
    playerWanted = true;
    ensurePlayerCreate();
  }
  return playerReady;
}

function ensurePlayerCreate() {
  const boot = () => {
    if (playerReady || player) return;
    /* Создаём плеер сразу с видео, если трек уже выбран. Контейнер обязан
       находиться в зоне видимости, иначе YouTube отвечает ошибкой 150.
       autoplay включаем, только если звук уже разрешён жестом:
       на мобильных автозапуск без жеста блокируется браузером. */
    player = new YT.Player('ytHost', {
      width: 320,
      height: 180,
      videoId: pendingTrack ? pendingTrack.track.id : '',
      host: 'https://www.youtube.com',
      playerVars: {
        enablejsapi: 1,
        origin: location.origin,
        autoplay: window.__pulseAudioUnlocked ? 1 : 0,
        controls: 0,
        disablekb: 1,
        playsinline: 1,
        'webkit-playsinline': 1,
      },
      events: {
        onReady: () => {
          try { player.setVolume(Math.round((state.settings.muted ? 0 : state.settings.volume) * 100)); } catch { /* ignore */ }
          pendingTrack = null;
          playerReady = player;
          emit('playerready', {});
        },
        onStateChange: (e) => handlePlayerState(e.data),
        onError: (e) => handlePlayerError(e.data),
      },
    });
  };
  if (window.YT && window.YT.Player) {
    boot();
    return;
  }
  /* API грузится динамически: перехватываем глобальный колбэк запуска. */
  const prevReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => {
    if (typeof prevReady === 'function') prevReady();
    boot();
  };
  if (!document.getElementById('ytApiScript')) {
    const script = document.createElement('script');
    script.id = 'ytApiScript';
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(script);
  }
}

function safePlay() {
  try {
    if (!player || !player.playVideo) return;
    player.playVideo();
  } catch { /* ignore */ }
}

/**
 * Запускает воспроизведение с учётом мобильных ограничений.
 * Если звук ещё не разрешён жестом, ставим видео на паузу и ждём
 * первый тап — после него плеер сам продолжит.
 */
function playWhenAllowed(track) {
  const start = () => {
    // Жест получен: автоплей разрешён, поэтому запускаем сразу.
    try {
      player.loadVideoById(track.id);
    } catch {
      safePlay();
    }
    safePlay();
  };

  if (window.__pulseAudioUnlocked || !window.pulseWhenAudioAllowed) {
    start();
    return;
  }

  // Звук ещё заблокирован: готовим видео без автозапуска.
  try {
    player.cueVideoById(track.id);
  } catch { /* ignore */ }
  emit('buffering', { buffering: false });
  if (window.pulseWhenAudioAllowed) window.pulseWhenAudioAllowed(() => {
    if (currentTrack && currentTrack.id === track.id) start();
  });
}

function loadTrack(track, autoplay) {
  try {
    if (autoplay === false) {
      player.cueVideoById(track.id);
      return;
    }
    playWhenAllowed(track);
  } catch (err) {
    emit('error', { message: 'Плеер не запустился, попробуйте ещё раз', detail: String(err) });
  }
}

function handlePlayerState(s) {
  // 0 ended · 1 playing · 2 paused · 3 buffering · 5 cued
  if (s === 1) {
    if (failed.size) failed = new Set();
    loading = false;
    emit('buffering', { buffering: false });
    if (!playing) {
      playing = true;
      emit('state', { playing });
      if (currentTrack && !startedSent) {
        startedSent = true;
        emit('started', { track: currentTrack });
      }
    }
    applyVolume();
  } else if (s === 3) {
    emit('buffering', { buffering: true });
  } else if (s === 0) {
    onEnded();
  } else if (s === 2) {
    loading = false;
    emit('buffering', { buffering: false });
    if (playing) {
      playing = false;
      emit('state', { playing });
    }
  } else if (s === 5) {
    loading = false;
    emit('buffering', { buffering: false });
  }
}

function handlePlayerError(code) {
  if (!currentTrack) return;
  emit('buffering', { buffering: false });
  if (YT_ERROR_SKIP.has(code)) {
    loading = false;
    failed.add(currentTrack.id);
    emit('error', { message: `«${currentTrack.title || 'Трек'}» недоступен`, track: currentTrack });
    clearTimeout(skipTimer);
    skipTimer = window.setTimeout(() => {
      if (playQueue.length > 1 || state.settings.repeat === 'all') advance({ manual: true });
    }, 350);
  } else {
    emit('error', { message: 'Трек временно недоступен', track: currentTrack });
  }
}

function applyVolume() {
  if (!player || !player.setVolume) return;
  const target = state.settings.muted ? 0 : clamp(Number(state.settings.volume) || 0, 0, 1);
  try {
    player.setVolume(Math.round(target * 100));
    if (target <= 0) player.mute();
    else player.unMute();
  } catch { /* ignore */ }
}

/* ---------------- media session ---------------- */

function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || !track) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || 'Pulse',
      artwork: track.coverBig ? [{ src: track.coverBig, sizes: '500x500', type: 'image/jpeg' }] : [],
    });
  } catch { /* ignore */ }
}

function bindMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => resume(),
    pause: () => pause(),
    previoustrack: () => previous(),
    nexttrack: () => next(),
    stop: () => pause(),
    seekto: (details) => {
      if (details && Number.isFinite(details.seekTime)) seek(details.seekTime);
    },
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch { /* unsupported action */ }
  }
}

/* ---------------- feedback (статистика.listen) ---------------- */

export function sendFeedback(action, entry, position, { keepalive = true } = {}) {
  const track = entry || currentTrack;
  if (!track || !track.id) return;
  try {
    fetch('/api/feedback', {
      method: 'POST',
      keepalive,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        id: track.id,
        position: Math.round(Number(position) || 0),
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        duration: Number(track.duration) || 0,
        cover: track.cover || '',
        coverBig: track.coverBig || '',
      }),
    }).catch(() => {});
  } catch { /* сеть недоступна */ }
}

/**
 * Сигнал «трек закончился»: дослушан целиком — позитив, скип до 30 секунд — негатив.
 * Уходит ровно один раз на трек.
 */
function emitListenSignal(track, position, duration) {
  if (!track || !track.id) return;
  const played = Number(position) || 0;
  const total = Number(duration) || Number(track.duration) || 0;
  if (total > 0 && played >= total * 0.9) sendFeedback('complete', track, played);
  else if (played < 30) sendFeedback('skip', track, played);
}

/* ---------------- queue helpers ---------------- */

function shuffleArray(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function emitQueue() {
  emit('queue', {
    queue: playQueue,
    index,
    upcoming: playQueue.slice(index + 1),
  });
}

function reorderForShuffle(on, keepIndex) {
  const currentId = playQueue[keepIndex]?.id;
  if (on) {
    baseQueue = playQueue.slice();
    const current = playQueue[keepIndex];
    if (!current) return;
    const rest = baseQueue.filter((t) => t.id !== current.id);
    playQueue = [current, ...shuffleArray(rest)];
    index = 0;
  } else if (baseQueue.length) {
    const extra = playQueue.filter((t) => !baseQueue.some((b) => b.id === t.id));
    playQueue = [...baseQueue, ...extra];
    index = currentId ? playQueue.findIndex((t) => t.id === currentId) : 0;
    if (index < 0) index = 0;
  }
  emitQueue();
}

/* ---------------- playback ---------------- */

export function initPlayer() {
  if (rafId) return;
  loadSettings();
  ensurePlayer();
  window.__pulsePlayer = { get player() { return player; }, get ready() { return Boolean(playerReady); }, get pending() { return pendingTrack; } };
  bindMediaSession();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

export async function playTracks(tracks, startIndex = 0, label = '') {
  const list = (Array.isArray(tracks) ? tracks : []).filter((t) => t && t.id);
  if (!list.length) {
    emit('error', { message: 'Здесь нет треков для воспроизведения' });
    return;
  }
  const start = clamp(Number(startIndex) || 0, 0, list.length - 1);
  failed = new Set();
  playQueue = list.slice();
  baseQueue = list.slice();
  index = start;
  contextLabel = label;
  askedMore = false;
  pendingNext = false;
  if (state.settings.shuffle) {
    const chosen = playQueue[start];
    const rest = playQueue.filter((_, i) => i !== start);
    playQueue = [chosen, ...shuffleArray(rest)];
    index = 0;
  }
  emitQueue();
  startTrack(playQueue[index]);
}

export function startTrack(track) {
  if (!track) return;
  requestId += 1;
  currentTrack = track;
  playing = false;
  loading = true;
  startedSent = false;
  updateMediaSession(track);
  emit('track', { track, index, queue: playQueue, context: contextLabel });
  emit('state', { playing: false });
  emit('buffering', { buffering: true });
  sendFeedback('play', track, 0);
  emit('time', { current: 0, duration: track.duration || 0, buffered: 0, playing: false });

  if (player && player.loadVideoById) {
    loadTrack(track, true);
    applyVolume();
  } else {
    pendingTrack = { track, autoplay: true };
  }
}

function advance({ manual = false } = {}) {
  if (!playQueue.length) return;
  if (loading && !manual) return;
  if (currentTrack && manual) {
    emitListenSignal(currentTrack, getCurrentTime(), player ? player.getDuration() : currentTrack.duration);
  }
  if (state.settings.repeat === 'one' && !manual) {
    try { player.seekTo(0, true); player.playVideo(); } catch { /* ignore */ }
    return;
  }

  let nextIdx = index + 1;
  if (nextIdx >= playQueue.length) {
    if (state.settings.repeat === 'all') {
      nextIdx = 0;
    } else if (state.settings.autoplay) {
      // Очередь закончилась: просим ещё треки у сервера и продолжим, когда они придут.
      pendingNext = true;
      askedMore = true;
      emit('needmore', { track: currentTrack });
      return;
    } else {
      return;
    }
  }
  index = nextIdx;
  emitQueue();
  startTrack(playQueue[index]);
}

function onEnded() {
  const track = currentTrack;
  if (!track) return;
  emitListenSignal(track, getCurrentTime(), player ? player.getDuration() : track.duration);

  // Трек закончился: переключаемся на следующий (или подгружаем новые).
  if (state.settings.repeat === 'one') {
    try { player.seekTo(0, true); player.playVideo(); } catch { /* ignore */ }
    return;
  }
  advance({ manual: false });
}

/* ---------------- controls ---------------- */

export function toggle() {
  if (!currentTrack) return false;
  // Источник истины — состояние самого плеера, а не наш флаг.
  let stateNow = null;
  try { stateNow = player && player.getPlayerState ? player.getPlayerState() : null; } catch { stateNow = null; }
  if (stateNow === 1 || stateNow === 3) pause();
  else resume();
  return true;
}

export function resume() {
  if (!currentTrack) return;
  ensurePlayer();
  if (failed.has(currentTrack.id) && index >= 0 && playQueue[index] && playQueue[index].id === currentTrack.id) {
    failed.delete(currentTrack.id);
    return startTrack(currentTrack);
  }
  // На мобильных вызываем запуск после жеста: resume() чаще всего
  // дёргается из обработчика кнопки, так что это уже пользовательский жест.
  if (window.pulseWhenAudioAllowed && !window.__pulseAudioUnlocked) {
    window.pulseWhenAudioAllowed(() => safePlay());
    // Пробуем и сразу — если браузер разрешит, звук пойдёт без задержки.
  }
  safePlay();
  playing = true;
  emit('state', { playing });
}

export function pause() {
  if (!currentTrack) playing = false;
  loading = false;
  emit('buffering', { buffering: false });
  try {
    if (player && player.pauseVideo) player.pauseVideo();
  } catch { /* ignore */ }
  playing = false;
  emit('state', { playing });
}

export function next() {
  advance({ manual: true });
}

export function previous() {
  if (!playQueue.length) return;
  if (getCurrentTime() > 3) {
    seek(0);
    return;
  }
  if (index > 0) {
    index -= 1;
  } else if (state.settings.repeat === 'all') {
    index = playQueue.length - 1;
  } else {
    seek(0);
    return;
  }
  emitQueue();
  startTrack(playQueue[index]);
}

export function seek(seconds) {
  if (!player || !currentTrack) return;
  const dur = player.getDuration() || currentTrack.duration;
  const target = clamp(Number(seconds) || 0, 0, Math.max(0, dur - 0.15));
  try { player.seekTo(target, true); } catch { /* ignore */ }
  emit('time', { current: target, duration: dur, buffered: 0, playing });
}

export function setVolume(value, { persist = true } = {}) {
  const v = clamp(Number(value) || 0, 0, 1);
  if (persist) {
    setSetting('volume', v);
    if (v > 0 && state.settings.muted) setSetting('muted', false);
  }
  applyVolume();
  emit('volume', { volume: v, muted: state.settings.muted });
}

export function toggleMute() {
  setSetting('muted', !state.settings.muted);
  applyVolume();
  emit('volume', { volume: state.settings.volume, muted: state.settings.muted });
}

/** Скорость воспроизведения: 0.25…2, шаг 0.25. */
export function setPlaybackRate(rate) {
  const value = Math.min(2, Math.max(0.25, Math.round((Number(rate) || 1) * 100) / 100));
  try {
    if (player && player.setPlaybackRate) player.setPlaybackRate(value);
  } catch { /* ignore */ }
  emit('rate', { rate: value });
  return value;
}

export function getPlaybackRate() {
  try {
    return (player && player.getPlaybackRate && player.getPlaybackRate()) || 1;
  } catch {
    return 1;
  }
}

/** Размер кадра текущего видео: нужен для корректного снимка кадра. */
export function getVideoSize() {
  try {
    const data = player && player.getVideoData && player.getVideoData();
    return { width: (data && data.videoWidth) || 640, height: (data && data.videoHeight) || 360 };
  } catch {
    return { width: 640, height: 360 };
  }
}

/** Субтитры: переключает дорожку, отдавая управление штатному модулю плеера. */
let subtitlesOn = false;

export function playerToggleSubtitles() {
  subtitlesOn = !subtitlesOn;
  try {
    if (!player) return subtitlesOn;
    if (subtitlesOn) {
      player.loadModule('captions');
      player.setOption('captions', 'track', {});
      player.setOption('captions', 'reload', true);
    } else {
      player.unloadModule('captions');
    }
  } catch { /* модуль субтитров недоступен в этом ролике */ }
  return subtitlesOn;
}

export function setShuffle(on) {
  setSetting('shuffle', Boolean(on));
  reorderForShuffle(Boolean(on), index);
}

export function toggleShuffle() {
  setShuffle(!state.settings.shuffle);
}

export function setRepeat(mode) {
  const nextMode = ['off', 'all', 'one'].includes(mode) ? mode : 'off';
  setSetting('repeat', nextMode);
}

export function cycleRepeat() {
  const order = ['off', 'all', 'one'];
  const current = order.indexOf(state.settings.repeat);
  setRepeat(order[(current + 1) % order.length]);
}

/** Удаление трека из очереди по id: стабильно при живых перестановках. */
export function removeTrackById(id) {
  const at = playQueue.findIndex((t) => t.id === id);
  if (at <= index) return false;
  const [removed] = playQueue.splice(at, 1);
  const bIdx = baseQueue.findIndex((t) => t.id === removed.id);
  if (bIdx >= 0) baseQueue.splice(bIdx, 1);
  emitQueue();
  return true;
}

export function appendTracks(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) return 0;
  let added = 0;
  for (const track of tracks) {
    if (!track || !track.id) continue;
    if (playQueue.some((t) => t.id === track.id)) continue;
    playQueue.push(track);
    baseQueue.push(track);
    added += 1;
  }
  if (added) {
    emitQueue();
    if (pendingNext) {
      pendingNext = false;
      advance({ manual: true });
    }
  }
  return added;
}

/* ---------------- tick ---------------- */

function tick() {
  rafId = requestAnimationFrame(tick);

  const now = performance.now();
  if (currentTrack && now - lastEmit > 180) {
    lastEmit = now;
    const duration = (player && player.getDuration ? player.getDuration() : 0) || currentTrack.duration || 0;
    emit('time', { current: getCurrentTime(), duration, buffered: 0, playing });
  }
  if (loading && playerReady && currentTrack && (player.getPlayerState?.() ?? -1) === -1) {
    // Плеер готов, но видео не загрузилось — высвобождаем блокировку UI.
    loading = false;
    emit('buffering', { buffering: false });
  }

  if (!playing || loading || !currentTrack) return;
  const duration = (player && player.getDuration ? player.getDuration() : 0) || currentTrack.duration;
  if (!duration) return;
  const remain = duration - getCurrentTime();

  const isLast = index >= playQueue.length - 1;
  if (state.settings.autoplay && isLast && remain < 18 && remain > 2 && !askedMore) {
    askedMore = true;
    emit('needmore', { track: currentTrack });
  }

  if (state.settings.repeat === 'one') {
    if (remain <= 0.2) seek(0);
    return;
  }

  if (remain <= 0.35 && remain > 0.05) {
    if (index + 1 < playQueue.length || state.settings.repeat === 'all') {
      advance({ manual: false });
    }
  }
}
