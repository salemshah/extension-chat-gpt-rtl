'use strict';

const STORAGE_KEY  = 'cgptRtlSettings';
const LANG_KEY     = 'popupLanguage';
const LANG_DEFAULT = 'fa';

const DEFAULTS = {
  enabled:           true,
  autoDetect:        true,
  forceMode:         'auto',   // 'auto' | 'rtl' | 'ltr'
  persianTypography: true,
};

// ── Translations ──────────────────────────────────────────────────────────────

const I18N = {
  fa: {
    headerTitle:       'پشتیبانی RTL در ChatGPT',
    headerSub:         'فارسی · عربی · عبری · اردو',
    langLabel:         'زبان',
    enableLabel:       'فعال‌سازی افزونه',
    enableSub:         'اعمال جهت RTL در ChatGPT',
    detectionTitle:    'تشخیص',
    autoDetectLabel:   'تشخیص خودکار جهت',
    autoDetectSub:     'هر پیام را به‌صورت جداگانه دسته‌بندی می‌کند',
    typographyTitle:   'تایپوگرافی',
    typographyLabel:   'بهبود تایپوگرافی فارسی',
    typographySub:     'فونت و فاصله‌گذاری بهتر برای متن RTL',
    overrideTitle:     'تغییر اجباری جهت',
    modeAuto:          '⇄',
    modeRtl:           'اب ←',
    modeLtr:           '→ ab',
    shortcutsTitle:    'میانبرهای صفحه‌کلید',
    shortcutRtl:       'RTL اجباری',
    shortcutLtr:       'LTR اجباری',
    shortcutAuto:      'حالت خودکار',
    resetBtn:          'بازنشانی به پیش‌فرض',
    footerNoTracking:  'بدون ردیابی',
    footerNoAnalytics: 'بدون تحلیل',
  },
  en: {
    headerTitle:       'ChatGPT RTL Support',
    headerSub:         'Persian · Arabic · Hebrew · Urdu',
    langLabel:         'Language',
    enableLabel:       'Enable extension',
    enableSub:         'Apply RTL direction on ChatGPT',
    detectionTitle:    'Detection',
    autoDetectLabel:   'Auto-detect direction',
    autoDetectSub:     'Classifies each message individually',
    typographyTitle:   'Typography',
    typographyLabel:   'Improve Persian typography',
    typographySub:     'Better font & spacing for RTL text',
    overrideTitle:     'Direction override',
    modeAuto:          '⇄',
    modeRtl:           'اب ←',
    modeLtr:           '→ ab',
    shortcutsTitle:    'Keyboard shortcuts',
    shortcutRtl:       'Force RTL',
    shortcutLtr:       'Force LTR',
    shortcutAuto:      'Auto mode',
    resetBtn:          'Reset to defaults',
    footerNoTracking:  'No tracking',
    footerNoAnalytics: 'No analytics',
  },
  ar: {
    headerTitle:       'دعم RTL في ChatGPT',
    headerSub:         'فارسي · عربي · عبري · أردو',
    langLabel:         'اللغة',
    enableLabel:       'تفعيل الإضافة',
    enableSub:         'تطبيق اتجاه RTL في ChatGPT',
    detectionTitle:    'الكشف',
    autoDetectLabel:   'الكشف التلقائي عن الاتجاه',
    autoDetectSub:     'يصنّف كل رسالة بشكل مستقل',
    typographyTitle:   'الطباعة',
    typographyLabel:   'تحسين الطباعة العربية',
    typographySub:     'خط وتباعد أفضل للنص RTL',
    overrideTitle:     'تجاوز الاتجاه',
    modeAuto:          '⇄',
    modeRtl:           'اب ←',
    modeLtr:           '→ ab',
    shortcutsTitle:    'اختصارات لوحة المفاتيح',
    shortcutRtl:       'RTL إجباري',
    shortcutLtr:       'LTR إجباري',
    shortcutAuto:      'الوضع التلقائي',
    resetBtn:          'إعادة الضبط الافتراضي',
    footerNoTracking:  'بدون تتبع',
    footerNoAnalytics: 'بدون تحليلات',
  },
};

// ── Element refs ──────────────────────────────────────────────────────────────

const togEnabled    = document.getElementById('tog-enabled');
const togAutodetect = document.getElementById('tog-autodetect');
const togTypography = document.getElementById('tog-typography');
const modeBtns      = document.querySelectorAll('.mode-btn');
const btnReset      = document.getElementById('btn-reset');
const secDetect     = document.getElementById('sec-detect');
const secMode       = document.getElementById('sec-mode');
const secTypography = document.getElementById('sec-typography');
const selLang       = document.getElementById('sel-lang');

// ── Language rendering ────────────────────────────────────────────────────────

function renderLanguage(lang) {
  const t   = I18N[lang] || I18N[LANG_DEFAULT];
  const rtl = lang === 'fa' || lang === 'ar';

  document.documentElement.dir  = rtl ? 'rtl' : 'ltr';
  document.documentElement.lang = lang;
  document.body.dir              = rtl ? 'rtl' : 'ltr';

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (key in t) el.textContent = t[key];
  });

  if (selLang) selLang.value = lang;
}

// ── Settings render ───────────────────────────────────────────────────────────

function render(s) {
  togEnabled.checked    = s.enabled;
  togTypography.checked = s.persianTypography ?? true;

  const autoDetectEditable = s.forceMode === 'auto';
  togAutodetect.checked  = s.autoDetect;
  togAutodetect.disabled = !autoDetectEditable;

  modeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === s.forceMode));

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

function readLang(cb) {
  chrome.storage.sync.get(LANG_KEY, result => {
    cb(result[LANG_KEY] ?? LANG_DEFAULT);
  });
}

function writeLang(lang) {
  chrome.storage.sync.set({ [LANG_KEY]: lang });
  renderLanguage(lang);
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

selLang.addEventListener('change', () => {
  writeLang(selLang.value);
});

btnReset.addEventListener('click', () => {
  chrome.storage.sync.set({
    [STORAGE_KEY]: DEFAULTS,
    [LANG_KEY]:    LANG_DEFAULT,
  });
  render(DEFAULTS);
  renderLanguage(LANG_DEFAULT);
});

// ── Init ──────────────────────────────────────────────────────────────────────
// Read saved language first so the popup renders in the correct language
// immediately — no visible flash or relayout after load.

readLang(lang => {
  renderLanguage(lang);
  readSettings(render);
});
