@echo off
title ZoomCast — Screen.studio for Windows
color 0B
echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║   ZoomCast — Screen.studio for Windows       ║
echo  ║   Professional Screen Recorder + Editor      ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python not found. Install from https://python.org
    pause
    exit /b 1
)
python --version

echo.
echo  [1/2] Installing required packages...
echo  (This only runs once)
echo.

pip install mss pillow opencv-python numpy pynput pywin32

echo.
echo  ══════════════════════════════════════════════
echo  [2/2] Launching ZoomCast...
echo  ══════════════════════════════════════════════
echo.

python zoomcast.py

if errorlevel 1 (
    echo.
    echo  [ERROR] ZoomCast failed to start.
    echo  Please check the error above and retry.
    pause
)