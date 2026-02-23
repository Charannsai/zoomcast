# 🚀 ZoomCast — How to Build & Distribute

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run in development
npm start

# 3. Build Windows installer
npm run build
```

---

## Distribution Targets

Running `npm run build` produces **two files** in the `dist/` folder:

| File | Type | Use case |
|------|------|----------|
| `ZoomCast Setup 1.0.0.exe` | NSIS Installer | Standard installation (Start Menu, shortcuts, uninstaller) |
| `ZoomCast 1.0.0.exe` | Portable EXE | No install needed — runs directly from any folder / USB |

---

## Prerequisites

### On your development machine (to build):

1. **Node.js 18+** — [nodejs.org](https://nodejs.org)
2. **Python 3.10+** — [python.org](https://python.org) (needed for cursor tracking feature)
3. **Windows Developer Mode** *(required for NSIS installer only)* — needed so 7-zip can create symlinks when packaging electron-builder's code sign tools.
   - Go to: **Settings → System → For Developers → Developer Mode → On**
   - You only need to do this once on your build machine.

### On the end user's machine (to run):

> **⚠️ Important:** ZoomCast requires Python to be installed on the user's machine because cursor tracking uses a Python script (`cursor_tracker.py`). Users will need:
>
> 1. **Python 3.10+** installed and in their PATH
> 2. **pynput** library: `pip install pynput`
>
> Users who don't have Python will still be able to record and edit, but **click detection won't work** (zoom segments won't auto-generate from clicks).

---

## Build Commands

```bash
# Development (live preview)
npm start

# Re-generate app icon
npm run make-icon

# Build unpacked (no installer, fastest — good for testing)
npx electron-builder --dir

# Build full Windows installer + portable (requires Windows Developer Mode)
npm run build

# Build NSIS installer only
npx electron-builder --win nsis

# Build portable only
npx electron-builder --win portable
```

---

## Output Files (`dist/`)

After `npm run build`:
```
dist/
  win-unpacked/           ← Unpacked app (for testing without install)
    ZoomCast.exe          ← Launch directly to test
  ZoomCast Setup 1.0.0.exe   ← Windows installer (share this!)
  ZoomCast 1.0.0.exe         ← Portable version (share this!)
  builder-debug.yml
  builder-effective-config.yaml
```

---

## How to Share / Distribute

### Option A: GitHub Releases (Recommended)
1. Build: `npm run build`
2. Go to your GitHub repo → **Releases → New Release**
3. Tag: `v1.0.0`
4. Upload: `dist/ZoomCast Setup 1.0.0.exe` and `dist/ZoomCast 1.0.0.exe`
5. Publish

### Option B: Direct Download Link
Upload `ZoomCast Setup 1.0.0.exe` to:  
- Google Drive  
- Dropbox / OneDrive  
- Your own website  
- Gumroad (for paid distribution)

### Option C: Portable ZIP
Zip the entire `dist/win-unpacked/` folder → users extract and run `ZoomCast.exe` directly.

---

## Code Signing (Optional, for production)

Without code signing, Windows Defender / SmartScreen may show a warning. For a proper release:

1. Buy an EV code signing certificate (~$200–$500/yr) from DigiCert, Sectigo, etc.
2. Set environment variables:
   ```bash
   WIN_CSC_LINK=path/to/certificate.p12
   WIN_CSC_KEY_PASSWORD=your_password
   ```
3. Then `npm run build` — it will automatically sign.

For a free alternative, users can right-click the EXE → Properties → **Unblock** to bypass SmartScreen.

---

## App Icon

The app icon is generated from `assets/icon.svg`. To regenerate:
```bash
npm run make-icon
```
This creates `assets/icon.png` (256×256) and `assets/icon.ico` (required for Windows builds).

---

## Python Dependency — Making It Seamless

To avoid requiring users to install Python manually, you can bundle a Python runtime:

### Option: Bundle Python with the App
```bash
# Download Python embeddable package (~15MB)
# https://www.python.org/downloads/windows/ → "Windows embeddable package (64-bit)"
# Extract to: resources/python/
# In main.js, update the Python spawn path to use the bundled interpreter
```

This makes ZoomCast fully self-contained.

---

## Version Bump

When ready for a new release:
```bash
npm version patch   # 1.0.0 → 1.0.1
npm version minor   # 1.0.0 → 1.1.0
npm version major   # 1.0.0 → 2.0.0
npm run build
```
