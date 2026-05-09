# ChatGPT RTL Support

A lightweight Chrome (and Firefox) extension that automatically applies correct
right-to-left text direction for Persian, Arabic, Hebrew, and Urdu inside
ChatGPT — without breaking the existing UI.

---

## Features

- Auto-detects RTL script per paragraph / list item using Unicode character counting
- Applies `dir="rtl"` and correct text alignment to messages and the input area
- Code blocks (`<pre>`, `<code>`) are **always forced LTR**
- Mixed-language text (e.g. a Persian sentence with inline English code) renders
  correctly via the browser's built-in Unicode Bidirectional Algorithm
- Copy buttons, sidebars, menus, and modals are never modified
- MutationObserver handles ChatGPT's streaming SPA with a 160 ms debounce
- Keyboard shortcuts for hands-free direction switching
- Popup with Enable/Disable, Auto-detect toggle, Force RTL / Force LTR modes
- Settings synced across devices via `chrome.storage.sync`
- Zero tracking · Zero analytics · No external network requests

---

## Installation

### 1. Get the files

```
git clone <repo-url> chat-gpt-rtl
cd chat-gpt-rtl
```

### 2. Icons are included

Real PNG icons (`icons/icon16.png`, `icon48.png`, `icon128.png`) are generated
by `generate_icons.py` and committed to the repo.  
To regenerate them at any time:

```bash
python3 generate_icons.py
```

No third-party packages required — uses only Python's standard library.

### 3. Load as an unpacked Chrome extension

1. Open **chrome://extensions**
2. Enable **Developer mode** (toggle, top-right corner)
3. Click **Load unpacked** → select the `chat-gpt-rtl` folder
4. The extension icon appears in the toolbar

### 4. Firefox (optional)

Firefox supports Manifest V3 extensions with the same file set:

1. Open **about:debugging#/runtime/this-firefox**
2. Click **Load Temporary Add-on…** → select `manifest.json`

The extension uses a cross-browser storage shim (`browser.*` / `chrome.*`) so
it works in both browsers without modification.

---

## Keyboard Shortcuts

These shortcuts activate **on any ChatGPT tab** while the extension is enabled:

| Shortcut | Action |
|---|---|
| `Alt + Shift + R` | Force RTL mode |
| `Alt + Shift + L` | Force LTR mode |
| `Alt + Shift + A` | Return to Auto-detect |

> On macOS, `Alt` is the `Option` key.

---

## How RTL Detection Works

```
Input text  (code nodes stripped first)
     │
     ├── count strongly-RTL characters
     │     Arabic / Persian / Urdu  U+0600–U+06FF + extended ranges
     │     Hebrew                   U+0590–U+05FF + presentation forms
     │     Syriac, N'Ko, Samaritan, Arabic Extended-A, …
     │
     ├── count strongly-LTR characters  (Latin, Cyrillic, Greek)
     │
     └── ratio = RTL ÷ (RTL + LTR)
             ≥ 30 %  →  dir="rtl"  +  class .cgpt-rtl
             < 30 %  →  dir="ltr"  +  class .cgpt-ltr
             no strong chars  →  leave unchanged
```

The 30 % threshold is intentionally permissive so mixed sentences classify
correctly as RTL.  Inside an RTL block the browser's bidi algorithm handles
inline Latin/code fragments automatically.

---

## Test Cases

Use these snippets to verify the extension is working after installation.

| Input | Expected result |
|---|---|
| `سلام دنیا` | RTL — text aligns right |
| `مرحباً بالعالم` | RTL — Arabic |
| `שלום עולם` | RTL — Hebrew |
| `Hello world` | LTR — no change |
| `برای نصب React از npm install react استفاده کن` | RTL — mixed Persian + English |
| `برای نصب: \`npm install react\`` | RTL message, code span stays LTR |
| ` ```python\nprint("hello")\n``` ` | Code block stays LTR regardless of surrounding context |
| _(empty input)_ | No direction set — default browser behavior |

To test: paste each line into the ChatGPT input and send (or paste into an
existing conversation).  You can also paste directly into the input box to
verify the typing direction switches in real time.

---

## Popup Controls

| Control | Description |
|---|---|
| **Enable extension** | Master on/off — removes all direction overrides when off |
| **Auto-detect direction** | Classify each paragraph independently (active in Auto mode) |
| **Auto** | Auto-detect mode (default) |
| **Force RTL** | Force every message RTL regardless of content |
| **Force LTR** | Force every message LTR regardless of content |
| **Reset to defaults** | Restore all settings to their original values |

---

## Known Limitations

| Limitation | Notes |
|---|---|
| ChatGPT DOM may change | Selectors use data-attributes and semantic HTML; class-name fallbacks are secondary |
| Streaming direction flicker | If early tokens are Latin, a message may briefly show LTR before enough RTL characters arrive to flip it |
| Global mode only | Direction setting applies to all chats, not per-conversation |
| Right-click context menus | Browser-native menus are outside extension scope |
| Unpacked extensions do not auto-update | Reload manually after pulling changes |

---

## Privacy

This extension:

- Does **not** read, collect, store, or transmit any message content
- Does **not** contact any external server or URL
- Does **not** include analytics, telemetry, or fingerprinting of any kind
- Only uses `chrome.storage.sync` to persist your UI preferences (forceMode,
  autoDetect, enabled) — nothing else is ever written to storage
- All processing (character counting, DOM mutation) happens **locally in the
  browser** — no data leaves the page

Permissions used:
- `storage` — save popup toggle state across sessions

No host permissions are declared beyond the content-script `matches`.

---

## Reporting an Issue

If something looks wrong, please open an issue and include:

1. **Browser name and version** (e.g. Chrome 125, Firefox 127)
2. **ChatGPT URL** when the problem occurred (`chatgpt.com` or `chat.openai.com`)
3. **Example text** that is not rendering correctly (paste the raw string)
4. **Extension settings** at the time (Auto / Force RTL / Force LTR, auto-detect on/off)
5. **Screenshot** of the broken rendering if possible
6. **Console errors** — open DevTools → Console and note any red errors from
   `content.js`

---

## File Structure

```
chat-gpt-rtl/
├── manifest.json          Chrome / Firefox Extension Manifest V3
├── generate_icons.py      Icon generator (stdlib only, no pip deps)
├── create_icons.html      Alternative browser-based icon generator
├── src/
│   ├── content.js         RTL detection · MutationObserver · keyboard shortcuts
│   ├── popup.html         Popup UI markup + styles
│   ├── popup.js           Settings load / save via chrome.storage
│   └── styles.css         .cgpt-rtl / .cgpt-ltr / code-LTR rules
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── CHANGELOG.md
└── README.md
```

---

## Development

No build step.  Edit source files, then reload the extension in
**chrome://extensions** → click the refresh icon next to the extension.

```
src/content.js   — detection logic, MutationObserver, keyboard shortcuts
src/styles.css   — .cgpt-rtl / .cgpt-ltr / forced-LTR rules for code
src/popup.html   — popup markup and inline styles
src/popup.js     — settings state management (chrome.storage.sync)
```

---

## License

MIT
