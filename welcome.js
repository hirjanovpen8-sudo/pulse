/* ============================================================
   PULSE В· РїСЂРёРІРµС‚СЃС‚РІРµРЅРЅС‹Р№ СЌРєСЂР°РЅ СЃ РІС…РѕРґРѕРј С‡РµСЂРµР· Google.
   РџРѕРєР°Р·С‹РІР°РµС‚СЃСЏ РѕРґРёРЅ СЂР°Р· вЂ” РїРѕРєР° РІ localStorage РЅРµС‚ is_logged_in.
   РСЃРїРѕР»СЊР·СѓРµС‚ РѕС„РёС†РёР°Р»СЊРЅСѓСЋ Р±РёР±Р»РёРѕС‚РµРєСѓ Google Identity Services.
   ============================================================ */

const FLAG_KEY = 'is_logged_in';
const PROFILE_KEY = 'pulse.profile';
/* РџРѕРґСЃС‚Р°РІСЊС‚Рµ СЃРІРѕР№ OAuth Client ID РёР· Google Cloud Console.
   РџРѕРєР° СЃС‚РѕРёС‚ Р·Р°РіР»СѓС€РєР° вЂ” РєРЅРѕРїРєР° Google РЅРµ РїРѕРєР°Р·С‹РІР°РµС‚СЃСЏ, РІС…РѕРґ С‚РѕР»СЊРєРѕ Р»РѕРєР°Р»СЊРЅС‹Р№. */
const CLIENT_ID = '1084552383103-example.apps.googleusercontent.com';
const HAS_REAL_CLIENT = !/example\.apps\.googleusercontent\.com$/.test(CLIENT_ID);
const ROOT_ID = 'pulseWelcome';

let welcome = null;
let pendingLogin = false;

function isLoggedIn() {
  try {
    return localStorage.getItem(FLAG_KEY) === 'true';
  } catch {
    return false;
  }
}

function markLoggedIn() {
  try {
    localStorage.setItem(FLAG_KEY, 'true');
  } catch { /* С…СЂР°РЅРёР»РёС‰Рµ РЅРµРґРѕСЃС‚СѓРїРЅРѕ */ }
}

