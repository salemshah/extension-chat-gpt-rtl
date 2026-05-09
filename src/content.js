/**
 * ChatGPT RTL Support — content script
 *
 * Detects Persian / Arabic / Hebrew / Urdu text in ChatGPT messages and
 * the input area, then applies correct dir attributes and CSS classes.
 * Never modifies text content — only attributes, classes, and styles.
 *
 * Keyboard shortcuts (active on chatgpt.com):
 *   Alt+Shift+R  →  Force RTL
 *   Alt+Shift+L  →  Force LTR
 *   Alt+Shift+A  →  Auto-detect
 */

(function () {
  'use strict';

  // ── Cross-browser storage shim ────────────────────────────────────────────
  // Firefox exposes `browser.*` (Promise-based); Chrome exposes `chrome.*`
  // (callback-based).  Resolved once at startup, never re-checked.

  const _ext = (typeof browser !== 'undefined') ? browser : chrome; // eslint-disable-line no-undef
  const _isFirefox = (typeof browser !== 'undefined');               // eslint-disable-line no-undef

  function storageGetCb(key, cb) {
    try {
      if (_isFirefox) {
        _ext.storage.sync.get(key).then(cb).catch(() => cb({}));
      } else {
        _ext.storage.sync.get(key, result => {
          if (_ext.runtime.lastError) { cb({}); return; }
          cb(result || {});
        });
      }
    } catch (_) { cb({}); }
  }

  function storageSet(data) {
    try {
      const r = _ext.storage.sync.set(data);
      if (r && typeof r.then === 'function') r.catch(() => {});
    } catch (_) {}
  }

  // ── Constants ─────────────────────────────────────────────────────────────

  const STORAGE_KEY      = 'cgptRtlSettings';
  const DIR_CONTROL_ATTR = 'data-cgpt-dir-control';
  const RTL_THRESHOLD    = 0.30;
  const DEBOUNCE_MS      = 160;
  const INIT_DELAY_MS    = 700;

  const DIR_MODE_CYCLE  = { auto: 'rtl', rtl: 'ltr', ltr: 'auto' };
  const DIR_MODE_LABELS = { auto: '⇄ Auto', rtl: '← RTL', ltr: 'LTR →' };

  const DEFAULTS = {
    enabled:           true,
    autoDetect:        true,
    forceMode:         'auto',   // 'auto' | 'rtl' | 'ltr'
    persianTypography: true,
  };

  // Unicode ranges: Hebrew, Arabic (incl. Persian/Urdu), Syriac, Thaana,
  // N'Ko, Samaritan, Arabic Extended-A, presentation forms.
  // The `g` flag lets String.prototype.match() count all occurrences in one
  // native pass instead of per-character JS loop calls.
  const RTL_RE = /[֐-׿؀-ۿ܀-ݏݐ-ݿ߀-߿ࢠ-ࣿיִ-ﭏﭐ-﷿ﹰ-﻿]/g;
  const LTR_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g;

  // ── State ─────────────────────────────────────────────────────────────────

  let settings    = { ...DEFAULTS };
  let settingsGen = 0;          // bumped on every settings change; invalidates textCache
  let scanTimer     = null;
  let domObserver   = null;
  let composerTimer = null;
  let initialized   = false;      // guards against double-init on SPA re-entry

  // Per-element text cache (WeakMap — GC'd automatically when elements leave the DOM).
  // Stored value: { raw: string, gen: number }
  //   raw — el.textContent at last classification (cheap read, no cloneNode)
  //   gen — settingsGen at last classification
  // Both must match for the fast-path skip to fire.
  const textCache = new WeakMap();

  // Containers collected during the current debounce window (targeted scan).
  const pendingContainers = new Set();

  // ── DOM selectors ─────────────────────────────────────────────────────────
  // Prefer data-attribute / semantic selectors; class names are fragile.

  const MSG_SEL = [
    '[data-message-author-role]',
    'article[data-scroll-anchor]',
    'main article',
    '.group\\/conversation-turn',
  ].join(', ');

  const BLOCK_SEL = 'p, li, blockquote, dt, dd, h1, h2, h3, h4, h5, h6, td, th';

  const INPUT_SEL = [
    '#prompt-textarea',
    '[data-id="prompt-textarea"]',
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"][data-placeholder]',
    'textarea[data-id]',
    'textarea[placeholder]',
  ].join(', ');

  // ── Safe DOM helpers ──────────────────────────────────────────────────────
  // Invalid or future selectors must not crash the extension.

  function safeQSA(root, sel) {
    try { return Array.from(root.querySelectorAll(sel)); }
    catch (_) { return []; }
  }

  function safeClosest(el, sel) {
    try { return el.closest(sel); }
    catch (_) { return null; }
  }

  // ── Direction detection ───────────────────────────────────────────────────

  function detectDirection(text) {
    if (!text) return null;
    // Cap at 200 chars — sufficient signal for the 30 % threshold.
    // String.prototype.match with a /g regex is a single native scan,
    // much faster than calling .test() per character in a JS loop.
    const t    = text.length > 200 ? text.slice(0, 200) : text;
    const rtlM = t.match(RTL_RE);
    if (!rtlM) return null;                     // no RTL chars → skip LTR count
    const ltrM  = t.match(LTR_RE);
    const rtl   = rtlM.length;
    const total = rtl + (ltrM ? ltrM.length : 0);
    if (total === 0) return null;
    return rtl / total >= RTL_THRESHOLD ? 'rtl' : 'ltr';
  }

  // Returns the element's text with <pre>/<code> subtrees removed.
  // Called only when the fast-path cache check fails.
  function textWithoutCode(el) {
    const clone = el.cloneNode(true);
    safeQSA(clone, 'pre, code, kbd, samp').forEach(n => n.remove());
    return clone.textContent ?? '';
  }

  function resolveDir(text) {
    if (settings.forceMode === 'rtl') return 'rtl';
    if (settings.forceMode === 'ltr') return 'ltr';
    if (!settings.autoDetect) return null;
    return detectDirection(text);
  }

  // ── Apply / remove direction ──────────────────────────────────────────────

  function applyDir(el, dir) {
    // Early-exit — avoids all DOM writes when nothing needs changing.
    if (el.getAttribute('dir') === dir &&
        el.classList.contains(dir === 'rtl' ? 'cgpt-rtl' : 'cgpt-ltr')) return;

    el.setAttribute('dir', dir);
    if (dir === 'rtl') {
      el.classList.add('cgpt-rtl');
      el.classList.remove('cgpt-ltr');
    } else {
      el.classList.add('cgpt-ltr');
      el.classList.remove('cgpt-rtl');
    }
  }

  function clearDir(el) {
    if (!el.hasAttribute('dir') &&
        !el.classList.contains('cgpt-rtl') &&
        !el.classList.contains('cgpt-ltr')) return;
    el.removeAttribute('dir');
    el.classList.remove('cgpt-rtl', 'cgpt-ltr');
  }

  // ── Input-specific direction helpers ─────────────────────────────────────
  // These are SEPARATE from applyDir/clearDir.  They use dedicated classes
  // (.cgpt-input-rtl / .cgpt-input-ltr) and never touch the HTML dir
  // attribute — setting dir="rtl" on the input container propagates via
  // logical CSS properties (inset-inline-end, etc.) into absolutely-
  // positioned send / mic / attach children, physically shifting them.

  function applyInputDir(el, dir) {
    const add = dir === 'rtl' ? 'cgpt-input-rtl' : 'cgpt-input-ltr';
    const rem = dir === 'rtl' ? 'cgpt-input-ltr' : 'cgpt-input-rtl';
    if (el.classList.contains(add) && !el.classList.contains(rem)) return;
    el.classList.add(add);
    el.classList.remove(rem);
  }

  function clearInputDir(el) {
    if (!el.classList.contains('cgpt-input-rtl') &&
        !el.classList.contains('cgpt-input-ltr')) return;
    el.classList.remove('cgpt-input-rtl', 'cgpt-input-ltr');
  }

  // ── Block processing ──────────────────────────────────────────────────────

  function processBlock(el) {
    // Force mode: direction is fixed regardless of content.
    // applyDir early-exits when the element is already in the right state,
    // so repeated calls during streaming are essentially free.
    if (settings.forceMode !== 'auto') {
      applyDir(el, settings.forceMode);
      return;
    }

    // Auto mode, auto-detect off: nothing to do.
    if (!settings.autoDetect) return;

    // Fast path: if raw text and settingsGen are both unchanged, the result
    // cannot have changed — skip the expensive cloneNode entirely.
    const raw = el.textContent ?? '';
    if (!raw.trim()) return;

    const cached = textCache.get(el);
    if (cached && cached.raw === raw && cached.gen === settingsGen) return;

    // Slow path: strip code subtrees, classify, cache.
    const text = textWithoutCode(el);
    textCache.set(el, { raw, gen: settingsGen });
    if (!text.trim()) return;

    const dir = detectDirection(text);
    if (dir) applyDir(el, dir);
    else clearDir(el); // remove any stale direction from a prior force mode
  }

  function processMessageContainer(container) {
    // 1. Lock every <pre> to LTR.  Skip the write when already done.
    safeQSA(container, 'pre').forEach(pre => {
      if (pre.getAttribute('dir') !== 'ltr') {
        pre.setAttribute('dir', 'ltr');
        pre.classList.add('cgpt-code-ltr');
      }
    });

    // 2. Process individual block elements (paragraphs, list items, …).
    const blocks = safeQSA(container, BLOCK_SEL).filter(
      b => !safeClosest(b, 'pre, code')
    );

    if (blocks.length > 0) {
      blocks.forEach(processBlock);
    } else {
      // Fallback: container has no block descendants (plain-text user message).
      if (settings.forceMode !== 'auto') {
        applyDir(container, settings.forceMode);
        return;
      }
      if (!settings.autoDetect) return;

      const raw = container.textContent ?? '';
      if (!raw.trim()) return;

      const cached = textCache.get(container);
      if (cached && cached.raw === raw && cached.gen === settingsGen) return;

      const text = textWithoutCode(container);
      textCache.set(container, { raw, gen: settingsGen });
      if (!text.trim()) return;

      const dir = detectDirection(text);
      if (dir) applyDir(container, dir);
    }
  }

  function processAllMessages() {
    safeQSA(document, MSG_SEL).forEach(processMessageContainer);
  }

  // ── Composer direction control ─────────────────────────────────────────────
  // Inserted immediately after button[data-testid="composer-plus-btn"] so it
  // lives inside the composer's own flex row — no fixed/absolute positioning,
  // no overlap with typed text or send/mic buttons.
  // Cycles Auto → RTL → LTR → Auto on click.
  // Survives SPA navigation: re-injected via scheduleComposerCheck() whenever
  // the MutationObserver sees mutations outside the message area.

  function syncComposerControl(btn) {
    const el = btn || document.querySelector(`[${DIR_CONTROL_ATTR}]`);
    if (!el) return;
    const mode = settings.forceMode ?? 'auto';
    el.textContent = DIR_MODE_LABELS[mode] ?? DIR_MODE_LABELS.auto;
    el.setAttribute('aria-label',
      `Input direction: ${mode}. Click to switch to ${DIR_MODE_CYCLE[mode]}.`);
    el.dataset.mode = mode;
  }

  function ensureComposerDirectionControl() {
    if (!settings.enabled) return;

    // Anchor: the native "+" (add files) button that ChatGPT always renders.
    const plusBtn = document.querySelector(
      'button[data-testid="composer-plus-btn"], #composer-plus-btn'
    );
    if (!plusBtn) return;

    const parent = plusBtn.parentElement;
    if (!parent) return;

    // Duplicate guard: if our button already lives in this exact parent, just
    // refresh its label and bail — do NOT append a second copy.
    const existing = parent.querySelector(`[${DIR_CONTROL_ATTR}]`);
    if (existing) { syncComposerControl(existing); return; }

    const btn = document.createElement('button');
    btn.setAttribute(DIR_CONTROL_ATTR, 'true');
    btn.type      = 'button';
    btn.className = 'composer-btn cgpt-dir-control-inline';
    btn.title     = 'Cycle input direction: Auto → RTL → LTR → Auto\n(Alt+Shift+R / L / A)';

    syncComposerControl(btn);

    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!settings.enabled) return;
      const newMode = DIR_MODE_CYCLE[settings.forceMode] ?? 'auto';
      settings    = { ...settings, forceMode: newMode };
      settingsGen++;
      fullScan(); // re-classifies messages, input, and syncs this button
      storageGetCb(STORAGE_KEY, result => {
        const s = { ...DEFAULTS, ...(result[STORAGE_KEY] ?? {}) };
        s.forceMode = newMode;
        storageSet({ [STORAGE_KEY]: s });
      });
    });

    // Place immediately after the + button so it appears in the leading
    // toolbar area, not at the far end near send/mic.
    plusBtn.insertAdjacentElement('afterend', btn);
  }

  function handleResize() {
    // No fixed-position recalculation needed — the button is part of the
    // composer's native flex layout.  Just re-check that it is still present
    // (viewport resize can trigger a ChatGPT re-render on mobile).
    scheduleComposerCheck();
  }

  function scheduleComposerCheck() {
    clearTimeout(composerTimer);
    composerTimer = setTimeout(ensureComposerDirectionControl, DEBOUNCE_MS);
  }

  // ── Input processing ──────────────────────────────────────────────────────

  function processInput(el) {
    const text = el.textContent ?? el.value ?? '';
    // resolveDir handles force modes — always call so an empty input in RTL/LTR
    // force mode gets the correct direction before the user types anything.
    const dir = resolveDir(text);
    if (dir) applyInputDir(el, dir);
    else clearInputDir(el);
  }

  function processAllInputs() {
    safeQSA(document, INPUT_SEL).forEach(processInput);
  }

  // ── Full scan — init and settings changes only ────────────────────────────

  function fullScan() {
    if (!settings.enabled) return;
    processAllMessages();
    processAllInputs();
    ensureComposerDirectionControl();
  }

  // ── Targeted scan — mutation-driven ──────────────────────────────────────
  // Only processes the specific containers that received DOM mutations.
  // Containers are accumulated across the debounce window then processed once.

  function scheduleTargetedScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (pendingContainers.size === 0) return;

      const targets = new Set(pendingContainers);
      pendingContainers.clear();

      const work = () => {
        if (!settings.enabled) return;
        targets.forEach(processMessageContainer);
        processAllInputs();
      };

      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(work, { timeout: 500 });
      } else {
        work();
      }
    }, DEBOUNCE_MS);
  }

  // ── MutationObserver ──────────────────────────────────────────────────────
  // Intentionally omits `attributes: true` — our own setAttribute calls must
  // not create feedback loops.

  function toElement(node) {
    // Text nodes have no .closest(); resolve to their parent element.
    return node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  }

  function findAffectedContainers(mutations) {
    const found = new Set();
    for (const m of mutations) {
      if (m.type === 'characterData') {
        // m.target is always a TextNode for characterData
        const el = m.target.parentElement;
        if (el) {
          const c = safeClosest(el, MSG_SEL);
          if (c) found.add(c);
        }
      } else if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          const el = toElement(node);
          if (el && el.nodeType === Node.ELEMENT_NODE) {
            const c = safeClosest(el, MSG_SEL);
            if (c) found.add(c);
          }
        }
      }
    }
    return found;
  }

  function startObserver() {
    if (domObserver) domObserver.disconnect();
    domObserver = new MutationObserver(mutations => {
      const containers = findAffectedContainers(mutations);
      if (containers.size === 0) {
        // Mutations outside the message area — could be SPA navigation that
        // unmounted the composer. Re-check for the direction control.
        scheduleComposerCheck();
        return;
      }
      containers.forEach(c => pendingContainers.add(c));
      scheduleTargetedScan();
    });
    domObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  function handleKeydown(e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.isComposing) return;

    let newMode = null;
    if (e.code === 'KeyR') newMode = 'rtl';
    else if (e.code === 'KeyL') newMode = 'ltr';
    else if (e.code === 'KeyA') newMode = 'auto';
    else return;

    e.preventDefault();
    e.stopPropagation();

    settings    = { ...settings, forceMode: newMode };
    settingsGen++;   // invalidate text cache so all elements re-classify
    fullScan();

    storageGetCb(STORAGE_KEY, result => {
      const s = { ...DEFAULTS, ...(result[STORAGE_KEY] ?? {}) };
      s.forceMode = newMode;
      storageSet({ [STORAGE_KEY]: s });
    });
  }

  // ── Input event listener ──────────────────────────────────────────────────

  function handleInput(e) {
    if (!settings.enabled) return;
    const inputEl = e.target.closest ? safeClosest(e.target, INPUT_SEL) : null;
    if (inputEl) processInput(inputEl);
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  function applyTypographyClass() {
    document.body.classList.toggle(
      'cgpt-persian-typography',
      !!(settings.enabled && settings.persianTypography)
    );
  }

  function applySettings(incoming) {
    settings    = { ...DEFAULTS, ...incoming };
    settingsGen++;   // invalidate text cache
    applyTypographyClass();
    if (!settings.enabled) {
      safeQSA(document, '.cgpt-rtl, .cgpt-ltr').forEach(clearDir);
      safeQSA(document, '.cgpt-input-rtl, .cgpt-input-ltr').forEach(clearInputDir);
      const ctrl = document.querySelector(`[${DIR_CONTROL_ATTR}]`);
      if (ctrl) ctrl.remove();
    } else {
      fullScan(); // fullScan calls ensureComposerDirectionControl
    }
  }

  function loadSettings(cb) {
    storageGetCb(STORAGE_KEY, result => {
      applySettings(result[STORAGE_KEY] ?? {});
      cb();
    });
  }

  _ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[STORAGE_KEY]) {
      applySettings(changes[STORAGE_KEY].newValue ?? {});
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    if (initialized) return;   // prevent duplicate listeners on SPA re-entry
    initialized = true;
    loadSettings(() => {
      startObserver();
      document.addEventListener('input',   handleInput,   true);
      document.addEventListener('keydown', handleKeydown, true);
      window.addEventListener('resize',    handleResize);
      fullScan();
    });
  }

  // ChatGPT is a React SPA — let the initial render complete first.
  setTimeout(init, INIT_DELAY_MS);

})();
