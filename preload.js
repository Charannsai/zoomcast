/**
 * ZoomCast — Preload Script
 * Securely exposes main process APIs to the renderer via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zoomcast', {
    // Window controls
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    hide: () => ipcRenderer.send('window-hide'),
    show: () => ipcRenderer.send('window-show'),
    setOpacity: (opacity) => ipcRenderer.send('window-opacity', opacity),

    // Screen sources
    getSources: () => ipcRenderer.invoke('get-sources'),
    getDisplays: () => ipcRenderer.invoke('get-displays'),

    // Recording
    startTracking: (displayBounds) => ipcRenderer.invoke('start-tracking', displayBounds),
    stopTracking: () => ipcRenderer.invoke('stop-tracking'),
    startModal: () => ipcRenderer.send('start-modal'),
    triggerStop: () => ipcRenderer.send('trigger-stop-recording'),

    // File operations
    startNativeRecording: (options) => ipcRenderer.invoke('start-native-recording', options),
    stopNativeRecording: () => ipcRenderer.invoke('stop-native-recording'),
    showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
    saveTempVideo: (buffer) => ipcRenderer.invoke('save-temp-video', buffer),
    getTempDir: () => ipcRenderer.invoke('get-temp-dir'),
    saveFrame: (data) => ipcRenderer.invoke('save-frame', data),
    writeFile: (data) => ipcRenderer.invoke('write-file', data),
    readFile: (path) => ipcRenderer.invoke('read-file', path),
    fileExists: (path) => ipcRenderer.invoke('file-exists', path),
    cleanupTemp: (dir) => ipcRenderer.invoke('cleanup-temp', dir),
    showInFolder: (path) => ipcRenderer.invoke('show-in-folder', path),

    // Export
    exportVideo: (options) => ipcRenderer.invoke('export-video', options),
    simpleExport: (options) => ipcRenderer.invoke('simple-export', options),
    getFFmpegPath: () => ipcRenderer.invoke('get-ffmpeg-path'),

    // Raw-frame streaming pipeline (Canvas → FFmpeg stdin, no PNG files)
    startFFmpegStream: (options) => ipcRenderer.invoke('start-ffmpeg-stream', options),
    writeFrame: (data) => ipcRenderer.invoke('write-frame', data),
    endFFmpegStream: () => ipcRenderer.invoke('end-ffmpeg-stream'),

    // Events from main
    onToggleRecording: (cb) => ipcRenderer.on('toggle-recording', cb),
    onStopRecording: (cb) => ipcRenderer.on('stop-recording', cb),
    onClickEvent: (cb) => ipcRenderer.on('click-event', (_, data) => cb(data)),
    onExportProgress: (cb) => ipcRenderer.on('export-progress', (_, data) => cb(data)),

    // Remove listeners
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