function readProfile() {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function logout() {
  try {
    localStorage.removeItem(FLAG_KEY);
    localStorage.removeItem(PROFILE_KEY);
  } catch { /* ignore */ }
  const google = window.google;
  try { if (google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch { /* ignore */ }
  renderAccount();
  document.dispatchEvent(new CustomEvent('pulse:auth-changed', { detail: { loggedIn: false } }));
} 

/* РЎС‚Р°С‚РёСЃС‚РёРєР° Р°РєРєР°СѓРЅС‚Р° вЂ” РёР· С‚РµС… Р¶Рµ local-С…СЂР°РЅРёР»РёС‰, С‡С‚Рѕ Рё РїР»РµРµСЂ. */
function readStats() {
  const count = (key) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value.length : 0;
    } catch {
      return 0;
    }
  };
  let minutes = 0;
  try {
    const recent = JSON.parse(localStorage.getItem('pulse.recent') || '[]');
    if (Array.isArray(recent)) {
      minutes = Math.round(recent.reduce((acc, t) => acc + (Number(t && t.duration) || 0), 0) / 60);
    }
  } catch { /* ignore */ }
  return {
    likes: count('liked_songs') || count('pulse.likes'),
    shelf: count('pulse.shelf.replay'),
    library: count('pulse.library'),
    recent: count('pulse.recent'),
    minutes,
  };
}

function escapeText(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

/** Р‘Р»РѕРє Р°РєРєР°СѓРЅС‚Р° РІ СЃР°Р№РґР±Р°СЂРµ: РїСЂРѕС„РёР»СЊ, СЃС‚Р°С‚РёСЃС‚РёРєР°, РІС…РѕРґ/РІС‹С…РѕРґ. */
export function renderAccount() {
  const box = document.getElementById('pwAccount');
  if (!box) return;
  const loggedIn = isLoggedIn();
  const profile = readProfile();
  const stats = readStats();

  if (!loggedIn) {
    box.innerHTML = `
      <div class="pw-acct__guest">
        <p class="pw-acct__title">Р’С‹ РЅРµ РІРѕС€Р»Рё</p>
        <p class="pw-acct__hint">Р’РѕР№РґРёС‚Рµ, С‡С‚РѕР±С‹ СЃРѕС…СЂР°РЅСЏС‚СЊ Р»Р°Р№РєРё Рё РёСЃС‚РѕСЂРёСЋ РІ Р°РєРєР°СѓРЅС‚Рµ.</p>
        <button class="pw-acct__btn" type="button" data-pw="login">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>
          Р’РѕР№С‚Рё РІ Р°РєРєР°СѓРЅС‚
        </button>
      </div>
    `;
    return;
  }

  const name = (profile && (profile.name || profile.email)) || 'РђРєРєР°СѓРЅС‚ Google';
  const email = (profile && profile.email) || '';
  const picture = (profile && profile.picture) || '';
  const avatar = picture
    ? `<img src="${escapeText(picture)}" alt="" loading="lazy">`
    : `<span class="pw-acct__initial">${escapeText(name.slice(0, 1).toUpperCase())}</span>`;

  box.innerHTML = `
    <div class="pw-acct__user">
      <div class="pw-acct__avatar">${avatar}</div>
      <div class="pw-acct__who">
        <p class="pw-acct__name" title="${escapeText(name)}">${escapeText(name)}</p>
        ${email ? `<p class="pw-acct__email" title="${escapeText(email)}">${escapeText(email)}</p>` : ''}
      </div>
    </div>
    <dl class="pw-acct__stats">
      <div><dt>Р›Р°Р№РєРё</dt><dd>${stats.likes}</dd></div>
      <div><dt>Р•С‰С‘ СЂР°Р·</dt><dd>${stats.shelf}</dd></div>
      <div><dt>Р‘РёР±Р»РёРѕС‚РµРєР°</dt><dd>${stats.library}</dd></div>
      <div><dt>РЎР»СѓС€Р°Р»Рё</dt><dd>${stats.recent}</dd></div>
      <div class="pw-acct__wide"><dt>РњРёРЅСѓС‚ РјСѓР·С‹РєРё</dt><dd>${stats.minutes}</dd></div>
    </dl>
    <button class="pw-acct__logout" type="button" data-pw="logout">Р’С‹Р№С‚Рё РёР· Р°РєРєР°СѓРЅС‚Р°</button>
  `;
}

function bindAccount() {
  const box = document.getElementById('pwAccount');
  if (!box) return;
  box.addEventListener('click', (event) => {
    const action = event.target.closest('[data-pw]');
    if (!action) return;
    if (action.dataset.pw === 'logout') logout();
    else if (action.dataset.pw === 'login') {
      pendingLogin = true;
      showWelcome();
    }
  });
  // РЎС‚Р°С‚РёСЃС‚РёРєСѓ РѕР±РЅРѕРІР»СЏРµРј РїРѕСЃР»Рµ Р»СЋР±С‹С… РґРµР№СЃС‚РІРёР№ СЃ Р±РёР±Р»РёРѕС‚РµРєРѕР№.
  for (const name of ['pulse:liked-changed', 'pulse:shelf-changed', 'pulse:library-changed', 'pulse:auth-changed']) {
    document.addEventListener(name, () => window.setTimeout(renderAccount, 60));
  }
  window.addEventListener('storage', (event) => {
    if (!event.key || event.key.startsWith('pulse.') || event.key === FLAG_KEY) renderAccount();
  });
}

function decodeJwt(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return null;
  }
}

function onCredential(response) {
  const profile = decodeJwt(response && response.credential);
  try {
    if (profile) localStorage.setItem(PROFILE_KEY, JSON.stringify({
      name: profile.name || '',
      email: profile.email || '',
      picture: profile.picture || '',
    }));
  } catch { /* ignore */ }
  markLoggedIn();
  pendingLogin = false;
  hideWelcome();
  renderAccount();
  document.dispatchEvent(new CustomEvent('pulse:auth-changed', { detail: { loggedIn: true } }));
}

function buildWelcome() {
  const el = document.createElement('div');
  el.id = ROOT_ID;
  el.className = 'pw';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'pwTitle');
  el.innerHTML = `
    <div class="pw-bg" aria-hidden="true"></div>
    <div class="pw-card">
      <div class="pw-brand" aria-hidden="true">
        <svg viewBox="0 0 32 32">
          <rect x="2" y="13" width="3" height="6" rx="1.5" fill="currentColor" opacity=".45"/>
          <rect x="8" y="9" width="3" height="14" rx="1.5" fill="currentColor" opacity=".7"/>
          <rect x="14" y="4" width="3" height="24" rx="1.5" fill="currentColor"/>
          <rect x="20" y="9" width="3" height="14" rx="1.5" fill="currentColor" opacity=".7"/>
          <rect x="26" y="13" width="3" height="6" rx="1.5" fill="currentColor" opacity=".45"/>
        </svg>
        <span>Pulse</span>
      </div>
      <h1 class="pw-title" id="pwTitle">РњСѓР·С‹РєР°, РєРѕС‚РѕСЂР°СЏ РїРѕРјРЅРёС‚ С‚РІРѕР№ РІРєСѓСЃ</h1>
      <p class="pw-sub">Р’РѕР№РґРёС‚Рµ, С‡С‚РѕР±С‹ СЃРѕС…СЂР°РЅСЏС‚СЊ Р»Р°Р№РєРё, РёСЃС‚РѕСЂРёСЋ Рё РІРѕР»РЅСѓ РЅР° РІСЃРµС… СѓСЃС‚СЂРѕР№СЃС‚РІР°С….</p>
      <div class="pw-google" id="pwGoogle"></div>
      <button class="pw-skip" type="button" id="pwSkip">РџСЂРѕРґРѕР»Р¶РёС‚СЊ Р±РµР· Р°РєРєР°СѓРЅС‚Р°</button>
      <p class="pw-note">РњС‹ РЅРµ РїСѓР±Р»РёРєСѓРµРј РЅРёС‡РµРіРѕ РѕС‚ РІР°С€РµРіРѕ РёРјРµРЅРё. Р’С…РѕРґ РЅСѓР¶РµРЅ С‚РѕР»СЊРєРѕ РґР»СЏ Р»РёС‡РЅРѕР№ Р±РёР±Р»РёРѕС‚РµРєРё.</p>
    </div>
  `;
  return el;
}

