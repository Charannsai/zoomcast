# dxgi_capture.spec
# PyInstaller spec for dxgi_capture.py → dxgi_capture.exe
# Bundles dxcam (DirectX Desktop Duplication) + numpy into a single exe.

block_cipher = None

a = Analysis(
    ['dxgi_capture.py'],
    pathex=['.'],
    binaries=[],
    datas=[],
    hiddenimports=[
        'dxcam',
        'dxcam.core',
        'dxcam.device',
        'dxcam.output',
        'dxcam.processor',
        'dxcam.util',
        'dxcam.util.timer',
        'numpy',
        'numpy.core',
        'numpy.core._multiarray_umath',
        'ctypes',
        'ctypes.wintypes',
        'subprocess',
        'threading',
        'queue',
        'time',
        'sys',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', 'matplotlib', 'scipy', 'pandas',
        'PyQt5', 'PyQt6', 'wx', 'gi',
        'pynput', 'PIL._tkinter_finder',
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
    name='dxgi_capture',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,      # must be True — talks to Electron via stdin/stdout
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    uac_admin=False,
)
