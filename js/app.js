/**
 * ZoomCast — Main Application Controller v5
 * Features: Cutting/splitting, motion blur, cursor anim types,
 *           zoom pan speed, smart cursor follow, quality preview
 */

class ZoomCastApp {
    constructor() {
        this.currentScreen = 'home';
        this.selectedSource = null;
        this.mediaStream = null;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.isRecording = false;
        this.isPaused = false;
        this.recStartTime = 0;
        this.timerInterval = null;

        // Recording data
        this.videoBlob = null;
        this.videoUrl = null;
        this.cursorData = [];
        this.clickData = [];
        this.duration = 0;
        this.segments = [];

        // Cut segments (ranges to remove) — array of { tStart, tEnd }
        this.cuts = [];

        // Editor state
        this.timeline = null;
        this.playhead = 0;
        this.isPlaying = false;
        this.playInterval = null;
        this.cursorStyle = 'style1';

        // Editor mode: 'zoom' | 'cut'
        this.editorMode = 'zoom';

        this._init();
    }

    async _init() {
        this._bindWindowControls();
        this._bindHomeControls();
        this._bindEditorControls();
        this._bindExportControls();
        this._bindAppearanceControls();

        // Preload cursor images
        await ZoomEngine.preloadCursors();

        // Listen for global shortcuts from main
        window.zoomcast.onToggleRecording(() => this._toggleRecording());
        window.zoomcast.onStopRecording(() => { if (this.isRecording) this._stopRecording(); });
        window.zoomcast.onClickEvent((data) => {
            if (this.isRecording) this.clickData.push(data);
        });

        await this._loadSources();
    }

    // ─── Window Controls ─────────────────────────────────────────
    _bindWindowControls() {
        document.getElementById('btn-minimize').onclick = () => window.zoomcast.minimize();
        document.getElementById('btn-maximize').onclick = () => window.zoomcast.maximize();
        document.getElementById('btn-close').onclick = () => window.zoomcast.close();
    }

