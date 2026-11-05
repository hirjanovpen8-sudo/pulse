/* ============================================================
   PULSE · надстройка над плеером (не трогает базовую логику).
   Здесь только: контекстное меню, полка «Послушать ещё раз»,
   заглушки обложек и мелкие UI-улучшения.
   ============================================================ */

import { initContextMenu } from './js/context-menu.js';
import { getReplayShelf } from './js/shelf.js';

/* ---------------- заглушки для битых обложек ---------------- */

const FALLBACK_CLASS = 'pulse-cover-fallback';

function applyFallback(img) {
  if (!img || img.dataset.pulseFallback === '1') return;
  img.dataset.pulseFallback = '1';
  img.classList.add(FALLBACK_CLASS);
  img.removeAttribute('src');
  img.setAttribute('alt', '');
  if (img.parentElement) img.parentElement.classList.add(`${FALLBACK_CLASS}-wrap`);
}

function watchImages(root = document) {
  root.querySelectorAll('img').forEach((img) => {
    if (img.dataset.pulseWatch === '1') return;
    img.dataset.pulseWatch = '1';
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) applyFallback(img);
    img.addEventListener('error', () => applyFallback(img));
  });
}

/* ---------------- «Послушать ещё раз» на главной ---------------- */

const SHELF_SECTION_ID = 'pulseReplayShelf';

function renderShelfSection() {
  const items = getReplayShelf();
  const page = document.getElementById('page');
  if (!page || page.dataset.page !== 'home') return;

  let section = document.getElementById(SHELF_SECTION_ID);
  if (!items.length) {
    if (section) section.remove();
    return;
  }
  if (!section) {
    section = document.createElement('section');
    section.id = SHELF_SECTION_ID;
    section.className = 'section pulse-replay';
    section.setAttribute('aria-labelledby', 'pulse-replay-title');
    const head = page.querySelector('.page-head');
    if (head && head.nextSibling) page.insertBefore(section, head.nextSibling);
    else page.appendChild(section);
  }
  const pinned = items.filter((t) => t.pinned).length;
  section.innerHTML = `
    <div class="section-head">
      <h2 class="section-title" id="pulse-replay-title">Послушать ещё раз</h2>
      <span class="section-link">${pinned ? `${pinned} закреплено` : `${items.length} треков`}</span>
    </div>
    <div class="rows pulse-replay__rows">
      ${items.slice(0, 12).map((t, i) => `
        <div class="row pulse-replay__row" data-track-id="${escapeHtml(t.id)}" tabindex="0" role="button">
          <span class="row-num">${i + 1}</span>
          <div class="row-cover">${t.cover ? `<img src="${escapeHtml(t.cover)}" alt="" loading="lazy">` : ''}</div>
          <div class="row-main">
            <div class="row-title">${escapeHtml(t.title || 'Без названия')}</div>
            <div class="row-artist">${escapeHtml(t.artist || '')}</div>
          </div>
          <div class="row-album">${escapeHtml(t.album || '')}</div>
          <div class="row-time">${t.pinned ? '<span class="pulse-pin" title="Закреплено">●</span>' : ''}</div>
        </div>`).join('')}
    </div>
  `;
  section.onclick = (event) => {
    const row = event.target.closest('[data-track-id]');
    if (!row) return;
    const index = items.findIndex((t) => t.id === row.dataset.trackId);
    if (index >= 0 && window.__pulse && window.__pulse.playNow) {
      window.__pulse.playNow(items, index, 'Послушать ещё раз');
    }
  };
  watchImages(section);
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

/* ---------------- запуск надстройки ---------------- */

function start() {
  initContextMenu();

  watchImages(document);
  new MutationObserver((mutations) => {
    let needShelf = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        if (mutation.addedNodes.length) watchImages(document);
        if (mutation.target && mutation.target.id === 'page') needShelf = true;
      }
    }
    if (needShelf) window.setTimeout(renderShelfSection, 80);
  }).observe(document.body, { childList: true, subtree: true });

  // Перерисовываем полку после смены маршрута и после изменений на полке.
  window.addEventListener('hashchange', () => window.setTimeout(renderShelfSection, 120));
  document.addEventListener('pulse:shelf-changed', renderShelfSection);
  document.addEventListener('pulse:library-changed', () => {});

  // Первый рендер, когда приложение уже смонтировано.
  const boot = () => window.setTimeout(renderShelfSection, 300);
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
}

start();

window.__pulseEnhancements = { renderShelfSection, watchImages };
