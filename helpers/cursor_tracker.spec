# cursor_tracker.spec
# PyInstaller spec for cursor_tracker.py → cursor_tracker.exe
# Produces a single-file, no-console executable with all pynput deps bundled.

block_cipher = None

a = Analysis(
    ['cursor_tracker.py'],
    pathex=['.'],
    binaries=[],
    datas=[],
    hiddenimports=[
        'pynput.mouse._win32',
        'pynput.keyboard._win32',
        'pynput._util.win32',
        'pynput._util',
        'ctypes',
        'ctypes.wintypes',
        'json',
        'threading',
        'time',
        'sys',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', 'matplotlib', 'scipy', 'pandas',
        'PyQt5', 'PyQt6', 'wx', 'gi',
        'pynput.mouse._darwin', 'pynput.keyboard._darwin',
        'pynput.mouse._xorg', 'pynput.keyboard._xorg',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='cursor_tracker',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,      # must be True — it reads stdin / writes stdout
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    uac_admin=False,
)
