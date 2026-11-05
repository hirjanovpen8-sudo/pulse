/* ============================================================
   PULSE · utilities
   ============================================================ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtLong(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

export function fmtCount(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return '0';
  if (num >= 1e9) return `${(num / 1e9).toFixed(1).replace('.0', '')}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1).replace('.0', '')}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1).replace('.0', '')}K`;
  return String(num);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function debounce(fn, wait = 300) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/** Deterministic 32-bit hash -> stable pseudo-random number. */
export function hashNum(input, min, max) {
  const str = String(input);
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  const value = (h >>> 0) / 4294967295;
  return min + Math.round(value * (max - min));
}

/** Estimated BPM (Deezer previews do not expose BPM, so we derive a stable, plausible value). */
export function bpmFor(track) {
  if (!track) return 0;
  return hashNum(`bpm:${track.id}`, 92, 138);
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ---------------- transliteration (RU <-> Latin) ---------------- */

const RU_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const LAT_MAP = {
  shch: 'щ', sch: 'щ', zh: 'ж', kh: 'х', ts: 'ц', ch: 'ч', sh: 'ш', yo: 'ё',
  yu: 'ю', ya: 'я', ye: 'е', a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф',
  g: 'г', h: 'х', i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о',
  p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс',
  y: 'ы', z: 'з', "'": 'ь',
};

/** «жанулька» -> «zhanulka» (so international catalogues can be searched). */
export function translitRu(text) {
  return String(text || '')
    .split('')
    .map((ch) => {
      const lower = ch.toLowerCase();
      if (!(lower in RU_MAP)) return ch;
      const mapped = RU_MAP[lower];
      return ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    })
    .join('')
    .replace(/[’']/g, '');
}

/** «zhanulka» -> «жанулька» (best-effort reverse). */
export function translitLatin(text) {
  const src = String(text || '').toLowerCase();
  let out = '';
  let i = 0;
  const keys = Object.keys(LAT_MAP).sort((a, b) => b.length - a.length);
  while (i < src.length) {
    const key = keys.find((k) => src.startsWith(k, i));
    if (key) {
      out += LAT_MAP[key];
      i += key.length;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

const hasCyrillic = (text) => /[а-яё]/i.test(String(text || ''));
const hasLatin = (text) => /[a-z]/i.test(String(text || ''));

/** Query spelling variants used to widen search results. */
export function queryVariants(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const out = [q];
  if (hasCyrillic(q)) {
    const latin = translitRu(q);
    if (latin && latin !== q) out.push(latin);
    // Also add a version without soft signs / doubled letters.
    const loose = latin.replace(/kh/g, 'h').replace(/yu/g, 'u').replace(/ya/g, 'a');
    if (loose !== latin) out.push(loose);
  } else if (hasLatin(q)) {
    const cyr = translitLatin(q);
    if (cyr && cyr !== q) out.push(cyr);
  }
  return [...new Set(out.filter((v) => v && v.length > 1))];
}

/* ---------------- local storage ---------------- */

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch { /* ignore */ }
  },
};

/* ---------------- icons ---------------- */

export const ICONS = {
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>',
  heart: '<path d="M12 21s-8-4.9-8-10a4.6 4.6 0 0 1 8-2.9A4.6 4.6 0 0 1 20 11c0 5.1-8 10-8 10z"/>',
  dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  queue: '<path d="M4 7h11M4 12h11M4 17h7"/><path d="M18 9v8"/>',
  shuffle: '<path d="M3 6h4l10 12h4M3 18h4L17 6h4"/><path d="m18 3 3 3-3 3M18 15l3 3-3 3"/>',
  repeat: '<path d="M17 3l4 4-4 4"/><path d="M3 11V9a2 2 0 0 1 2-2h16"/><path d="M7 21l-4-4 4-4"/><path d="M21 13v2a2 2 0 0 1-2 2H3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  album: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/>',
  artist: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
  playlist: '<path d="M4 6h12M4 11h12M4 16h8"/><path d="M19 9v8"/><circle cx="17.5" cy="18.5" r="1.6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  radio: '<circle cx="12" cy="12" r="2.4"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  sleep: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  vol: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15 9a4 4 0 0 1 0 6"/><path d="M18 6a8 8 0 0 1 0 12"/>',
  mute: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87M4.6 9a1.7 1.7 0 0 0-.34-1.87"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-7H9v7H3z"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  equalizer: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  music: '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  sleepMoon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  list: '<path d="M4 6h10M4 12h10M4 18h6"/><path d="M19 9v6M19 9l3 1"/>',
  lyrics: '<path d="M4 5h16v11H9l-4 4z"/><path d="M8 9h8M8 12h5"/>',
  quality: '<path d="M4 17V9M9 17V5M14 17v-6M19 17V8"/>',
  volumeOff: '<path d="M5 9H3v6h2l4 3V6z"/><path d="m15 9 5 6M20 9l-5 6"/>',
  headphones: '<path d="M4 16v-4a8 8 0 0 1 16 0v4"/><path d="M4 16h3v4H4zM17 16h3v4h-3z"/>',
  downloadOff: '<path d="M12 3v10M8 9l4 4 4-4"/><path d="M4 20h16"/>',
  prevTrack: '<path d="M18 5v14L8 12z"/><path d="M5 5v14"/>',
  nextTrack: '<path d="M6 5v14l10-7z"/><path d="M19 5v14"/>',
};

export function icon(name, cls = '') {
  const body = ICONS[name] || ICONS.music;
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

export const ACCENTS = [
  { id: 'yellow', color: '#FFD600', label: 'Жёлтый' },
  { id: 'white', color: '#FFFFFF', label: 'Белый' },
];

/** Метка профиля: первая буква, заглушка если её нет. */
export function initial(text) {
  const ch = String(text || '').trim().charAt(0);
  return ch ? ch.toUpperCase() : 'P';
}
