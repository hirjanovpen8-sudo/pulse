/* ============================================================
   PULSE · генератор данных для GitHub Pages.
   Запускается в GitHub Actions: тянет каталог YouTube Music,
   раскладывает результат статическими JSON-файлами.
   Сайту больше не нужен отдельный сервер.
   ============================================================ */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = process.argv[2] || 'out';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const CLIENT = {
  userAgent: USER_AGENT,
  context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20241009.01.00', hl: 'ru', gl: 'RU' } },
  headers: { 'X-Youtube-Client-Name': '67', 'X-Youtube-Client-Version': '1.20241009.01.00' },
  searchParams: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
};

const CHART_QUERIES = [
  'русский чарт', 'топ русских песен', 'лучшие русские песни', 'популярные песни',
  'русский поп', 'русский рэп', 'хиты русский рок', 'новинки музыки',
];

const GENRE_QUERIES = {
  pop: 'русский поп',
  rock: 'русский рок',
  rap: 'русский рэп',
  indie: 'российские инди-исполнители',
  electro: 'русская электронная музыка',
  jazz: 'русский джаз',
  dance: 'русская танцевальная музыка',
  hiphop: 'русский хип-хоп',
};

const MOODS = {
  calm: 'спокойная музыка',
  energy: 'энергичная музыка для тренировки',
  road: 'музыка в дорогу',
  romance: 'романтические песни',
  rock: 'русский рок',
  hiphop: 'русский хип-хоп',
};

const JUNK_TITLE = /(mix|playlist|сборник|megamix|nonstop|non-stop|dance mix|hits 20\d\d|chill mix|диджейский|dj set|stream|live set|подборка|микс|клубн|хиты|час музыки|музыка для)/i;

/* ---------------- InnerTube ---------------- */

