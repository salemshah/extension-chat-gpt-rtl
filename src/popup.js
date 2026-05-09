'use strict';

const STORAGE_KEY = 'cgptRtlSettings';

const DEFAULTS = {
  enabled:           true,
  autoDetect:        true,
  forceMode:         'auto',   // 'auto' | 'rtl' | 'ltr'
  persianTypography: true,
};

// ── Element refs ──────────────────────────────────────────────────────────────

const togEnabled      = document.getElementById('tog-enabled');
const togAutodetect   = document.getElementById('tog-autodetect');
const togTypography   = document.getElementById('tog-typography');
const modeBtns        = document.querySelectorAll('.mode-btn');
const btnReset        = document.getElementById('btn-reset');
const secDetect       = document.getElementById('sec-detect');
const secMode         = document.getElementById('sec-mode');
const secTypography   = document.getElementById('sec-typography');

// ── Render ────────────────────────────────────────────────────────────────────

function render(s) {
  togEnabled.checked    = s.enabled;
  togTypography.checked = s.persianTypography ?? true;

  // Auto-detect toggle is only editable when forceMode is 'auto'
  const autoDetectEditable = s.forceMode === 'auto';
  togAutodetect.checked  = s.autoDetect;
  togAutodetect.disabled = !autoDetectEditable;

  // Highlight the active mode button
  modeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === s.forceMode));

  // Grey out dependent sections when the extension is disabled
  secDetect.classList.toggle('muted', !s.enabled || !autoDetectEditable);
  secMode.classList.toggle('muted', !s.enabled);
  secTypography.classList.toggle('muted', !s.enabled);
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function readSettings(cb) {
  chrome.storage.sync.get(STORAGE_KEY, result => {
    cb({ ...DEFAULTS, ...(result[STORAGE_KEY] ?? {}) });
  });
}

function writeSettings(patch) {
  readSettings(current => {
    const next = { ...current, ...patch };
    chrome.storage.sync.set({ [STORAGE_KEY]: next });
    render(next);
  });
}

// ── Event listeners ───────────────────────────────────────────────────────────

togEnabled.addEventListener('change', () => {
  writeSettings({ enabled: togEnabled.checked });
});

togAutodetect.addEventListener('change', () => {
  writeSettings({ autoDetect: togAutodetect.checked });
});

togTypography.addEventListener('change', () => {
  writeSettings({ persianTypography: togTypography.checked });
});

modeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    writeSettings({ forceMode: btn.dataset.mode });
  });
});

btnReset.addEventListener('click', () => {
  chrome.storage.sync.set({ [STORAGE_KEY]: DEFAULTS });
  render(DEFAULTS);
});

// ── Init ──────────────────────────────────────────────────────────────────────

readSettings(render);