function renderGoogleButton() {
  const holder = document.getElementById('pwGoogle');
  if (!holder) return;
  if (!HAS_REAL_CLIENT) {
    holder.innerHTML = '<button class="pw-local" type="button" id="pwLocal">РџСЂРѕРґРѕР»Р¶РёС‚СЊ Р±РµР· Р°РєРєР°СѓРЅС‚Р°</button>';
    const local = document.getElementById('pwLocal');
    if (local) local.addEventListener('click', () => { hideWelcome(); });
    return;
  }
  const google = window.google;
  if (!google || !google.accounts || !google.accounts.id) {
    // Р‘РёР±Р»РёРѕС‚РµРєР° РµС‰С‘ РіСЂСѓР·РёС‚СЃСЏ вЂ” РїРѕРІС‚РѕСЂСЏРµРј РїРѕРїС‹С‚РєСѓ.
    window.setTimeout(renderGoogleButton, 300);
    return;
  }
  try {
    google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: onCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    google.accounts.id.renderButton(holder, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      shape: 'pill',
      logo_alignment: 'left',
      width: 300,
    });
  } catch {
    holder.innerHTML = '<span class="pw-google__error">Google-РІС…РѕРґ СЃРµР№С‡Р°СЃ РЅРµРґРѕСЃС‚СѓРїРµРЅ</span>';
  }
}

export function hideWelcome() {
  if (!welcome) return;
  welcome.classList.remove('is-open');
  const node = welcome;
  welcome = null;
  window.setTimeout(() => node.remove(), 320);
}

export function showWelcome() {
  if (welcome) return;
  if (isLoggedIn() && !pendingLogin) return;
  welcome = buildWelcome();
  document.body.appendChild(welcome);
  document.documentElement.classList.add('pw-open');
  requestAnimationFrame(() => welcome && welcome.classList.add('is-open'));
  document.getElementById('pwSkip').addEventListener('click', () => {
    // РџСЂРѕРїСѓСЃРє РЅРµ СЃС‚Р°РІРёС‚ С„Р»Р°Рі: СЌРєСЂР°РЅ РІРµСЂРЅС‘С‚СЃСЏ РїСЂРё СЃР»РµРґСѓСЋС‰РµРј Р·Р°С…РѕРґРµ.
    pendingLogin = false;
    hideWelcome();
  });
  document.getElementById('pwSkip').focus({ preventScroll: true });
  renderGoogleButton();
}

function start() {
  renderAccount();
  bindAccount();
  if (isLoggedIn()) return;
  if (document.readyState === 'complete') showWelcome();
  else window.addEventListener('load', showWelcome, { once: true });
}

window.__pulseWelcome = { showWelcome, hideWelcome, isLoggedIn, markLoggedIn, renderAccount, logout };

start();
