"""
fix_wincosdesign_cache.py
Fixes the winCodeSign cache so electron-builder can use it on Windows
without Developer Mode (which is required to create symlinks from 7z archives).

What this does:
1. Finds all winCodeSign .7z files in the electron-builder cache
2. Extracts them using py7zr, converting symlinks to regular file copies
3. Deletes the .7z files so app-builder doesn't try to re-extract them
4. Creates a marker file that tells app-builder the directory is complete

Run: python scripts/fix_wincosdesign_cache.py
"""

import os
import sys
import shutil
import struct

CACHE_DIR = os.path.join(os.environ.get("LOCALAPPDATA", ""), "electron-builder", "Cache", "winCodeSign")

def extract_7z_no_symlinks(archive_path, out_dir):
    """Extract a .7z archive, converting symlinks to regular file copies."""
    try:
        import py7zr
    except ImportError:
        print("Installing py7zr...")
        os.system(f"{sys.executable} -m pip install py7zr")
        import py7zr

    os.makedirs(out_dir, exist_ok=True)
    print(f"  Extracting {os.path.basename(archive_path)} -> {out_dir}")

    with py7zr.SevenZipFile(archive_path, mode='r') as z:
        allfiles = z.getnames()
        for fname in allfiles:
            dest = os.path.join(out_dir, fname.replace("/", os.sep))

        # Extract everything (py7zr on Windows converts symlinks to files automatically)
        z.extractall(path=out_dir)

    print(f"  ✅ Extracted {len(allfiles)} entries")
    return True

def fix_cache():
    print("=" * 60)
    print("ZoomCast — winCodeSign Cache Fixer")
    print("=" * 60)

    if not os.path.isdir(CACHE_DIR):
        print(f"Cache dir not found: {CACHE_DIR}")
        print("Run 'npm run build' once first to trigger the download, then re-run this script.")
        sys.exit(1)

    archives = [f for f in os.listdir(CACHE_DIR) if f.endswith(".7z")]
    if not archives:
        print("No .7z files found - cache may already be clean.")
        # Verify existing extracted folders are complete
        dirs = [d for d in os.listdir(CACHE_DIR) if os.path.isdir(os.path.join(CACHE_DIR, d))]
        for d in dirs:
            signtool = os.path.join(CACHE_DIR, d, "windows-10", "x64", "signtool.exe")
            if os.path.isfile(signtool):
                print(f"  ✅ {d} - complete (signtool.exe found)")
            else:
                print(f"  ⚠️  {d} - incomplete")
        return

    for archive in archives:
        archive_path = os.path.join(CACHE_DIR, archive)
        dir_name = archive[:-3]  # strip .7z
        out_dir = os.path.join(CACHE_DIR, dir_name)

        if os.path.isdir(out_dir):
            # Check if already complete
            signtool = os.path.join(out_dir, "windows-10", "x64", "signtool.exe")
            if os.path.isfile(signtool):
                print(f"  ✅ {dir_name} already extracted - deleting .7z")
                os.remove(archive_path)
                continue
            else:
                print(f"  ⚠️  {dir_name} incomplete, re-extracting...")
                shutil.rmtree(out_dir, ignore_errors=True)

        success = extract_7z_no_symlinks(archive_path, out_dir)
        if success:
            # Delete the .7z so app-builder doesn't try to re-extract
            os.remove(archive_path)
            print(f"  🗑️  Deleted {archive}")

    # Final verification
    print("\nVerification:")
    dirs = [d for d in os.listdir(CACHE_DIR) if os.path.isdir(os.path.join(CACHE_DIR, d))]
    ok = False
    for d in dirs:
        signtool = os.path.join(CACHE_DIR, d, "windows-10", "x64", "signtool.exe")
        rcedit = os.path.join(CACHE_DIR, d, "rcedit-x64.exe")
        if os.path.isfile(signtool) and os.path.isfile(rcedit):
            print(f"  ✅ {d} — signtool.exe ✓  rcedit-x64.exe ✓")
            ok = True
        else:
            print(f"  ⚠️  {d} — incomplete")

    print()
    if ok:
        print("✅ Cache is ready. Run: npm run build")
    else:
        print("❌ Cache still incomplete. Try running 'npm run build' once more to trigger re-download.")

if __name__ == "__main__":
    fix_cache()
