/* ============================================================
   PULSE · разблокировка звука на мобильных браузерах.
   Safari и Chrome не разрешают звук до первого жеста пользователя.
   Здесь мы ловим первый тап/клик и «открываем» звук, а плеер
   узнаёт об этом через window.__pulseAudioUnlocked.
   ============================================================ */

(function initAudioUnlock() {
  if (window.__pulseAudioUnlockInstalled) return;
  window.__pulseAudioUnlockInstalled = true;

  window.__pulseAudioUnlocked = false;
  const listeners = new Set();

  // Беззвучная дорожка: браузер выдаёт разрешение на её проигрывание
  // в рамках жеста, дальше звук разрешён всему документу.
  const primer = document.createElement('audio');
  primer.setAttribute('playsinline', '');
  primer.setAttribute('webkit-playsinline', '');
  primer.setAttribute('preload', 'auto');
  primer.muted = true;
  primer.volume = 0;
  primer.style.cssText = 'position:fixed;left:-9px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  // Короткий тихий WAV, чтобы не зависеть от сети.
  primer.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
  document.body.appendChild(primer);

  function unlock(source) {
    if (window.__pulseAudioUnlocked) return;
    const attempt = primer.play();
    if (attempt && typeof attempt.then === 'function') {
      attempt
        .then(() => {
          window.__pulseAudioUnlocked = true;
          window.__pulseAudioUnlockSource = source;
          primer.pause();
          try { primer.currentTime = 0; } catch { /* ignore */ }
          listeners.forEach((fn) => {
            try { fn(); } catch { /* ignore */ }
          });
          listeners.clear();
          detach();
        })
        .catch(() => {
          // Жест не дал разрешения (например, iOS требует реального касания) —
          // ждём следующего события.
        });
    }
  }

  const onGesture = (event) => unlock(event.type);

  function attach() {
    document.addEventListener('pointerdown', onGesture, { passive: true, capture: true });
    document.addEventListener('touchstart', onGesture, { passive: true, capture: true });
    document.addEventListener('click', onGesture, { passive: true, capture: true });
    document.addEventListener('keydown', onGesture, { capture: true });
  }

  function detach() {
    document.removeEventListener('pointerdown', onGesture, { capture: true });
    document.removeEventListener('touchstart', onGesture, { capture: true });
    document.removeEventListener('click', onGesture, { capture: true });
    document.removeEventListener('keydown', onGesture, { capture: true });
  }

  attach();

  /** Выполнить колбэк сразу, если звук уже разрешён, иначе — после жеста. */
  window.pulseWhenAudioAllowed = function pulseWhenAudioAllowed(callback) {
    if (window.__pulseAudioUnlocked) {
      callback();
      return;
    }
    listeners.add(callback);
  };
})();
