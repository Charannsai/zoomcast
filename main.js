/**
 * ZoomCast — Electron Main Process
 * Handles: window management, screen capture sources, cursor tracking,
 * click detection, file dialogs, and FFmpeg export.
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow = null;
let cursorInterval = null;
let cursorData = [];
let clickData = [];
let recordingStartTime = 0;
let isRecording = false;

// Python cursor tracker process
let cursorTracker = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0e1015',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopCursorTracking();
  });
}

app.whenReady().then(() => {
  createWindow();

  // Register global shortcut for stop recording
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (mainWindow) {
      mainWindow.webContents.send('toggle-recording');
    }
  });

  globalShortcut.register('Escape', () => {
    if (mainWindow && isRecording) {
      mainWindow.webContents.send('stop-recording');
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopCursorTracking();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC Handlers ─────────────────────────────────────────────

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

// Get screen sources for recording
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowInfo: false,
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    display_id: s.display_id,
  }));
});

// Get all displays info
ipcMain.handle('get-displays', () => {
  const displays = screen.getAllDisplays();
  return displays.map(d => ({
    id: d.id,
    bounds: d.bounds,
    size: d.size,
    scaleFactor: d.scaleFactor,
    label: d.label || `Display ${d.id}`,
  }));
});

// Start cursor/click tracking
ipcMain.handle('start-tracking', (event, displayBounds) => {
  cursorData = [];
  clickData = [];
  recordingStartTime = Date.now();
  isRecording = true;

  // Poll cursor position at 30Hz (enough for smooth replay, doesn't starve recorder)
  cursorInterval = setInterval(() => {
    if (!isRecording) return;
    const point = screen.getCursorScreenPoint();
    const t = (Date.now() - recordingStartTime) / 1000;
    // Normalize to display bounds
    const nx = (point.x - (displayBounds?.x || 0)) / (displayBounds?.width || 1920);
    const ny = (point.y - (displayBounds?.y || 0)) / (displayBounds?.height || 1080);
    cursorData.push({ t, x: nx, y: ny, rx: point.x, ry: point.y });
  }, 33); // ~30fps tracking

  // Start Python click tracker
  startClickTracker(displayBounds);

  return { ok: true };
});

// Stop tracking and return data
ipcMain.handle('stop-tracking', () => {
  isRecording = false;
  stopCursorTracking();
  const result = { cursor: cursorData, clicks: clickData };
  return result;
});

// File dialog for export
ipcMain.handle('show-save-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: options.defaultPath || path.join(app.getPath('desktop'), `zoomcast_${Date.now()}.mp4`),
    filters: [
      { name: 'MP4 Video', extensions: ['mp4'] },
      { name: 'WebM Video', extensions: ['webm'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result;
});

// Save recorded video blob to temp file
ipcMain.handle('save-temp-video', async (event, buffer) => {
  const tmpDir = path.join(app.getPath('temp'), 'zoomcast');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `recording_${Date.now()}.webm`);
  fs.writeFileSync(tmpPath, Buffer.from(buffer));
  return tmpPath;
});

// Get temp directory
ipcMain.handle('get-temp-dir', () => {
  const tmpDir = path.join(app.getPath('temp'), 'zoomcast');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
});

// Export video with FFmpeg
ipcMain.handle('export-video', async (event, options) => {
  const { inputPath, outputPath, framesDir } = options;

  try {
    let ffmpegPath;
    try {
      ffmpegPath = require('ffmpeg-static');
    } catch {
      ffmpegPath = 'ffmpeg'; // fallback to system ffmpeg
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-framerate', String(options.fps || 30),
        '-i', path.join(framesDir, 'frame_%06d.png'),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'medium',
        '-crf', '18',
        '-movflags', '+faststart',
        outputPath,
      ];

      const proc = spawn(ffmpegPath, args);
      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        // Parse progress
        const match = stderr.match(/frame=\s*(\d+)/);
        if (match) {
          mainWindow?.webContents.send('export-progress', {
            frame: parseInt(match[1]),
          });
        }
      });

      proc.on('close', (code) => {
        if (code === 0) resolve({ ok: true, path: outputPath });
        else reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      });

      proc.on('error', (err) => reject(err));
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Export directly from webm to mp4 (simple re-encode)
ipcMain.handle('simple-export', async (event, options) => {
  const { inputPath, outputPath } = options;

  try {
    let ffmpegPath;
    try {
      ffmpegPath = require('ffmpeg-static');
    } catch {
      ffmpegPath = 'ffmpeg';
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-i', inputPath,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', options.preset || 'ultrafast', // Default to fast for speed
        '-crf', options.crf || '18',
        '-movflags', '+faststart',
        outputPath,
      ];

      const proc = spawn(ffmpegPath, args);
      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) resolve({ ok: true, path: outputPath });
        else reject(new Error(`FFmpeg exited with code ${code}`));
      });

      proc.on('error', (err) => reject(err));
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Save processed frame
ipcMain.handle('save-frame', async (event, { dir, index, dataUrl }) => {
  const buffer = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const framePath = path.join(dir, `frame_${String(index).padStart(6, '0')}.png`);
  fs.writeFileSync(framePath, buffer);
  return framePath;
});

// Clean up temp files
ipcMain.handle('cleanup-temp', async (event, dirPath) => {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// ─── Cursor / Click Tracking ────────────────────────────────────

function startClickTracker(displayBounds) {
  // Use a Python subprocess for reliable global mouse click detection
  const pythonScript = path.join(__dirname, 'helpers', 'cursor_tracker.py');

  if (!fs.existsSync(pythonScript)) {
    console.warn('cursor_tracker.py not found, click detection disabled');
    return;
  }

  try {
    cursorTracker = spawn('python', [pythonScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    cursorTracker.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'click') {
            const t = (Date.now() - recordingStartTime) / 1000;
            const nx = (event.x - (displayBounds?.x || 0)) / (displayBounds?.width || 1920);
            const ny = (event.y - (displayBounds?.y || 0)) / (displayBounds?.height || 1080);
            clickData.push({ t, x: nx, y: ny, button: event.button });
            mainWindow?.webContents.send('click-event', { t, x: nx, y: ny, button: event.button });
          }
        } catch (e) { /* ignore parse errors */ }
      }
    });

    cursorTracker.on('error', (err) => {
      console.warn('Click tracker error:', err.message);
    });
  } catch (err) {
    console.warn('Could not start click tracker:', err.message);
  }
}

function stopCursorTracking() {
  if (cursorInterval) {
    clearInterval(cursorInterval);
    cursorInterval = null;
  }
  if (cursorTracker) {
    try {
      cursorTracker.stdin.write('STOP\n');
      cursorTracker.kill();
    } catch { /* ignore */ }
    cursorTracker = null;
  }
}

// Get FFmpeg path
ipcMain.handle('get-ffmpeg-path', () => {
  try {
    return require('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
});

// Write file
ipcMain.handle('write-file', async (event, { filePath, data }) => {
  fs.writeFileSync(filePath, Buffer.from(data));
  return { ok: true };
});

// Read file  
ipcMain.handle('read-file', async (event, filePath) => {
  return fs.readFileSync(filePath);
});

// Check if file exists
ipcMain.handle('file-exists', async (event, filePath) => {
  return fs.existsSync(filePath);
});

// Open file in explorer
ipcMain.handle('show-in-folder', async (event, filePath) => {
  const { shell } = require('electron');
  shell.showItemInFolder(filePath);
});
