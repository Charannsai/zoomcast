/**
 * ZoomCast — Main Application Controller
 * Manages screens, recording, editing, and export orchestration.
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

        // Editor state
        this.timeline = null;
        this.playhead = 0;
        this.isPlaying = false;
        this.playInterval = null;
        this.cursorStyle = 'macos-white';

        this._init();
    }

    async _init() {
        this._bindWindowControls();
        this._bindHomeControls();
        this._bindEditorControls();
        this._bindExportControls();
        this._bindAppearanceControls();

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
            // Get media stream — no min/maxFrameRate constraints
            // (restrictive FPS constraints freeze the capture pipeline on many GPUs)
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: this.selectedSource.id,
                    }
                }
            });

            // Get display info for cursor normalization
            const displays = await window.zoomcast.getDisplays();
            const display = displays[0];
            this.displayBounds = display?.bounds || { x: 0, y: 0, width: 1920, height: 1080 };

            // Setup MediaRecorder
            const quality = document.getElementById('quality-select').value;
            const bitrate = quality === 'ultra' ? 12000000 : quality === 'high' ? 8000000 : 4000000;

            this.recordedChunks = [];
            this.clickData = [];

            // Use VP8 — VP9 real-time encoding is far too CPU-heavy and causes
            // frame freezes / dropped frames during recording
            this.mediaRecorder = new MediaRecorder(this.mediaStream, {
                mimeType: 'video/webm;codecs=vp8',
                videoBitsPerSecond: bitrate,
            });

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.recordedChunks.push(e.data);
            };

            this.mediaRecorder.onstop = () => this._onRecordingComplete();

            // Start
            this.mediaRecorder.start(1000); // collect every 1s (less overhead than 100ms)
            this.isRecording = true;
            this.isPaused = false;
            this.recStartTime = Date.now();

            // Start cursor tracking in main process
            await window.zoomcast.startTracking(this.displayBounds);

            // Show recording overlay
            document.getElementById('recording-overlay').classList.remove('hidden');

            // Start timer
            this.timerInterval = setInterval(() => this._updateTimer(), 50);

        } catch (err) {
            console.error('Failed to start recording:', err);
            alert('Failed to start recording: ' + err.message);
        }
    }

    _togglePause() {
        if (!this.mediaRecorder) return;
        const btn = document.getElementById('btn-pause');

        if (this.isPaused) {
            this.mediaRecorder.resume();
            this.isPaused = false;
            btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>Pause`;
        } else {
            this.mediaRecorder.pause();
            this.isPaused = true;
            btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>Resume`;
        }
    }

    async _stopRecording() {
        if (!this.isRecording) return;
        this.isRecording = false;

        if (this.timerInterval) clearInterval(this.timerInterval);

        // Stop MediaRecorder
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }

        // Stop media stream
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(t => t.stop());
        }

        // Stop cursor tracking and get data
        const trackData = await window.zoomcast.stopTracking();
        this.cursorData = trackData.cursor || [];
        this.clickData = [...this.clickData, ...(trackData.clicks || [])];

        // Remove duplicate clicks
        const seen = new Set();
        this.clickData = this.clickData.filter(c => {
            const key = `${c.t.toFixed(2)}_${c.x.toFixed(3)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
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
        this.videoBlob = new Blob(this.recordedChunks, { type: 'video/webm' });
        this.videoUrl = URL.createObjectURL(this.videoBlob);

        // Hide recording overlay
        document.getElementById('recording-overlay').classList.add('hidden');

        // Load video to get duration
        const video = document.getElementById('hidden-video');
        video.src = this.videoUrl;

        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                // WebM duration fix
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

        // Auto-generate zoom segments if enabled
        if (document.getElementById('auto-zoom-toggle').checked && this.clickData.length > 0) {
            this.segments = ZoomEngine.autoGenerateZooms(this.clickData, this.duration);
        } else {
            this.segments = [];
        }

        // Switch to editor
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
        document.getElementById('btn-delete-zoom').onclick = () => this._deleteSelectedZoom();
        document.getElementById('btn-export').onclick = () => this._goToExport();
        document.getElementById('btn-play').onclick = () => this._togglePlayback();
        document.getElementById('btn-seek-start').onclick = () => this._seek(0);
        document.getElementById('btn-seek-end').onclick = () => this._seek(this.duration);
    }

    _initEditor() {
        const video = document.getElementById('hidden-video');
        const meta = document.getElementById('editor-meta');
        meta.textContent = `${Math.round(this.duration * 30)} frames · ${this.duration.toFixed(1)}s · ${this.segments.length} zooms`;

        // Setup preview canvas
        this.previewCanvas = document.getElementById('preview-canvas');
        this.previewCtx = this.previewCanvas.getContext('2d');

        // Setup timeline
        const tlCanvas = document.getElementById('timeline-canvas');
        this.timeline = new Timeline(tlCanvas, {
            duration: this.duration,
            segments: this.segments,
            onSeek: (t) => this._seek(t),
            onSegmentSelect: (seg) => this._onSegmentSelect(seg),
            onSegmentChange: (seg) => {
                this._refreshPreview();
                // Update segment props panel if the changed segment is selected
                if (seg === this.timeline.selectedSeg) this._onSegmentSelect(seg);
            },
        });

        // Generate thumbnails (async, non-blocking)
        this.timeline.generateThumbnails(video);

        // Initial preview
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
            setTimeout(done, 500); // fallback
        });
        this._drawPreviewFrame(video);
        this._updateTimeDisplay();
    }

    _drawPreviewFrame(video) {
        const canvas = this.previewCanvas;
        if (!canvas || !video || video.readyState < 2) return;

        const wrapper = canvas.parentElement;
        const ww = wrapper.clientWidth;
        const wh = wrapper.clientHeight;
        if (ww < 10 || wh < 10) return;

        const aspect = (video.videoWidth || 1920) / (video.videoHeight || 1080);
        let cw, ch;
        if (ww / wh > aspect) { ch = wh; cw = Math.round(ch * aspect); }
        else { cw = ww; ch = Math.round(cw / aspect); }

        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
            canvas.width = cw * dpr;
            canvas.height = ch * dpr;
            canvas.style.width = cw + 'px';
            canvas.style.height = ch + 'px';
        }
        this.previewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const config = this._getConfig();
        config.outWidth = cw;
        config.outHeight = ch;
        // Cursor overlay is OFF by default (system cursor is already in the recording)
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

    _addZoomAtPlayhead() {
        const dur = Math.min(2.5, this.duration - this.playhead);
        if (dur < 0.2) return;

        // Find cursor position near playhead
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
        this._onSegmentSelect(seg);
        this._refreshPreview();
    }

    _deleteSelectedZoom() {
        if (!this.timeline?.selectedSeg) return;
        const idx = this.segments.indexOf(this.timeline.selectedSeg);
        if (idx !== -1) this.segments.splice(idx, 1);
        this.timeline.selectedSeg = null;
        this._onSegmentSelect(null);
        this.timeline.draw();
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
        this._onSegmentSelect(dup);
        this._refreshPreview();
    }

    /**
     * Helper to refresh the preview at the current playhead
     */
    _refreshPreview() {
        const video = document.getElementById('hidden-video');
        if (video && video.src) this._drawPreviewFrame(video);
    }

    _onSegmentSelect(seg) {
        const container = document.getElementById('segment-props');
        if (!seg) {
            container.innerHTML = '<p class="no-selection">Click a segment on the timeline to edit</p>';
            return;
        }

        const dur = (seg.tEnd - seg.tStart).toFixed(2);

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

        // Zoom factor
        document.getElementById('seg-factor').oninput = (e) => {
            seg.factor = parseFloat(e.target.value);
            document.getElementById('seg-factor-val').textContent = seg.factor.toFixed(1) + '×';
            updateHeader();
            redraw();
        };

        // Start time
        document.getElementById('seg-start').onchange = (e) => {
            let val = parseFloat(e.target.value);
            val = Math.max(0, Math.min(seg.tEnd - 0.1, val));
            seg.tStart = val;
            e.target.value = val.toFixed(2);
            updateHeader();
            redraw();
        };

        // End time
        document.getElementById('seg-end').onchange = (e) => {
            let val = parseFloat(e.target.value);
            val = Math.max(seg.tStart + 0.1, Math.min(this.duration, val));
            seg.tEnd = val;
            e.target.value = val.toFixed(2);
            updateHeader();
            redraw();
        };

        // Center X
        document.getElementById('seg-cx').oninput = (e) => {
            seg.cx = parseFloat(e.target.value);
            document.getElementById('seg-cx-val').textContent = (seg.cx * 100).toFixed(0) + '%';
            redraw();
        };

        // Center Y
        document.getElementById('seg-cy').oninput = (e) => {
            seg.cy = parseFloat(e.target.value);
            document.getElementById('seg-cy-val').textContent = (seg.cy * 100).toFixed(0) + '%';
            redraw();
        };

        // Ease In
        document.getElementById('seg-ease-in').oninput = (e) => {
            seg.easeIn = parseFloat(e.target.value);
            document.getElementById('seg-ease-in-val').textContent = seg.easeIn.toFixed(2) + 's';
            redraw();
        };

        // Ease Out
        document.getElementById('seg-ease-out').oninput = (e) => {
            seg.easeOut = parseFloat(e.target.value);
            document.getElementById('seg-ease-out-val').textContent = seg.easeOut.toFixed(2) + 's';
            redraw();
        };

        // Color palette
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

        // Action buttons
        document.getElementById('seg-btn-duplicate').onclick = () => this._duplicateSelectedZoom();
        document.getElementById('seg-btn-delete').onclick = () => this._deleteSelectedZoom();
    }

    // ─── Appearance Controls ─────────────────────────────────────
    _bindAppearanceControls() {
        const update = () => {
            const video = document.getElementById('hidden-video');
            if (video && video.src) this._drawPreviewFrame(video);
        };
        const controls = ['bg-color', 'bg-color2', 'bg-type', 'shadow-toggle', 'cursor-toggle', 'click-effects-toggle'];
        controls.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', update);
        });

        const rangeMap = {
            'padding-slider': 'padding-value',
            'corners-slider': 'corners-value',
            'shadow-slider': 'shadow-value',
            'cursor-size-slider': 'cursor-size-value',
        };
        for (const [sliderId, valId] of Object.entries(rangeMap)) {
            const slider = document.getElementById(sliderId);
            if (!slider) continue;
            slider.oninput = () => {
                const suffix = sliderId.includes('cursor') ? '×' : sliderId.includes('shadow') ? '%' : 'px';
                document.getElementById(valId).textContent = slider.value + suffix;
                update();
            };
        }

        // Populate cursor style grid
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
                // Refresh preview
                const video = document.getElementById('hidden-video');
                if (video && video.src) this._drawPreviewFrame(video);
            });

            grid.appendChild(card);
        }
    }

    _getConfig() {
        return {
            padding: parseInt(document.getElementById('padding-slider')?.value || 48),
            corners: parseInt(document.getElementById('corners-slider')?.value || 16),
            shadow: document.getElementById('shadow-toggle')?.checked ?? true,
            shadowIntensity: parseInt(document.getElementById('shadow-slider')?.value || 60),
            bgColor: document.getElementById('bg-color')?.value || '#13161c',
            bgColor2: document.getElementById('bg-color2')?.value || '#1e222b',
            bgType: document.getElementById('bg-type')?.value || 'gradient',
            cursorSize: parseFloat(document.getElementById('cursor-size-slider')?.value || 1.2),
            cursorStyle: this.cursorStyle || 'macos-white',
            clickEffects: document.getElementById('click-effects-toggle')?.checked ?? true,
        };
    }

    // ─── Export ──────────────────────────────────────────────────
    _bindExportControls() {
        document.getElementById('btn-back-editor').onclick = () => this._showScreen('editor');
        document.getElementById('btn-browse').onclick = () => this._browseExportPath();
        document.getElementById('btn-start-export').onclick = () => this._startExport();
    }

    _goToExport() {
        // Set default path
        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        document.getElementById('export-path').value = `zoomcast_${ts}.mp4`;

        // Set meta
        const meta = document.getElementById('export-meta');
        meta.innerHTML = `
      <span class="meta-chip">📹 ${this.duration.toFixed(1)}s</span>
      <span class="meta-chip">🎞️ ~${Math.round(this.duration * 30)} frames</span>
      <span class="meta-chip">🔍 ${this.segments.length} zoom segments</span>
      <span class="meta-chip">🖱️ ${this.clickData.length} clicks</span>
    `;

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
            // Ask for save location
            let outputPath = document.getElementById('export-path').value;
            const result = await window.zoomcast.showSaveDialog({ defaultPath: outputPath });
            if (result.canceled) {
                btn.disabled = false;
                btn.textContent = 'Render & Export';
                return;
            }
            outputPath = result.filePath;

            fill.style.width = '5%';
            text.textContent = 'Preparing renderer...';
            pct.textContent = '5%';

            // ── Phase 1: Render video with all effects using canvas MediaRecorder ──
            const video = document.getElementById('hidden-video');
            const vw = video.videoWidth || 1920;
            const vh = video.videoHeight || 1080;

            // Export canvas at original video resolution for full clarity
            const exportCanvas = document.createElement('canvas');
            exportCanvas.width = vw;
            exportCanvas.height = vh;
            const exportCtx = exportCanvas.getContext('2d');

            // Build config for rendering at full resolution
            const config = this._getConfig();
            config.outWidth = vw;
            config.outHeight = vh;
            config.cursorData = this.cursorData;
            config.clickData = this.clickData;

            // Setup canvas MediaRecorder
            const stream = exportCanvas.captureStream(0); // manual frame push
            const recorderMime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
                ? 'video/webm;codecs=vp8' : 'video/webm';
            const mediaRec = new MediaRecorder(stream, {
                mimeType: recorderMime,
                videoBitsPerSecond: 15000000, // 15 Mbps for high quality
            });

            const chunks = [];
            mediaRec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

            const renderedBlob = await new Promise((resolve, reject) => {
                mediaRec.onstop = () => {
                    resolve(new Blob(chunks, { type: 'video/webm' }));
                };
                mediaRec.onerror = (e) => reject(e.error || new Error('MediaRecorder error'));
                mediaRec.start(500);

                const videoTrack = stream.getVideoTracks()[0];
                const fps = 30;
                const totalFrames = Math.ceil(this.duration * fps);
                let frameIdx = 0;
                const startTs = Date.now();

                const renderNextFrame = async () => {
                    if (frameIdx >= totalFrames) {
                        video.pause();
                        // Small delay to flush last frames
                        setTimeout(() => mediaRec.stop(), 200);
                        return;
                    }

                    const t = frameIdx / fps;
                    video.currentTime = t;

                    await new Promise(r => {
                        const done = () => { video.removeEventListener('seeked', done); r(); };
                        video.addEventListener('seeked', done);
                        setTimeout(done, 300);
                    });

                    // Render frame with all effects
                    ZoomEngine.renderFrame(exportCtx, video, t, this.segments, config);

                    // Push frame to recorder
                    if (videoTrack.requestFrame) videoTrack.requestFrame();

                    frameIdx++;

                    // Update progress with ETA
                    const percent = Math.round((frameIdx / totalFrames) * 90) + 5;
                    const elapsed = (Date.now() - startTs) / 1000;
                    const rate = frameIdx / elapsed;
                    const remaining = Math.max(0, (totalFrames - frameIdx) / rate);
                    const etaMin = Math.floor(remaining / 60);
                    const etaSec = Math.ceil(remaining % 60);
                    const etaStr = etaMin > 0 ? `${etaMin}m ${etaSec}s` : `${etaSec}s`;

                    fill.style.width = percent + '%';
                    pct.textContent = percent + '%';
                    text.textContent = `Rendering frame ${frameIdx}/${totalFrames} · ${rate.toFixed(1)} fps · ETA ${etaStr}`;

                    // Small delay so UI can update
                    await new Promise(r => setTimeout(r, 5));
                    renderNextFrame();
                };

                renderNextFrame();
            });

            // ── Phase 2: Save or convert ──
            fill.style.width = '95%';
            pct.textContent = '95%';

            const renderedBuffer = await renderedBlob.arrayBuffer();

            if (outputPath.endsWith('.webm')) {
                text.textContent = 'Writing WebM...';
                await window.zoomcast.writeFile({ filePath: outputPath, data: renderedBuffer });
            } else {
                // Save temp WebM, convert to MP4
                text.textContent = 'Converting to MP4...';
                const tmpPath = await window.zoomcast.saveTempVideo(renderedBuffer);

                try {
                    await window.zoomcast.simpleExport({
                        inputPath: tmpPath,
                        outputPath: outputPath,
                    });
                } catch (ffmpegErr) {
                    // FFmpeg failed — save as WebM
                    const webmPath = outputPath.replace(/\\.mp4$/i, '.webm');
                    await window.zoomcast.writeFile({ filePath: webmPath, data: renderedBuffer });
                    outputPath = webmPath;
                    text.textContent = 'Saved as WebM (FFmpeg unavailable)';
                }
            }

            fill.style.width = '100%';
            pct.textContent = '100%';
            text.textContent = 'Complete!';

            // Show completion
            document.getElementById('export-complete').classList.remove('hidden');
            document.getElementById('export-complete-path').textContent = outputPath;
            document.getElementById('btn-open-folder').onclick = () => window.zoomcast.showInFolder(outputPath);
            document.getElementById('btn-new-recording').onclick = () => {
                this._showScreen('home');
                this.segments = [];
            };

        } catch (err) {
            fill.style.width = '0%';
            text.textContent = 'Export failed: ' + err.message;
            pct.textContent = '';
        }

        btn.disabled = false;
        btn.textContent = 'Render & Export';
    }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
    window.app = new ZoomCastApp();
});
