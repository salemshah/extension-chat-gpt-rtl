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
  const DEBOUNCE_MS        = 160;  // container-level scan (structural changes)
  const STREAM_DEBOUNCE_MS = 80;   // block-level scan (streaming characterData)
  const INIT_DELAY_MS      = 700;

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

  // ── Code-signal regexes (no /g — presence-only tests) ────────────────────
  // Used by classifyPreBlock to score how "code-like" a <pre> block is.
  // Defined without /g so .test() does not advance lastIndex between calls.
  const CS_SHELL_RE   = /^[$#>]\s/m;
  const CS_PKG_RE     = /^(?:npm|yarn|pnpm|pip3?|docker|git|cd|ls|mkdir|rm|cp|mv|curl|wget|sudo)\s/m;
  const CS_STRUCT_RE  = /[{}]/;
  const CS_KW_RE      = /\b(?:function|class|const|let|var|import|export|def|return|async|await|typeof|instanceof|null|undefined)\b/;
  const CS_OP_RE      = /(?:=>|===?|!==?|\+=|-=|\*=|\/=|&&|\|\|)/;
  const CS_PATH_RE    = /\S+\.(?:js|ts|jsx|tsx|py|sh|bash|json|css|html|xml|yaml|yml|go|rs|java|cpp|rb|php)\b/i;
  const CS_INDENT_RE  = /^[ \t]{2,}\S/m;

  // ── State ─────────────────────────────────────────────────────────────────

  let settings    = { ...DEFAULTS };
  let settingsGen = 0;          // bumped on every settings change; invalidates textCache
  let scanTimer     = null;
  let blockTimer    = null;     // separate timer for streaming block-level scan
  let domObserver   = null;
  let composerTimer = null;
  let initialized   = false;      // guards against double-init on SPA re-entry

  // Per-element text cache (WeakMap — GC'd automatically when elements leave the DOM).
  // Stored value: { raw: string, gen: number }
  //   raw — el.textContent at last classification (cheap read, no cloneNode)
  //   gen — settingsGen at last classification
  // Both must match for the fast-path skip to fire.
  const textCache = new WeakMap();

  // Container-level queue: structural changes (childList mutations → full container scan).
  const pendingContainers = new Set();

  // Block-level queue: streaming text updates (characterData mutations → per-block scan).
  // Kept separate so rapid token delivery does not starve the container queue.
  const pendingBlocks = new Set();

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

  // ChatGPT code-block viewer element — classified independently so it can
  // override the generic pre/code rules when it contains prose, not real code.
  const CODE_BLOCK_VIEWER_SEL = '#code-block-viewer, [id="code-block-viewer"]';

  // Edit-message textarea selector.  The exact aria-label match covers the
  // common case; the substring match covers localised or versioned variants.
  const EDIT_TEXTAREA_SEL =
    'textarea[aria-label="Edit message"], textarea[aria-label*="Edit message"]';

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
  // Fast exit: if no code children exist (common during streaming) we skip the
  // expensive cloneNode and return textContent directly.
  function textWithoutCode(el) {
    if (!el.querySelector('pre, code, kbd, samp')) return el.textContent ?? '';
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

  // ── Pre-block classification ──────────────────────────────────────────────
  // Returns 'code-ltr'   — real code; keep LTR.
  // Returns 'natural-rtl' — Persian/Arabic prose falsely wrapped in pre/code.
  //
  // Decision path:
  //  1. RTL character ratio must be >= RTL_THRESHOLD, otherwise it is code or
  //     LTR prose, and we return 'code-ltr' immediately.
  //  2. If RTL is dominant we count code-structure signals (shell prompts,
  //     programming keywords, operators, …).  A score >= 4 means the block is
  //     still real code (e.g. a file with Persian comments) → 'code-ltr'.
  //  3. If the score is low, the block is natural language → 'natural-rtl'.
  //
  // Key discriminator: "برای نصب React از npm install React استفاده کن." has
  // "npm" mid-sentence, NOT at line-start.  CS_PKG_RE anchors to ^ so that
  // embedded commands inside prose do not trigger the code signal.

  // Scores a plain text string against structural code signals.
  // Returns true when the text looks like real code (score >= 4).
  // Shared by classifyPreBlock and processCodeBlockViewer so the exact same
  // heuristic applies regardless of which DOM entry point invokes it.
  function isProbablyCode(text) {
    let score = 0;
    if (CS_SHELL_RE.test(text))  score += 4;   // $, #, > at line start
    if (CS_PKG_RE.test(text))    score += 4;   // npm/docker/git… at line start
    if (CS_STRUCT_RE.test(text)) score += 3;   // { or }
    if (CS_KW_RE.test(text))     score += 3;   // programming keyword
    if (CS_OP_RE.test(text))     score += 3;   // operator sequence
    if (CS_PATH_RE.test(text))   score += 2;   // file.ext reference
    if (CS_INDENT_RE.test(text)) {
      const indentedLines = text.split('\n').filter(l => /^[ \t]{2,}\S/.test(l)).length;
      if (indentedLines >= 2) score += 2;      // consistently indented = code
    }
    if (text.split('\n').filter(l => l.trim()).length > 5) score += 2; // long multi-line
    return score >= 4;
  }

  function classifyPreBlock(pre) {
    const text = (pre.textContent ?? '').trim();
    if (!text) return 'code-ltr';

    // Analyse up to 500 chars — enough signal without scanning huge code files.
    const sample = text.length > 500 ? text.slice(0, 500) : text;

    // No RTL chars → code or LTR natural prose; never a false-positive RTL block.
    const rtlM = sample.match(RTL_RE);
    if (!rtlM) return 'code-ltr';

    const ltrM  = sample.match(LTR_RE);
    const rtlN  = rtlM.length;
    const total = rtlN + (ltrM ? ltrM.length : 0);
    if (total === 0 || rtlN / total < RTL_THRESHOLD) return 'code-ltr';

    return isProbablyCode(text) ? 'code-ltr' : 'natural-rtl';
  }

  // Applies the correct direction to a single <pre> element.
  // Replaces the old "blindly lock all pre to LTR" loop.
  function processPreBlock(pre) {
    // Pre blocks inside #code-block-viewer are classified at the viewer level
    // by processCodeBlockViewer so that the viewer's overall content drives
    // the decision, not just the individual <pre>.
    if (safeClosest(pre, CODE_BLOCK_VIEWER_SEL)) return;

    const text = pre.textContent ?? '';
    if (!text.trim()) {
      if (!pre.classList.contains('cgpt-code-ltr')) {
        pre.setAttribute('dir', 'ltr');
        pre.classList.add('cgpt-code-ltr');
      }
      return;
    }

    // Cache key: first 500 chars of content + settings generation.
    const cacheKey = text.slice(0, 500);
    const cached   = textCache.get(pre);
    if (cached && cached.raw === cacheKey && cached.gen === settingsGen) return;
    textCache.set(pre, { raw: cacheKey, gen: settingsGen });

    // Natural-RTL classification only active when auto-detect is on, and we are
    // in auto mode.  Force-LTR always keeps code LTR; force-RTL lets natural
    // language pre blocks become RTL via the same condition.
    const isNaturalRtl =
      settings.autoDetect &&
      settings.forceMode !== 'ltr' &&
      classifyPreBlock(pre) === 'natural-rtl';

    if (isNaturalRtl) {
      pre.classList.remove('cgpt-code-ltr');
      pre.classList.add('cgpt-natural-rtl-block');
      pre.setAttribute('dir', 'rtl');
    } else {
      pre.classList.remove('cgpt-natural-rtl-block');
      if (pre.getAttribute('dir') !== 'ltr') pre.setAttribute('dir', 'ltr');
      if (!pre.classList.contains('cgpt-code-ltr')) pre.classList.add('cgpt-code-ltr');
    }
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
    // 1. Classify each <pre>: real code → lock LTR; natural RTL prose → apply RTL.
    safeQSA(container, 'pre').forEach(processPreBlock);

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

  // ── Code-block viewer ─────────────────────────────────────────────────────
  // #code-block-viewer is ChatGPT's dedicated code-rendering container.
  // It is classified at the viewer level (not just the inner <pre>) so that
  // the complete text content — including toolbar labels and language hints
  // that appear outside the <pre> — informs the code-vs-prose decision.
  // The result OVERRIDES whatever processPreBlock would apply to the inner pre.

  function processCodeBlockViewer(viewer) {
    const text = (viewer.textContent ?? '').trim();

    // Cache keyed on the viewer element itself (not the inner pre).
    const cacheKey = text.slice(0, 500);
    const cached   = textCache.get(viewer);
    if (cached && cached.raw === cacheKey && cached.gen === settingsGen) return;
    textCache.set(viewer, { raw: cacheKey, gen: settingsGen });

    // Always clear stale markers before re-classifying.
    viewer.classList.remove('cgpt-code-viewer-code', 'cgpt-code-viewer-prose');

    if (!settings.enabled) return;

    // Compute RTL dominance over the first 500 chars of viewer text.
    const sample = cacheKey;
    const rtlM   = sample.match(RTL_RE);
    let isRtlDominant = false;
    if (rtlM) {
      const ltrM  = sample.match(LTR_RE);
      const rtlN  = rtlM.length;
      const total = rtlN + (ltrM ? ltrM.length : 0);
      isRtlDominant = total > 0 && rtlN / total >= RTL_THRESHOLD;
    }

    // Treat as real code when:
    //  - No RTL dominance (most code files)
    //  - Auto-detect is off
    //  - User forced LTR
    //  - Content passes isProbablyCode scoring despite RTL dominance
    const treatAsCode =
      !isRtlDominant         ||
      !settings.autoDetect   ||
      settings.forceMode === 'ltr' ||
      isProbablyCode(text);

    if (treatAsCode) {
      viewer.classList.add('cgpt-code-viewer-code');
      if (viewer.getAttribute('dir') !== 'ltr') viewer.setAttribute('dir', 'ltr');
      safeQSA(viewer, 'pre').forEach(pre => {
        pre.classList.remove('cgpt-natural-rtl-block');
        if (pre.getAttribute('dir') !== 'ltr') pre.setAttribute('dir', 'ltr');
        if (!pre.classList.contains('cgpt-code-ltr')) pre.classList.add('cgpt-code-ltr');
      });
    } else {
      viewer.classList.add('cgpt-code-viewer-prose');
      viewer.setAttribute('dir', 'rtl');
      safeQSA(viewer, 'pre').forEach(pre => {
        pre.classList.remove('cgpt-code-ltr');
        pre.classList.add('cgpt-natural-rtl-block');
        pre.setAttribute('dir', 'rtl');
      });
    }
  }

  function processAllCodeViewers() {
    safeQSA(document, CODE_BLOCK_VIEWER_SEL).forEach(processCodeBlockViewer);
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

    // Help the parent align its children so our button sits at the same
    // vertical midpoint as the + button.  The class is removed when the
    // button is taken out (see applySettings disabled path).
    parent.classList.add('cgpt-dir-control-inline-parent');
  }

  function handleResize() {
    // No fixed-position recalculation needed — the button is part of the
    // composer's native flex layout.  Just re-check that it is still present
    // (viewport resize can trigger a ChatGPT re-render on mobile).
    scheduleComposerCheck();
  }

  function scheduleComposerCheck() {
    clearTimeout(composerTimer);
    composerTimer = setTimeout(() => {
      ensureComposerDirectionControl();
      // Also catch edit textareas that appear outside message containers
      // (e.g., on SPA navigation or when ChatGPT re-renders the message area).
      if (settings.enabled) processAllEditTextareas();
    }, DEBOUNCE_MS);
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
    // Exclude edit-message textareas — they are handled by processAllEditTextareas
    // with per-element listener binding and mirror-span synchronisation.
    safeQSA(document, INPUT_SEL)
      .filter(el => !el.matches(EDIT_TEXTAREA_SEL))
      .forEach(processInput);
  }

  // ── Edit-message textarea ─────────────────────────────────────────────────
  // ChatGPT replaces the message content with a <textarea aria-label="Edit
  // message"> when the user clicks the pencil icon.  This textarea is NOT
  // matched by INPUT_SEL and must be handled separately:
  //  - direction is applied via inline style + dir attribute (not CSS class)
  //  - a mirror <span class="invisible"> next to the textarea is kept in sync
  //    so ChatGPT's auto-resize logic measures the correct text direction
  //  - listeners are attached once per element using a dataset flag

  function applyEditDir(textarea) {
    if (!settings.enabled) { clearEditDir(textarea); return; }

    const text = textarea.value || textarea.textContent || '';
    const dir  = resolveDir(text);

    if (dir) {
      const isRtl = dir === 'rtl';
      textarea.setAttribute('dir', dir);
      textarea.style.direction   = dir;
      textarea.style.textAlign   = isRtl ? 'right' : 'left';
      textarea.style.unicodeBidi = 'plaintext';
      textarea.classList.add(isRtl    ? 'cgpt-edit-input-rtl' : 'cgpt-edit-input-ltr');
      textarea.classList.remove(isRtl ? 'cgpt-edit-input-ltr' : 'cgpt-edit-input-rtl');

      // Keep the invisible mirror span in sync so auto-sizing is accurate.
      const grid   = safeClosest(textarea, '.grid');
      const mirror = grid ? grid.querySelector('span.invisible') : null;
      if (mirror) {
        mirror.setAttribute('dir', dir);
        mirror.style.direction   = dir;
        mirror.style.textAlign   = isRtl ? 'right' : 'left';
        mirror.style.unicodeBidi = 'plaintext';
      }
    } else {
      clearEditDir(textarea);
    }
  }

  function clearEditDir(textarea) {
    textarea.classList.remove('cgpt-edit-input-rtl', 'cgpt-edit-input-ltr');
    textarea.removeAttribute('dir');
    textarea.style.direction   = '';
    textarea.style.textAlign   = '';
    textarea.style.unicodeBidi = '';

    const grid   = safeClosest(textarea, '.grid');
    const mirror = grid ? grid.querySelector('span.invisible') : null;
    if (mirror) {
      mirror.removeAttribute('dir');
      mirror.style.direction   = '';
      mirror.style.textAlign   = '';
      mirror.style.unicodeBidi = '';
    }
  }

  function processEditMessageTextarea(textarea) {
    if (!settings.enabled) { clearEditDir(textarea); return; }

    // Bind listeners once per element (dataset flag acts as a WeakSet).
    if (textarea.dataset.cgptEditRtlBound !== 'true') {
      textarea.dataset.cgptEditRtlBound = 'true';
      textarea.addEventListener('input',  () => applyEditDir(textarea));
      textarea.addEventListener('focus',  () => applyEditDir(textarea));
      textarea.addEventListener('paste',  () => setTimeout(() => applyEditDir(textarea), 0));
    }

    applyEditDir(textarea);
  }

  function processAllEditTextareas() {
    safeQSA(document, EDIT_TEXTAREA_SEL).forEach(processEditMessageTextarea);
  }

  // ── Full scan — init and settings changes only ────────────────────────────

  function fullScan() {
    if (!settings.enabled) return;
    processAllMessages();
    processAllCodeViewers();
    processAllInputs();
    processAllEditTextareas();
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
        processAllCodeViewers();
        processAllInputs();
        processAllEditTextareas();
      };

      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(work, { timeout: 500 });
      } else {
        work();
      }
    }, DEBOUNCE_MS);
  }

  // ── Block-level streaming scan ────────────────────────────────────────────
  // Fires at STREAM_DEBOUNCE_MS (80 ms) — faster than the container scan so
  // that streaming RTL blocks get classified before the next token batch lands.
  // Only processes the individual p/li/… elements that received characterData
  // mutations; never re-scans entire message containers.

  function scheduleBlockScan() {
    clearTimeout(blockTimer);
    blockTimer = setTimeout(() => {
      if (pendingBlocks.size === 0) return;
      if (!settings.enabled) { pendingBlocks.clear(); return; }

      const targets = new Set(pendingBlocks);
      pendingBlocks.clear();

      targets.forEach(el => {
        if (!document.contains(el)) return; // removed between schedule and fire
        if (el.tagName === 'PRE') processPreBlock(el);
        else processBlock(el);
      });
    }, STREAM_DEBOUNCE_MS);
  }

  // ── MutationObserver ──────────────────────────────────────────────────────
  // Intentionally omits `attributes: true` — our own setAttribute calls must
  // not create feedback loops.

  function toElement(node) {
    // Text nodes have no .closest(); resolve to their parent element.
    return node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  }

  // Returns { blocks: Set<Element>, containers: Set<Element> }
  //   blocks     — individual BLOCK_SEL elements from characterData mutations
  //                (streaming text updates — processed at 80 ms)
  //   containers — MSG_SEL containers from childList mutations
  //                (structural changes — processed at 160 ms)
  function findAffectedMutations(mutations) {
    const blocks     = new Set();
    const containers = new Set();

    for (const m of mutations) {
      if (m.type === 'characterData') {
        // m.target is always a TextNode; resolve to its parent element.
        const el = m.target.parentElement;
        if (!el) continue;
        // Text inside <pre>/<code> is handled at the pre-block level; skip here.
        if (safeClosest(el, 'pre, code')) continue;
        // Walk up to the nearest inline block ancestor (p, li, h1, …).
        const block = el.matches(BLOCK_SEL) ? el : safeClosest(el, BLOCK_SEL);
        if (block) {
          blocks.add(block);
        } else {
          // No BLOCK_SEL ancestor — fall back to a full container scan so
          // plain-text user messages (no <p> children) are still processed.
          const c = safeClosest(el, MSG_SEL);
          if (c) containers.add(c);
        }
      } else if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          const el = toElement(node);
          if (el && el.nodeType === Node.ELEMENT_NODE) {
            const c = safeClosest(el, MSG_SEL);
            if (c) containers.add(c);
          }
        }
      }
    }

    return { blocks, containers };
  }

  function startObserver() {
    if (domObserver) domObserver.disconnect();
    domObserver = new MutationObserver(mutations => {
      const { blocks, containers } = findAffectedMutations(mutations);

      if (blocks.size === 0 && containers.size === 0) {
        // Mutations outside the message area — SPA navigation, composer re-render, etc.
        scheduleComposerCheck();
        return;
      }

      // Fast path: streaming text changes — re-classify only the mutated blocks.
      if (blocks.size > 0) {
        blocks.forEach(b => pendingBlocks.add(b));
        scheduleBlockScan();
      }

      // Structural path: new nodes added — re-scan the whole container.
      if (containers.size > 0) {
        containers.forEach(c => pendingContainers.add(c));
        scheduleTargetedScan();
      }
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
      safeQSA(document, '.cgpt-natural-rtl-block').forEach(pre => {
        pre.classList.remove('cgpt-natural-rtl-block');
        pre.setAttribute('dir', 'ltr');
        pre.classList.add('cgpt-code-ltr');
      });
      safeQSA(document, CODE_BLOCK_VIEWER_SEL).forEach(viewer => {
        viewer.classList.remove('cgpt-code-viewer-code', 'cgpt-code-viewer-prose');
        viewer.removeAttribute('dir');
      });
      safeQSA(document, EDIT_TEXTAREA_SEL).forEach(clearEditDir);
      const ctrl = document.querySelector(`[${DIR_CONTROL_ATTR}]`);
      if (ctrl) {
        if (ctrl.parentElement) {
          ctrl.parentElement.classList.remove('cgpt-dir-control-inline-parent');
        }
        ctrl.remove();
      }
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
