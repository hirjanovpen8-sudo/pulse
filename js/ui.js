/* ============================================================
   PULSE · общие компоненты страниц (карточки, строки треков).
   Заполнение реальными данными — следующий этап.
   ============================================================ */

import { esc, fmtTime, icon } from './util.js';

export function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'Доброе утро';
  if (hour >= 12 && hour < 18) return 'Добрый день';
  if (hour >= 18 && hour < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}

export function coverHtml(url, fallbackIcon = 'music') {
  return url
    ? `<img src="${esc(url)}" alt="" loading="lazy">`
    : icon(fallbackIcon);
}

export function trackRow(track, position = 0) {
  const artist = String(track.artist || '').trim();
  const artistHtml = artist
    ? `<button class="row-artist row-artist-link" type="button" data-artist="${esc(artist)}">${esc(artist)}</button>`
    : '<div class="row-artist"></div>';
  return `<div class="row" data-track-id="${esc(track.id)}" tabindex="0" role="button">
    <span class="row-num">${position}</span>
    <div class="row-cover">${coverHtml(track.cover)}</div>
    <div class="row-main">
      <div class="row-title">${esc(track.title || 'Без названия')}</div>
      ${artistHtml}
    </div>
    <div class="row-album">${esc(track.album || '')}</div>
    <div class="row-time">${track.duration ? fmtTime(track.duration) : ''}</div>
  </div>`;
}

export function trackRows(tracks) {
  return `<div class="rows">${tracks.map((t, i) => trackRow(t, i + 1)).join('')}</div>`;
}

export function collectionCard(item) {
  const fallback = item.type === 'artist' ? 'artist' : 'album';
  return `<article class="card" data-collection-id="${esc(item.id)}" data-collection-type="${esc(item.type || '')}" tabindex="0">
    <div class="card-cover">${coverHtml(item.cover, fallback)}</div>
    <p class="card-title">${esc(item.title || '')}</p>
    <p class="card-sub">${esc(item.artist || item.description || '')}</p>
  </article>`;
}

export function pageHead(title, subtitle = '', actions = '') {
  return `<header class="page-head">
    <div>
      <h1 class="page-title">${esc(title)}</h1>
      ${subtitle ? `<p class="page-subtitle">${esc(subtitle)}</p>` : ''}
    </div>
    ${actions}
  </header>`;
}

export const listIcon = icon;
