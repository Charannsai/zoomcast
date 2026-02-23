"""
app_builder_wrapper.py - Wraps the real app-builder.exe to intercept
winCodeSign download-artifact calls and serve from pre-extracted cache.
"""
import sys
import os
import subprocess
import shutil

# ── Path resolution (works both as script and PyInstaller bundle) ──────────
if getattr(sys, 'frozen', False):
    # Running as compiled exe: sys.executable = path to the wrapper .exe
    EXE_DIR = os.path.dirname(sys.executable)
else:
    EXE_DIR = os.path.dirname(os.path.abspath(__file__))

# Walk up from scripts/ to the project root, then into app-builder-bin
# This works whether the wrapper is in scripts/ or node_modules/app-builder-bin/win/x64/
def find_app_builder_bin():
    """Find the real app-builder-bin win/x64 directory."""
    # Strategy: look for app-builder-bin relative to known locations
    candidates = [
        # Same dir as wrapper (when placed next to app-builder.exe)
        os.path.join(EXE_DIR, "app-builder-real.exe"),
        # From scripts/ → go up to project root → node_modules
        os.path.join(EXE_DIR, "..", "node_modules", "app-builder-bin", "win", "x64", "app-builder.exe"),
        # Absolute fallback for this specific project
        r"C:\Users\karth\OneDrive\Desktop\zoomcast\node_modules\app-builder-bin\win\x64\app-builder.exe",
    ]
    for c in candidates:
        c = os.path.normpath(c)
        if os.path.isfile(c):
            return c
    return None

REAL_EXE_PATH = find_app_builder_bin()
SEVENZIP = os.path.normpath(os.path.join(EXE_DIR, "..", "node_modules", "7zip-bin", "win", "x64", "7za.exe"))
if not os.path.isfile(SEVENZIP):
    # Try absolute path for this project
    SEVENZIP = r"C:\Users\karth\OneDrive\Desktop\zoomcast\node_modules\7zip-bin\win\x64\7za.exe"
CACHE_BASE = os.environ.get("ELECTRON_BUILDER_CACHE",
             os.path.join(os.environ.get("LOCALAPPDATA", ""),
                          "electron-builder", "Cache"))
CACHE_DIR  = os.path.join(CACHE_BASE, "winCodeSign")


def find_valid_cache():
    """Return first extracted winCodeSign folder that has signtool.exe."""
    if not os.path.isdir(CACHE_DIR):
        return None
    try:
        entries = os.listdir(CACHE_DIR)
    except OSError:
        return None
    for entry in sorted(entries):
        if entry.endswith(".7z"):
            continue
        candidate = os.path.join(CACHE_DIR, entry)
        if not os.path.isdir(candidate):
            continue
        signtool = os.path.join(candidate, "windows-10", "x64", "signtool.exe")
        if os.path.isfile(signtool):
            return candidate
    return None


def extract_any_7z():
    """Find a .7z in cache, extract with -snl flag, delete the .7z."""
    if not os.path.isdir(CACHE_DIR):
        return None
    if not os.path.isfile(SEVENZIP):
        return None
    try:
        entries = os.listdir(CACHE_DIR)
    except OSError:
        return None
    for entry in sorted(entries):
        if not entry.endswith(".7z"):
            continue
        archive = os.path.join(CACHE_DIR, entry)
        out_dir = os.path.join(CACHE_DIR, entry[:-3])
        if os.path.isdir(out_dir):
            shutil.rmtree(out_dir, ignore_errors=True)
        os.makedirs(out_dir, exist_ok=True)
        # -snl = skip ALL symlinks (avoids "privilege required" error)
        subprocess.run(
            [SEVENZIP, "x", archive, f"-o{out_dir}", "-snl", "-aoa", "-bd"],
            capture_output=True
        )
        # Remove archive so app-builder won't try to re-extract it
        try:
            os.remove(archive)
        except OSError:
            pass
        signtool = os.path.join(out_dir, "windows-10", "x64", "signtool.exe")
        if os.path.isfile(signtool):
            return out_dir
    return None


def intercept_wincosdesign():
    """Handle winCodeSign download-artifact. Returns path or None to fall-through."""
    # First: try existing valid extracted folder
    path = find_valid_cache()
    if path:
        return path
    # Second: extract any .7z present
    path = extract_any_7z()
    if path:
        return path
    return None


def main():
    args = sys.argv[1:]

    # Intercept: download-artifact --name winCodeSign
    is_download = "download-artifact" in args and "--name" in args
    if is_download:
        try:
            idx = args.index("--name")
            name = args[idx + 1] if idx + 1 < len(args) else ""
        except (ValueError, IndexError):
            name = ""

        if name == "winCodeSign":
            result_path = intercept_wincosdesign()
            if result_path:
                # app-builder expects the resolved path on stdout
                sys.stdout.write(result_path + "\n")
                sys.stdout.flush()
                sys.exit(0)
            # No cached version — fall through to real binary (will download)

    # Pass-through to real app-builder.exe
    if not REAL_EXE_PATH:
        sys.stderr.write("ERROR: Cannot find real app-builder.exe\n")
        sys.exit(1)
    proc = subprocess.run([REAL_EXE_PATH] + args)
    sys.exit(proc.returncode)


if __name__ == "__main__":
    main()