    // ─── Screen Management ───────────────────────────────────────
    _showScreen(name) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(`${name}-screen`).classList.add('active');
        this.currentScreen = name;
    }

    // ─── Source Loading ──────────────────────────────────────────
    async _loadSources() {
        try {
            const sources = await window.zoomcast.getSources();
            const grid = document.getElementById('source-grid');
            grid.innerHTML = '';

            if (sources.length === 0) {
                grid.innerHTML = '<div class="source-placeholder"><span>No displays found</span></div>';
                return;
            }

            sources.forEach((src, idx) => {
                const card = document.createElement('div');
                card.className = 'source-card' + (idx === 0 ? ' selected' : '');
                card.innerHTML = `
          <img class="source-thumb" src="${src.thumbnail}" alt="${src.name}">
          <div class="source-name">${src.name}</div>
        `;
                card.onclick = () => {
                    grid.querySelectorAll('.source-card').forEach(c => c.classList.remove('selected'));
                    card.classList.add('selected');
                    this.selectedSource = src;
                    document.getElementById('btn-record').disabled = false;
                };
                grid.appendChild(card);

                if (idx === 0) {
                    this.selectedSource = src;
                    document.getElementById('btn-record').disabled = false;
                }
            });
        } catch (err) {
            console.error('Failed to load sources:', err);
        }
    }

    // ─── Home Controls ───────────────────────────────────────────
    _bindHomeControls() {
        document.getElementById('btn-record').onclick = () => this._toggleRecording();
        document.getElementById('btn-pause').onclick = () => this._togglePause();
        document.getElementById('btn-stop').onclick = () => this._stopRecording();
    }

    async _toggleRecording() {
        if (this.isRecording) {
            this._stopRecording();
        } else {
            await this._startRecording();
        }
    }

    async _startRecording() {
        if (!this.selectedSource) return;

        try {
            const displays = await window.zoomcast.getDisplays();
            let display = displays[0];
            let displayIdx = 0;

            if (this.selectedSource?.display_id) {
                const matchedIdx = displays.findIndex(d => String(d.id) === String(this.selectedSource.display_id));
                if (matchedIdx !== -1) {
                    display = displays[matchedIdx];
                    displayIdx = matchedIdx;
                }
            } else if (this.selectedSource?.id) {
                const parts = this.selectedSource.id.split(':');
                const idx = parts.length > 1 ? parseInt(parts[1]) : NaN;
                if (!isNaN(idx) && displays[idx]) {
                    display = displays[idx];
                    displayIdx = idx;
                }
            }

            this.displayBounds = display?.bounds || { x: 0, y: 0, width: 1920, height: 1080 };
            this.displayScaleFactor = display?.scaleFactor || 1;

            this.clickData = [];
            this.recordedChunks = [];

            this.isRecording = true;
            this.isPaused = false;
            this.recStartTime = Date.now();

            this.firstVideoFrameTimestamp = Date.now();
            this.firstCursorSampleTimestamp = null;

            const fpsSetting = parseInt(document.getElementById('fps-select')?.value) || 30;
            this.recordedFps = fpsSetting;

            // Start Native DXGI capture (bypasses Chromium completely)
            this.nativeRecordingResult = await window.zoomcast.startNativeRecording({ displayIdx, fps: fpsSetting });
            const explicitStartTime = this.nativeRecordingResult.readyTime || Date.now();

            const trackResult = await window.zoomcast.startTracking({
                bounds: this.displayBounds,
                scaleFactor: this.displayScaleFactor,
                startTime: explicitStartTime
            });
            this.firstCursorSampleTimestamp = trackResult.startTime || explicitStartTime;

            window.zoomcast.startModal();

        } catch (err) {
            console.error('Failed to start recording:', err);
            alert('Failed to start recording: ' + err.message);
        }
    }

    _togglePause() {
        // Pausing is not supported with background DXGI currently
        alert("Pausing is not supported in DXGI Native Recording mode.");
    }

    async _stopRecording() {
        if (!this.isRecording) return;
        this.isRecording = false;

        if (this.timerInterval) clearInterval(this.timerInterval);

        // Stop Native Recording via Main Process
        await window.zoomcast.stopNativeRecording();

        const trackData = await window.zoomcast.stopTracking();
        this.cursorData = trackData.cursor || [];
        this.clickData = [...this.clickData, ...(trackData.clicks || [])];

        const seen = new Set();
        this.clickData = this.clickData.filter(c => {
            const key = `${c.t.toFixed(2)}_${c.x.toFixed(3)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Once stop tracking signals, actually load the video
        this._onRecordingComplete();
    }

    _updateTimer() {
        if (!this.isRecording) return;
        const elapsed = (Date.now() - this.recStartTime) / 1000;
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = Math.floor(elapsed % 60);
        document.getElementById('rec-timer').textContent =
            `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        document.getElementById('rec-stats').textContent =
            `${this.clickData.length} clicks tracked · ${this.cursorData.length} cursor samples`;
    }

    async _onRecordingComplete() {
        if (!this.nativeRecordingResult || !this.nativeRecordingResult.ok) {
            alert('Failed to save native recording.');
            return;
        }

        // Read resulting temp mp4 file from main process and generate a blob to replay locally
        const buffer = await window.zoomcast.readFile(this.nativeRecordingResult.tempPath);
        this.videoBlob = new Blob([buffer], { type: 'video/mp4' });
        this.videoUrl = URL.createObjectURL(this.videoBlob);

        document.getElementById('recording-overlay').classList.add('hidden');

        // Native DXGI capture has negligible latency vs Chromium WebRTC
        this.captureOffset = 0.0;

        const video = document.getElementById('hidden-video');
        video.src = this.videoUrl;

        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                if (video.duration === Infinity || isNaN(video.duration)) {
                    video.currentTime = 1e10;
                    video.ontimeupdate = () => {
                        video.ontimeupdate = null;
                        video.currentTime = 0;
                        resolve();
                    };
                } else {
                    resolve();
                }
            };
        });

        this.duration = video.duration;
        this.cuts = [];

        if (document.getElementById('auto-zoom-toggle').checked && this.clickData.length > 0) {
            this.segments = ZoomEngine.autoGenerateZooms(this.clickData, this.duration);
        } else {
            this.segments = [];
        }

        this._initEditor();
        this._showScreen('editor');
    }

    // ─── Editor ──────────────────────────────────────────────────
    _bindEditorControls() {
        document.getElementById('btn-back-home').onclick = () => {
            this._stopPlayback();
            this._showScreen('home');
        };
        document.getElementById('btn-add-zoom').onclick = () => this._addZoomAtPlayhead();
        document.getElementById('btn-delete').onclick = () => this._deleteSelected();
        document.getElementById('btn-export').onclick = () => this._goToExport();
        document.getElementById('btn-play').onclick = () => this._togglePlayback();
        document.getElementById('btn-seek-start').onclick = () => this._seek(0);
        document.getElementById('btn-seek-end').onclick = () => this._seek(this.duration);
    }

    _initEditor() {
        const video = document.getElementById('hidden-video');
        const meta = document.getElementById('editor-meta');
        meta.textContent = `${Math.round(this.duration * 30)} frames · ${this.duration.toFixed(1)}s · ${this.segments.length} zooms`;

        this.previewCanvas = document.getElementById('preview-canvas');
        this.previewCtx = this.previewCanvas.getContext('2d', { willReadFrequently: true });

        const tlCanvas = document.getElementById('timeline-canvas');
        this.timeline = new Timeline(tlCanvas, {
            duration: this.duration,
            segments: this.segments,
            cuts: this.cuts,
            onSeek: (t) => this._seek(t),
            onSelectionChange: (seg, clip) => {
                this._onSelectionChange(seg, clip);
            },
            onSegmentChange: (seg) => {
                this._refreshPreview();
                if (seg === this.timeline.selectedSeg) this._onSelectionChange(seg, this.timeline.selectedClip);
            }
        });

        this.timeline.generateThumbnails(video);
        this._seek(0);
    }

    async _seek(t) {
        this.playhead = Math.max(0, Math.min(this.duration, t));
        if (this.timeline) {
            this.timeline.playhead = this.playhead;
            this.timeline.draw();
        }
        const video = document.getElementById('hidden-video');
        if (!video.src) return;
        video.currentTime = this.playhead;
        await new Promise(resolve => {
            const done = () => { video.removeEventListener('seeked', done); resolve(); };
            video.addEventListener('seeked', done);
            setTimeout(done, 500);
        });
        this._drawPreviewFrame(video);
        this._updateTimeDisplay();
    }

    _drawPreviewFrame(video) {
        const canvas = this.previewCanvas;
        if (!canvas || !video || video.readyState < 2) return;

        const wrapper = canvas.parentElement;
        // Use getBoundingClientRect for the actual rendered size (accounts for padding correctly)
        const wRect = wrapper.getBoundingClientRect();
        // Subtract padding (12px top/bottom, 20px left/right as set in CSS)
        const padX = 40; // 20px each side
        const padY = 24; // 12px each side
        const maxW = Math.max(1, wRect.width - padX);
        const maxH = Math.max(1, wRect.height - padY);

        // True source aspect ratio
        const srcW = video.videoWidth || 1920;
        const srcH = video.videoHeight || 1080;
        const aspect = srcW / srcH;

        const config = this._getConfig();
        const padding = config.padding !== undefined ? config.padding : 48;

        const maxVidW = Math.max(1, maxW - padding * 2);
        const maxVidH = Math.max(1, maxH - padding * 2);

        // Fit video area inside mathematically available padded box
        let vidW, vidH;
        if (maxVidW / maxVidH > aspect) {
            vidH = Math.floor(maxVidH);
            vidW = Math.floor(vidH * aspect);
        } else {
            vidW = Math.floor(maxVidW);
            vidH = Math.floor(vidW / aspect);
        }

        let cw = vidW + padding * 2;
        let ch = vidH + padding * 2;

        // Ensure even numbers (better for video codecs)
        cw = cw & ~1 || 2;
        ch = ch & ~1 || 2;

        const dpr = window.devicePixelRatio || 1;
        const needsResize = canvas.width !== cw * dpr || canvas.height !== ch * dpr;
        if (needsResize) {
            canvas.width = cw * dpr;
            canvas.height = ch * dpr;
            canvas.style.width = cw + 'px';
            canvas.style.height = ch + 'px';
        }
        this.previewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // config initialized above
        config.outWidth = cw;
        config.outHeight = ch;
        config.cursorData = document.getElementById('cursor-toggle')?.checked ? this.cursorData : null;
        config.clickData = document.getElementById('click-effects-toggle')?.checked ? this.clickData : null;

        const currentTime = video.currentTime;
        const zoom = ZoomEngine.renderFrame(this.previewCtx, video, currentTime, this.segments, config);

        document.getElementById('zoom-info').textContent = `${zoom.factor.toFixed(1)}×`;
        document.getElementById('current-zoom').textContent = `Zoom: ${zoom.factor.toFixed(2)}×`;
    }

    _updateTimeDisplay() {
        const fmt = (t) => {
            const m = Math.floor(t / 60);
            const s = (t % 60).toFixed(2);
            return `${String(m).padStart(2, '0')}:${s.padStart(5, '0')}`;
        };
        document.getElementById('time-current').textContent = fmt(this.playhead);
        document.getElementById('time-total').textContent = fmt(this.duration);
    }

    _togglePlayback() {
        if (this.isPlaying) {
            this._stopPlayback();
        } else {
            this._startPlayback();
        }
    }

    _startPlayback() {
        this.isPlaying = true;
        const btn = document.getElementById('btn-play');
        btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';

        const video = document.getElementById('hidden-video');
        video.currentTime = this.playhead;
        video.play();

        const drawLoop = () => {
            if (!this.isPlaying) return;
            this.playhead = video.currentTime;
            if (this.playhead >= this.duration) {
                this._stopPlayback();
                return;
            }
            this.timeline.playhead = this.playhead;
            this.timeline.draw();
            this._drawPreviewFrame(video);
            this._updateTimeDisplay();
            requestAnimationFrame(drawLoop);
        };
        requestAnimationFrame(drawLoop);
    }

    _stopPlayback() {
        this.isPlaying = false;
        const video = document.getElementById('hidden-video');
        video.pause();
        const btn = document.getElementById('btn-play');
        btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    }

    // ─── Unified Deletion logic ────────────────────────────────────

    _deleteSelected() {
        if (!this.timeline) return;
        if (this.timeline.selectedSeg) {
            const idx = this.segments.indexOf(this.timeline.selectedSeg);
            if (idx !== -1) this.segments.splice(idx, 1);
            this.timeline.selectedSeg = null;
            this._onSelectionChange(null, this.timeline.selectedClip);
            this.timeline.draw();
            this._refreshPreview();
        } else if (this.timeline.selectedClip) {
            this.timeline.selectedClip.deleted = true;
            this.timeline.selectedClip = null;
            this.timeline._rebuildCutsFromClips();
            this.cuts = this.timeline.cuts;
            this._onSelectionChange(null, null);
            this.timeline.draw();
            this._refreshPreview();
        }
    }

    _addZoomAtPlayhead() {
        const dur = Math.min(2.5, this.duration - this.playhead);
        if (dur < 0.2) return;

        let cx = 0.5, cy = 0.5;
        if (this.cursorData.length > 0) {
            const nearest = this.cursorData.reduce((best, c) =>
                Math.abs(c.t - this.playhead) < Math.abs(best.t - this.playhead) ? c : best
            );
            cx = nearest.x;
            cy = nearest.y;
        }

        const colorIdx = this.segments.length % ZoomEngine.COLORS.length;
        const seg = new ZoomSegment(this.playhead, this.playhead + dur, cx, cy, 2.2, ZoomEngine.COLORS[colorIdx]);
        this.segments.push(seg);
        this.timeline.selectedSeg = seg;
        this.timeline.draw();
        this._onSelectionChange(seg, this.timeline.selectedClip);
        this._refreshPreview();
    }

    _duplicateSelectedZoom() {
        if (!this.timeline?.selectedSeg) return;
        const src = this.timeline.selectedSeg;
        const dur = src.tEnd - src.tStart;
        const newStart = Math.min(src.tEnd + 0.1, this.duration - dur);
        if (newStart < 0) return;

        const colorIdx = this.segments.length % ZoomEngine.COLORS.length;
        const dup = new ZoomSegment(newStart, newStart + dur, src.cx, src.cy, src.factor, ZoomEngine.COLORS[colorIdx]);
        dup.easeIn = src.easeIn;
        dup.easeOut = src.easeOut;
        this.segments.push(dup);
        this.timeline.selectedSeg = dup;
        this.timeline.draw();
        this._onSelectionChange(dup, this.timeline.selectedClip);
        this._refreshPreview();
    }

    _refreshPreview() {
        const video = document.getElementById('hidden-video');
        if (video && video.src) this._drawPreviewFrame(video);
    }

    _onSelectionChange(seg, clip) {
        const container = document.getElementById('segment-props');
        if (!seg && !clip) {
            container.innerHTML = '<p class="no-selection">Click a segment or clip on the timeline to edit</p>';
            document.getElementById('btn-delete').disabled = true;
            return;
        }

        document.getElementById('btn-delete').disabled = false;

        if (clip && !seg) {
            const dur = (clip.end - clip.start).toFixed(2);
            container.innerHTML = `
                <div class="prop-group">
                    <div class="prop-header">Selected Clip</div>
                    <div class="prop-row">
                        <label class="prop-label">Duration</label>
                        <span class="prop-value">${dur}s</span>
                    </div>
                    <div class="prop-row">
                        <label class="prop-label">Start / End</label>
                        <span class="prop-value">${clip.start.toFixed(2)}s - ${clip.end.toFixed(2)}s</span>
                    </div>
                </div>
            `;
            return;
        }

        container.innerHTML = `
      <div class="seg-header">
        <span class="seg-badge" style="background:${seg.color}">×${seg.factor.toFixed(1)}</span>
        <span class="seg-duration">${dur}s</span>
      </div>

      <div class="seg-prop-row">
        <span class="seg-prop-label">Zoom Factor</span>
        <input type="range" class="seg-prop-range" id="seg-factor" min="1.2" max="5" step="0.1" value="${seg.factor}">
        <span class="prop-value" id="seg-factor-val">${seg.factor.toFixed(1)}×</span>
      </div>

      <div class="seg-times-row">
        <div class="seg-time-field">
          <label class="seg-time-label">Start</label>
          <input type="number" class="seg-time-input" id="seg-start" min="0" max="${this.duration}" step="0.05" value="${seg.tStart.toFixed(2)}">
        </div>
        <span class="seg-time-sep">—</span>
        <div class="seg-time-field">
          <label class="seg-time-label">End</label>
          <input type="number" class="seg-time-input" id="seg-end" min="0" max="${this.duration}" step="0.05" value="${seg.tEnd.toFixed(2)}">
        </div>
      </div>

      <div class="seg-prop-row">
        <span class="seg-prop-label">Center X</span>
        <input type="range" class="seg-prop-range" id="seg-cx" min="0" max="1" step="0.01" value="${seg.cx}">
        <span class="prop-value" id="seg-cx-val">${(seg.cx * 100).toFixed(0)}%</span>
      </div>
      <div class="seg-prop-row">
        <span class="seg-prop-label">Center Y</span>
        <input type="range" class="seg-prop-range" id="seg-cy" min="0" max="1" step="0.01" value="${seg.cy}">
        <span class="prop-value" id="seg-cy-val">${(seg.cy * 100).toFixed(0)}%</span>
      </div>

      <div class="seg-prop-row">
        <span class="seg-prop-label">Ease In</span>
        <input type="range" class="seg-prop-range" id="seg-ease-in" min="0" max="1.5" step="0.05" value="${seg.easeIn}">
        <span class="prop-value" id="seg-ease-in-val">${seg.easeIn.toFixed(2)}s</span>
      </div>
      <div class="seg-prop-row">
        <span class="seg-prop-label">Ease Out</span>
        <input type="range" class="seg-prop-range" id="seg-ease-out" min="0" max="1.5" step="0.05" value="${seg.easeOut}">
        <span class="prop-value" id="seg-ease-out-val">${seg.easeOut.toFixed(2)}s</span>
      </div>

      <div class="seg-colors-row">
        <span class="seg-prop-label">Color</span>
        <div class="seg-color-palette" id="seg-color-palette"></div>
      </div>

      <div class="seg-actions">
        <button class="seg-action-btn" id="seg-btn-duplicate" title="Duplicate">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
          Duplicate
        </button>
        <button class="seg-action-btn seg-action-delete" id="seg-btn-delete" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
          Delete
        </button>
      </div>
    `;

        const redraw = () => {
            this.timeline.draw();
            this._refreshPreview();
        };

        const updateHeader = () => {
            const badge = container.querySelector('.seg-badge');
            const durEl = container.querySelector('.seg-duration');
            if (badge) { badge.textContent = `×${seg.factor.toFixed(1)}`; badge.style.background = seg.color; }
            if (durEl) durEl.textContent = (seg.tEnd - seg.tStart).toFixed(2) + 's';
        };

        document.getElementById('seg-factor').oninput = (e) => {
            seg.factor = parseFloat(e.target.value);
            document.getElementById('seg-factor-val').textContent = seg.factor.toFixed(1) + '×';
            updateHeader();
            redraw();
        };
        document.getElementById('seg-start').onchange = (e) => {
            let val = parseFloat(e.target.value);
            val = Math.max(0, Math.min(seg.tEnd - 0.1, val));
            seg.tStart = val;
            e.target.value = val.toFixed(2);
            updateHeader();
            redraw();
        };
        document.getElementById('seg-end').onchange = (e) => {
            let val = parseFloat(e.target.value);
            val = Math.max(seg.tStart + 0.1, Math.min(this.duration, val));
            seg.tEnd = val;
            e.target.value = val.toFixed(2);
            updateHeader();
            redraw();
        };
        document.getElementById('seg-cx').oninput = (e) => {
            seg.cx = parseFloat(e.target.value);
            document.getElementById('seg-cx-val').textContent = (seg.cx * 100).toFixed(0) + '%';
            redraw();
        };
        document.getElementById('seg-cy').oninput = (e) => {
            seg.cy = parseFloat(e.target.value);
            document.getElementById('seg-cy-val').textContent = (seg.cy * 100).toFixed(0) + '%';
            redraw();
        };
        document.getElementById('seg-ease-in').oninput = (e) => {
            seg.easeIn = parseFloat(e.target.value);
            document.getElementById('seg-ease-in-val').textContent = seg.easeIn.toFixed(2) + 's';
            redraw();
        };
        document.getElementById('seg-ease-out').oninput = (e) => {
            seg.easeOut = parseFloat(e.target.value);
            document.getElementById('seg-ease-out-val').textContent = seg.easeOut.toFixed(2) + 's';
            redraw();
        };

        const palette = document.getElementById('seg-color-palette');
        for (const color of ZoomEngine.COLORS) {
            const dot = document.createElement('div');
            dot.className = 'seg-color-dot' + (color === seg.color ? ' selected' : '');
            dot.style.background = color;
            dot.onclick = () => {
                seg.color = color;
                palette.querySelectorAll('.seg-color-dot').forEach(d => d.classList.remove('selected'));
                dot.classList.add('selected');
                updateHeader();
                redraw();
            };
            palette.appendChild(dot);
        }

        document.getElementById('seg-btn-duplicate').onclick = () => this._duplicateSelectedZoom();
        document.getElementById('seg-btn-delete').onclick = () => this._deleteSelectedZoom();
    }

    // ─── Appearance Controls ─────────────────────────────────────
    _bindAppearanceControls() {
        const update = () => {
            const video = document.getElementById('hidden-video');
            if (video && video.src) this._drawPreviewFrame(video);
        };

        const controls = [
            'bg-color', 'bg-color2', 'bg-type', 'shadow-toggle', 'cursor-toggle',
            'click-effects-toggle',
            'screen-motion-blur', 'zoom-motion-blur', 'cursor-motion-blur',
            'follow-cursor', 'auto-zoom-cursor',
        ];
        controls.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', update);
        });

        const bgTypeSelect = document.getElementById('bg-type');
        const bgImageRow = document.getElementById('bg-image-row');
        const bgColor2Row = document.getElementById('bg-color2-row');
        const bgImageUpload = document.getElementById('bg-image-upload');

        if (bgTypeSelect && bgImageRow) {
            bgTypeSelect.addEventListener('change', (e) => {
                const isImg = e.target.value === 'image';
                const isSolid = e.target.value === 'solid';
                bgImageRow.style.display = isImg ? 'flex' : 'none';
                if (bgColor2Row) bgColor2Row.style.display = (isImg || isSolid) ? 'none' : 'flex';
                update();
            });
        }

        if (bgImageUpload) {
            bgImageUpload.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const img = new Image();
                    img.onload = () => {
                        this.bgImageNode = img;
                        update();
                    };
                    img.src = ev.target.result;
                };
                reader.readAsDataURL(file);
            });
        }

        const rangeMap = {
            'padding-slider': 'padding-value',
            'corners-slider': 'corners-value',
            'shadow-slider': 'shadow-value',
            'cursor-size-slider': 'cursor-size-value',
            'cursor-zoom-slider': 'cursor-zoom-value',
        };
        for (const [sliderId, valId] of Object.entries(rangeMap)) {
            const slider = document.getElementById(sliderId);
            if (!slider) continue;
            slider.oninput = () => {
                const suffix = sliderId.includes('cursor-size') ? '×'
                    : sliderId.includes('cursor-zoom') ? '×'
                        : sliderId.includes('shadow') ? '%'
                            : 'px';
                document.getElementById(valId).textContent = slider.value + suffix;
                update();
            };
        }

        // Speed buttons
        ['cursor-speed', 'pan-speed'].forEach(group => {
            document.querySelectorAll(`.speed-btn[data-group="${group}"]`).forEach(btn => {
                btn.onclick = () => {
                    document.querySelectorAll(`.speed-btn[data-group="${group}"]`).forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    update();
                };
            });
        });

        this._initCursorStyleGrid();
    }

    _initCursorStyleGrid() {
        const grid = document.getElementById('cursor-style-grid');
        if (!grid) return;
        grid.innerHTML = '';

        for (const [key, info] of Object.entries(ZoomEngine.CURSOR_STYLES)) {
            const card = document.createElement('div');
            card.className = 'cursor-style-card' + (key === this.cursorStyle ? ' selected' : '');
            card.dataset.style = key;

            const canvas = document.createElement('canvas');
            canvas.width = 120;
            canvas.height = 36;
            ZoomEngine.drawCursorPreview(canvas, key);

            const label = document.createElement('span');
            label.className = 'cursor-style-label';
            label.textContent = info.label;

            card.appendChild(canvas);
            card.appendChild(label);

            card.addEventListener('click', () => {
                this.cursorStyle = key;
                grid.querySelectorAll('.cursor-style-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                const video = document.getElementById('hidden-video');
                if (video && video.src) this._drawPreviewFrame(video);
            });

            grid.appendChild(card);
        }
    }

    _getSpeedValue(group) {
        const active = document.querySelector(`.speed-btn[data-group="${group}"].active`);
        return active ? active.dataset.speed : 'medium';
    }

    _getConfig() {
        return {
            padding: parseInt(document.getElementById('padding-slider')?.value || 48),
            corners: parseInt(document.getElementById('corners-slider')?.value || 16),
            shadow: document.getElementById('shadow-toggle')?.checked ?? true,
            shadowIntensity: parseInt(document.getElementById('shadow-slider')?.value || 60),
            bgColor: document.getElementById('bg-color')?.value || '#1a1a1a',
            bgColor2: document.getElementById('bg-color2')?.value || '#111111',
            bgType: document.getElementById('bg-type')?.value || 'gradient',
            bgImage: this.bgImageNode || null,
            cursorSize: parseFloat(document.getElementById('cursor-size-slider')?.value || 1.2),
            cursorStyle: this.cursorStyle || 'style1',
            clickEffects: document.getElementById('click-effects-toggle')?.checked ?? true,
            // Motion blur
            screenMotionBlur: document.getElementById('screen-motion-blur')?.checked ?? false,
            zoomMotionBlur: document.getElementById('zoom-motion-blur')?.checked ?? false,
            cursorMotionBlur: document.getElementById('cursor-motion-blur')?.checked ?? false,
            // Cursor follow
            followCursor: document.getElementById('follow-cursor')?.checked ?? true,
            autoZoomOnCursor: document.getElementById('auto-zoom-cursor')?.checked ?? false,
            cursorZoomFactor: parseFloat(document.getElementById('cursor-zoom-slider')?.value || 2.0),
            // Speed
            cursorSpeed: this._getSpeedValue('cursor-speed'),
            panSpeed: this._getSpeedValue('pan-speed'),
            captureOffset: this.captureOffset || 0,
        };
    }

    // ─── Export ──────────────────────────────────────────────────
    _bindExportControls() {
        document.getElementById('btn-back-editor').onclick = () => this._showScreen('editor');
        document.getElementById('btn-browse').onclick = () => this._browseExportPath();
        document.getElementById('btn-start-export').onclick = () => this._startExport();
    }

    _goToExport() {
        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        document.getElementById('export-path').value = `zoomcast_${ts}.mp4`;

        const meta = document.getElementById('export-meta');
        meta.innerHTML = `
      <span class="meta-chip">📹 ${this.duration.toFixed(1)}s</span>
      <span class="meta-chip">🎞️ ~${Math.round(this.duration * (this.recordedFps || 30))} frames</span>
      <span class="meta-chip">🔍 ${this.segments.length} zoom segments</span>
      <span class="meta-chip">✂️ ${this.cuts.length} cuts</span>
      <span class="meta-chip">🖱️ ${this.clickData.length} clicks</span>
    `;

        document.querySelector('.export-card').classList.remove('hidden');
        document.getElementById('export-progress-section').classList.add('hidden');
        document.getElementById('export-complete').classList.add('hidden');

        this._stopPlayback();
        this._showScreen('export');
    }

    async _browseExportPath() {
        const result = await window.zoomcast.showSaveDialog({});
        if (!result.canceled && result.filePath) {
            document.getElementById('export-path').value = result.filePath;
        }
    }

    async _startExport() {
        const btn = document.getElementById('btn-start-export');
        btn.disabled = true;
        btn.textContent = 'Rendering...';

        const fill = document.getElementById('progress-fill');
        const text = document.getElementById('progress-text');
        const pct = document.getElementById('progress-percent');
        document.getElementById('export-progress-section').classList.remove('hidden');

        try {
            let outputPath = document.getElementById('export-path').value;
            const result = await window.zoomcast.showSaveDialog({ defaultPath: outputPath });
            if (result.canceled) {
                btn.disabled = false;
                btn.textContent = 'Render & Export';
                return;
            }
            outputPath = result.filePath;

            fill.style.width = '3%';
            text.textContent = 'Starting FFmpeg...';
            pct.textContent = '3%';

            const video = document.getElementById('hidden-video');
            const config = this._getConfig();
            const padding = config.padding !== undefined ? config.padding : 48;

            const srcW = video.videoWidth || 1920;
            const srcH = video.videoHeight || 1080;

            const fps = this.recordedFps || 30;

            // Add padding * 2 to the true raw video dimensions so the inner video area is untouched
            const vw = (srcW + padding * 2) & ~1 || 2;
            const vh = (srcH + padding * 2) & ~1 || 2;
            // Build list of frame timestamps (excluding cut zones)
            const allFrames = [];
            const totalRawFrames = Math.ceil(this.duration * fps);
            for (let fi = 0; fi < totalRawFrames; fi++) {
                const t = fi / fps;
                // Check if this time falls within a cut zone
                const inCut = this.cuts.some(c => t >= c.tStart && t <= c.tEnd);
                if (!inCut) allFrames.push(t);
            }
            const totalFrames = allFrames.length;

            const exportCanvas = document.createElement('canvas');
            exportCanvas.width = vw;
            exportCanvas.height = vh;
            const exportCtx = exportCanvas.getContext('2d', { willReadFrequently: true });
            exportCtx.imageSmoothingEnabled = true;
            config.outWidth = vw;
            config.outHeight = vh;
            config.cursorData = this.cursorData;
            config.clickData = this.clickData;

            const streamStart = await window.zoomcast.startFFmpegStream({
                outputPath,
                width: vw,
                height: vh,
                fps,
            });

            if (!streamStart.ok) {
                throw new Error('Failed to start FFmpeg: ' + (streamStart.error || 'unknown error'));
            }

            fill.style.width = '5%';
            pct.textContent = '5%';

            const startTs = Date.now();

            for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
                const t = allFrames[frameIdx];

                video.currentTime = t;
                await new Promise(r => {
                    const done = () => { video.removeEventListener('seeked', done); r(); };
                    video.addEventListener('seeked', done);
                    setTimeout(done, 200);
                });

                ZoomEngine.renderFrame(exportCtx, video, t, this.segments, config);

                const imageData = exportCtx.getImageData(0, 0, vw, vh);
                const writeResult = await window.zoomcast.writeFrame(imageData.data.buffer);
                if (writeResult && !writeResult.ok) {
                    throw new Error('FFmpeg pipe write failed: ' + writeResult.error);
                }

                const done = frameIdx + 1;
                const percent = Math.round((done / totalFrames) * 90) + 5;
                const elapsed = (Date.now() - startTs) / 1000;
                const rate = done / elapsed;
                const remaining = Math.max(0, (totalFrames - done) / rate);
                const etaMin = Math.floor(remaining / 60);
                const etaSec = Math.ceil(remaining % 60);
                const etaStr = etaMin > 0 ? `${etaMin}m ${etaSec}s` : `${etaSec}s`;

                fill.style.width = percent + '%';
                pct.textContent = percent + '%';
                text.textContent = `Encoding frame ${done}/${totalFrames} · ${rate.toFixed(1)} fps · ETA ${etaStr}`;

                if (done % 5 === 0) await new Promise(r => setTimeout(r, 0));
            }

            fill.style.width = '96%';
            pct.textContent = '96%';
            text.textContent = 'Finalising video...';

            const endResult = await window.zoomcast.endFFmpegStream();
            if (!endResult.ok) {
                throw new Error('FFmpeg encoding failed: ' + endResult.error);
            }

            fill.style.width = '100%';
            pct.textContent = '100%';
            text.textContent = 'Complete!';

            document.getElementById('export-complete').classList.remove('hidden');
            document.querySelector('.export-card').classList.add('hidden');
            document.getElementById('export-complete-path').textContent = outputPath;
            document.getElementById('btn-open-folder').onclick = () => window.zoomcast.showInFolder(outputPath);
            document.getElementById('btn-new-recording').onclick = () => {
                this._showScreen('home');
                this.segments = [];
                this.cuts = [];
            };

        } catch (err) {
            try { await window.zoomcast.endFFmpegStream(); } catch (_) { /* ignore */ }
            fill.style.width = '0%';
            text.textContent = 'Export failed: ' + err.message;
            pct.textContent = '';
            console.error('[Export]', err);
        }

        btn.disabled = false;
        btn.textContent = 'Render & Export';
    }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
    window.app = new ZoomCastApp();
});
