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

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-direct-composition');
app.commandLine.appendSwitch('disable-features', 'UseSkiaRenderer');

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
  hideCursorHideOverlay();
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
ipcMain.handle('start-tracking', (event, payload) => {
  cursorData = [];
  clickData = [];
  recordingStartTime = Date.now();
  isRecording = true;

  // payload can be { bounds, scaleFactor } (new) or plain bounds object (legacy)
  const displayBounds = payload?.bounds ?? payload;
  const scaleFactor = payload?.scaleFactor ?? 1;

  const bx = displayBounds?.x || 0;
  const by = displayBounds?.y || 0;
  const bw = displayBounds?.width || 1920;
  const bh = displayBounds?.height || 1080;

  // On Windows, getCursorScreenPoint() returns LOGICAL pixels,
  // matching display.bounds. Divide by logical width/height to get [0,1].
  const sw = bw;
  const sh = bh;

  // Poll cursor position at 120Hz for ultra-smooth, accurate tracking
  cursorInterval = setInterval(() => {
    if (!isRecording) return;
    const point = screen.getCursorScreenPoint();
    const t = (Date.now() - recordingStartTime) / 1000;

    // Normalize to [0, 1] within the recording display
    const nx = (point.x - bx) / sw;
    const ny = (point.y - by) / sh;

    // Skip if cursor is outside of this display (can happen on multi-monitor setups)
    if (nx < -0.05 || nx > 1.05 || ny < -0.05 || ny > 1.05) return;

    // Clamp to [0, 1]
    const cx = Math.max(0, Math.min(1, nx));
    const cy = Math.max(0, Math.min(1, ny));

    cursorData.push({ t, x: cx, y: cy, rx: point.x, ry: point.y });
  }, 8); // 120fps tracking for accurate cursor path
  // Start Python click tracker
  startClickTracker(displayBounds);

  return { ok: true, startTime: recordingStartTime };
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

// ─── Native DXGI Recording Stream ────────────────────────────────────────────
let dxgiCaptureProc = null;

ipcMain.handle('start-native-recording', async (event, options) => {
  const displayIdx = options?.displayIdx || 0;
  const tmpDir = path.join(app.getPath('temp'), 'zoomcast');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  // write to mp4, python uses libx264
  const outPath = path.join(tmpDir, `recording_${Date.now()}.mp4`);

  let ffmpegPath;
  try { ffmpegPath = require('ffmpeg-static'); }
  catch { ffmpegPath = 'ffmpeg'; }

  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'helpers', 'dxgi_capture.py');
    dxgiCaptureProc = spawn('python', [scriptPath, outPath, ffmpegPath, String(displayIdx)], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    dxgiCaptureProc.stdout.on('data', (d) => {
      const msg = d.toString();
      if (msg.includes('READY')) {
        resolve({ ok: true, tempPath: outPath });
      }
    });

    dxgiCaptureProc.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
  });
});

ipcMain.handle('stop-native-recording', async () => {
  if (!dxgiCaptureProc) return { ok: false };

  return new Promise((resolve) => {
    dxgiCaptureProc.on('close', () => {
      dxgiCaptureProc = null;
      resolve({ ok: true });
    });

    try {
      dxgiCaptureProc.stdin.write('STOP\n');
      dxgiCaptureProc.stdin.end();
    } catch {
      dxgiCaptureProc.kill();
    }
  });
});

// ─── Raw-frame streaming export ────────────────────────────────────────────
// Holds the active FFmpeg process during a streaming export session
let ffmpegStreamProc = null;
let ffmpegStreamResolve = null;
let ffmpegStreamReject = null;

/**
 * Start FFmpeg in stdin-pipe mode.
 * options: { outputPath, width, height, fps }
 */
ipcMain.handle('start-ffmpeg-stream', async (event, options) => {
  const { outputPath, width, height, fps = 30 } = options;

  let ffmpegPath;
  try { ffmpegPath = require('ffmpeg-static'); }
  catch { ffmpegPath = 'ffmpeg'; }

  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', '-',           // read from stdin
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    try {
      ffmpegStreamProc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return reject({ ok: false, error: err.message });
    }

    let stderr = '';
    ffmpegStreamProc.stderr.on('data', (data) => {
      stderr += data.toString();
      // Forward frame progress to renderer
      const match = stderr.match(/frame=\s*(\d+)/);
      if (match) {
        mainWindow?.webContents.send('export-progress', { frame: parseInt(match[1]) });
      }
    });

    // Store promise hooks so end-ffmpeg-stream can await completion
    ffmpegStreamResolve = resolve;
    ffmpegStreamReject = reject;

    ffmpegStreamProc.on('error', (err) => {
      ffmpegStreamProc = null;
      reject({ ok: false, error: err.message });
    });

    // We signal "started" immediately; the renderer begins piping frames.
    // The real resolve/reject will fire when stdin is closed (end-ffmpeg-stream).
    // But we need to return something now, so resolve with { ok: true, started: true }.
    // Overwrite ffmpegStreamResolve so end-ffmpeg-stream resolves the caller of
    // start-ffmpeg-stream is NOT the right pattern — instead let's just resolve now
    // and have end-ffmpeg-stream return its own promise.
    ffmpegStreamResolve = null;
    ffmpegStreamReject = null;
    resolve({ ok: true });
  });
});

/**
 * Write a raw RGBA frame buffer to FFmpeg stdin.
 * data: ArrayBuffer (Uint8Array) of raw RGBA pixels
 */
ipcMain.handle('write-frame', async (event, data) => {
  if (!ffmpegStreamProc || !ffmpegStreamProc.stdin.writable) {
    return { ok: false, error: 'No active FFmpeg stream' };
  }
  try {
    const buf = Buffer.from(data);
    const canWrite = ffmpegStreamProc.stdin.write(buf);
    // Backpressure: wait for drain if the buffer is full
    if (!canWrite) {
      await new Promise(resolve => ffmpegStreamProc.stdin.once('drain', resolve));
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Close FFmpeg stdin and wait for the process to finish encoding.
 */
ipcMain.handle('end-ffmpeg-stream', async () => {
  if (!ffmpegStreamProc) return { ok: false, error: 'No active FFmpeg stream' };

  return new Promise((resolve) => {
    let stderr = '';
    // Collect any remaining stderr (already streamed above, just for error reporting)
    ffmpegStreamProc.stderr.on('data', (d) => { stderr += d.toString(); });

    ffmpegStreamProc.on('close', (code) => {
      ffmpegStreamProc = null;
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `FFmpeg exited with code ${code}\n${stderr.slice(-800)}` });
    });

    try {
      ffmpegStreamProc.stdin.end();
    } catch (err) {
      ffmpegStreamProc = null;
      resolve({ ok: false, error: err.message });
    }
  });
});

// Legacy export-video (kept for reference / fallback, not used in new pipeline)
ipcMain.handle('export-video', async (event, options) => {
  return { ok: false, error: 'export-video is deprecated; use start-ffmpeg-stream / write-frame / end-ffmpeg-stream' };
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

// save-frame is no longer used (raw streaming pipeline replaced PNG frames)
// Kept as a no-op stub so any old callers don't crash.
ipcMain.handle('save-frame', async () => ({ ok: false, error: 'save-frame is deprecated' }));

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