async function innertube(endpoint, body) {
  const url = `https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': CLIENT.userAgent,
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
      Origin: 'https://music.youtube.com',
      ...CLIENT.headers,
    },
    body: JSON.stringify({ context: CLIENT.context, ...body }),
  });
  if (!response.ok) throw new Error(`innertube_http_${response.status}`);
  return response.json();
}

/* ---------------- разбор ---------------- */

function uniqBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const thumbUrl = (thumbs) => {
  if (!Array.isArray(thumbs) || !thumbs.length) return '';
  const sorted = [...thumbs].sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
  return String(sorted[0].url || '').replace(/^\/\//, 'https://');
};

const thumbAt = (thumbs, size) => {
  if (!Array.isArray(thumbs) || !thumbs.length) return '';
  const sorted = [...thumbs].sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
  const pick = sorted.find((t) => (Number(t.width) || 0) >= size) || sorted[sorted.length - 1];
  return String(pick.url || '').replace(/^\/\//, 'https://');
};

function extractText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((run) => run.text || '').join('');
  return '';
}

function parseDuration(text) {
  const parts = String(text || '').trim().split(':').map((p) => Number(p));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const isArtistRun = (run) => run?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
  ?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ARTIST';

const isAlbumRun = (run) => run?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
  ?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ALBUM';

function parseTrack(renderer) {
  if (!renderer) return null;
  const videoId = renderer.videoId || renderer.playlistItemData?.videoId || '';
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;

  const columns = (renderer.flexColumns || []).map((col) => col?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
  const allRuns = columns.flat().concat(renderer.subtitle?.runs || []);
  const columnText = (i) => (columns[i] || []).map((run) => run.text || '').join('').trim();

  const artist = uniqBy(allRuns.filter(isArtistRun), (r) => r.text).map((r) => r.text || '').join(', ').trim();
  const albumRun = allRuns.find(isAlbumRun);
  let album = albumRun ? albumRun.text || '' : '';

  const isMetric = (text) => /^\d[\d,.\s\u00a0]*(прослушиван|лайк|like|млн|млрд|тыс)/i.test(text);
  const cleanAlbum = (text) => {
    if (!text || isMetric(text) || /^\d{4}$/.test(text)) return '';
    const stripped = text.replace(/^альбом\s*[·•]\s*/i, '').split(/[·•]/)[0].trim();
    return isMetric(stripped) || /^\d{4}$/.test(stripped) ? '' : stripped;
  };
  if (!album) album = cleanAlbum(columnText(2)) || cleanAlbum(columnText(3));

  const durationFromColumns = () => {
    const tail = (text) => {
      const parts = String(text || '').split(/[·•]/).map((p) => p.trim()).filter(Boolean);
      const last = parts[parts.length - 1] || '';
      return /^\d{1,2}:\d{2}(:\d{2})?$/.test(last) ? parseDuration(last) : 0;
    };
    for (let i = 0; i < columns.length; i += 1) {
      const found = tail(columnText(i));
      if (found) return found;
    }
    return 0;
  };

  const thumbs = renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
  const base = {
    id: videoId,
    type: 'track',
    title: extractText(renderer.title) || columnText(0) || 'Без названия',
    album,
    cover: thumbUrl(thumbs),
    coverBig: thumbAt(thumbs, 544),
  };

  if (!artist) {
    const fallback = columnText(1).split(/[·•]/)[0].trim();
    const isMeta = /^(альбом|песня|трек|видео|сингл|album|song|track|video)$/i;
    if (fallback && !/^\d/.test(fallback) && !isMeta.test(fallback) && !isMetric(fallback)) {
      return { ...base, artist: fallback, duration: durationFromColumns() };
    }
    return null;
  }

  const durationRaw = extractText(renderer.lengthText)
    || extractText(renderer.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text);
  return { ...base, artist, duration: parseDuration(durationRaw) || durationFromColumns() };
}

function collectTracks(data) {
  const tracks = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.musicResponsiveListItemRenderer) {
      const track = parseTrack(node.musicResponsiveListItemRenderer);
      if (track) tracks.push(track);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(data);
  return tracks;
}

const isJunk = (t) => {
  const title = String(t.title || '');
  if (JUNK_TITLE.test(title)) return true;
  if (t.duration && (t.duration < 40 || t.duration > 900)) return true;
  return title.trim().split(/\s+/).length > 8;
};

async function search(query) {
  try {
    const data = await innertube('search', { query, params: CLIENT.searchParams });
    return collectTracks(data);
  } catch {
    return [];
  }
}

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------------- сборка ---------------- */

async function buildChart() {
  const all = [];
  for (const q of CHART_QUERIES) {
    const tracks = await search(q);
    all.push(...tracks);
  }
  return uniqBy(all, (t) => t.id)
    .filter((t) => !isJunk(t))
    .sort((a, b) => (Number(b.duration) > 0) - (Number(a.duration) > 0))
    .slice(0, 60)
    .map((t, i) => ({ ...t, position: i + 1 }));
}

async function buildFeed() {
  const pools = {};
  const allTracks = [];

  await Promise.all(Object.entries(GENRE_QUERIES).map(async ([key, query]) => {
    const tracks = await search(query);
    pools[key] = tracks.filter((t) => !isJunk(t));
    allTracks.push(...pools[key]);
  }));

  await Promise.all(Object.entries(MOODS).map(async ([key, query]) => {
    const tracks = await search(query);
    pools[`mood_${key}`] = tracks.filter((t) => !isJunk(t));
    allTracks.push(...pools[`mood_${key}`]);
  }));

  return {
    pools,
    index: uniqBy(allTracks, (t) => t.id).slice(0, 800),
  };
}

async function main() {
  mkdirSync(join(OUT_DIR, 'api'), { recursive: true });

  const started = Date.now();
  const chart = await buildChart();
  const feed = await buildFeed();

  const write = (name, data) => {
    writeFileSync(join(OUT_DIR, 'api', name), JSON.stringify(data));
  };

  write('chart.json', { region: 'RU', count: chart.length, tracks: chart, generatedAt: Date.now() });
  write('feed.json', { ...feed, generatedAt: Date.now() });

  // Треки по исполнителям: заранее собираем списки для быстрых страниц.
  const byArtist = {};
  for (const track of [...chart, ...feed.index]) {
    const key = String(track.artist || '').split(/\s*(?:,|&|feat\.?)\s*/i)[0].trim().toLowerCase();
    if (!key) continue;
    if (!byArtist[key]) byArtist[key] = [];
    if (!byArtist[key].some((t) => t.id === track.id)) byArtist[key].push(track);
  }
  write('artists.json', byArtist);

  console.log(`Готово за ${Math.round((Date.now() - started) / 1000)} с`);
  console.log(`чарт: ${chart.length}, пул: ${feed.index.length}, исполнителей: ${Object.keys(byArtist).length}`);
}

main().catch((err) => {
  console.error('Ошибка генерации:', err);
  process.exit(1);
});
