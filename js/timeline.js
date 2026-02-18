/**
 * ZoomCast — Timeline Component
 * Canvas-based timeline with thumbnails, zoom segments, playhead, and drag interactions.
 */

class Timeline {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.duration = options.duration || 1;
        this.segments = options.segments || [];
        this.playhead = 0;
        this.selectedSeg = null;
        this.thumbnails = [];
        this.onSeek = options.onSeek || (() => { });
        this.onSegmentSelect = options.onSegmentSelect || (() => { });
        this.onSegmentChange = options.onSegmentChange || (() => { });

        this.THUMB_H = 50;
        this.SEG_H = 22;
        this.SEG_Y = 56;
        this.LABEL_Y = 90;

        this._drag = null;
        this._setupEvents();
        this._resize();

        this._resizeObs = new ResizeObserver(() => this._resize());
        this._resizeObs.observe(canvas.parentElement);
    }

    _resize() {
        const rect = this.canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.canvas.style.width = rect.width + 'px';
        this.canvas.style.height = rect.height + 'px';
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.W = rect.width;
        this.H = rect.height;
        this.draw();
    }

    _setupEvents() {
        this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this._onMouseUp());
        this.canvas.addEventListener('mouseleave', () => this._onMouseUp());
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    _tToX(t) { return (t / Math.max(this.duration, 0.001)) * this.W; }
    _xToT(x) { return Math.max(0, Math.min(this.duration, (x / this.W) * this.duration)); }

    _onMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Check segments for interaction
        for (const seg of this.segments) {
            const sx1 = this._tToX(seg.tStart);
            const sx2 = this._tToX(seg.tEnd);
            const sy1 = this.SEG_Y, sy2 = this.SEG_Y + this.SEG_H;

            if (y >= sy1 && y <= sy2) {
                if (x >= sx1 && x <= sx1 + 8) {
                    this._drag = { seg, type: 'left', startX: x, origStart: seg.tStart, origEnd: seg.tEnd };
                    this.selectedSeg = seg;
                    this.onSegmentSelect(seg);
                    this.draw();
                    return;
                }
                if (x >= sx2 - 8 && x <= sx2) {
                    this._drag = { seg, type: 'right', startX: x, origStart: seg.tStart, origEnd: seg.tEnd };
                    this.selectedSeg = seg;
                    this.onSegmentSelect(seg);
                    this.draw();
                    return;
                }
                if (x >= sx1 && x <= sx2) {
                    this._drag = { seg, type: 'move', startX: x, origStart: seg.tStart, origEnd: seg.tEnd };
                    this.selectedSeg = seg;
                    this.onSegmentSelect(seg);
                    this.draw();
                    return;
                }
            }
        }

        // Seek
        this.selectedSeg = null;
        this.onSegmentSelect(null);
        const t = this._xToT(x);
        this.playhead = t;
        this.onSeek(t);
        this._drag = { type: 'seek' };
        this.draw();
    }

    _onMouseMove(e) {
        if (!this._drag) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;

        if (this._drag.type === 'seek') {
            const t = this._xToT(x);
            this.playhead = t;
            this.onSeek(t);
            this.draw();
            return;
        }

        const { seg, type, startX, origStart, origEnd } = this._drag;
        const dt = this._xToT(x) - this._xToT(startX);

        if (type === 'left') {
            seg.tStart = Math.max(0, Math.min(origEnd - 0.1, origStart + dt));
        } else if (type === 'right') {
            seg.tEnd = Math.max(origStart + 0.1, Math.min(this.duration, origEnd + dt));
        } else if (type === 'move') {
            const dur = origEnd - origStart;
            seg.tStart = Math.max(0, Math.min(this.duration - dur, origStart + dt));
            seg.tEnd = seg.tStart + dur;
        }

        this.onSegmentChange(seg);
        this.draw();
    }

    _onMouseUp() {
        this._drag = null;
    }

    /**
     * Generate thumbnails from a video element.
     */
    async generateThumbnails(video) {
        this.thumbnails = [];
        const count = Math.min(80, Math.max(20, Math.floor(this.W / 30)));
        const step = this.duration / count;
        const thumbCanvas = document.createElement('canvas');
        const thumbCtx = thumbCanvas.getContext('2d');
        const aspect = video.videoWidth / video.videoHeight;
        const th = this.THUMB_H;
        const tw = Math.round(th * aspect);
        thumbCanvas.width = tw;
        thumbCanvas.height = th;

        for (let i = 0; i < count; i++) {
            const t = i * step;
            try {
                video.currentTime = t;
                await new Promise(r => { video.onseeked = r; setTimeout(r, 200); });
                thumbCtx.drawImage(video, 0, 0, tw, th);
                const img = new Image();
                img.src = thumbCanvas.toDataURL('image/jpeg', 0.5);
                await new Promise(r => { img.onload = r; setTimeout(r, 100); });
                this.thumbnails.push({ img, t, w: tw, h: th });
            } catch { break; }
        }
        video.currentTime = 0;
        this.draw();
    }

    draw() {
        const { ctx, W, H } = this;
        if (!W) return;

        ctx.clearRect(0, 0, W, H);

        // Background
        ctx.fillStyle = '#1e222b';
        ctx.fillRect(0, 0, W, H);

        // Thumbnail strip
        if (this.thumbnails.length > 0) {
            let x = 0;
            for (const thumb of this.thumbnails) {
                if (x >= W) break;
                ctx.drawImage(thumb.img, x, 0, thumb.w, this.THUMB_H);
                x += thumb.w;
            }
            // Dim overlay
            ctx.fillStyle = 'rgba(14, 16, 21, 0.45)';
            ctx.fillRect(0, 0, W, this.THUMB_H);
        }

        // Separator line
        ctx.fillStyle = '#2a303c';
        ctx.fillRect(0, this.THUMB_H, W, 1);

        // Time labels
        const numLabels = Math.min(20, Math.floor(W / 60));
        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = '#606a78';
        for (let i = 0; i <= numLabels; i++) {
            const t = (this.duration * i) / numLabels;
            const x = this._tToX(t);
            ctx.fillRect(x, this.THUMB_H, 1, 4);
            if (i % 2 === 0) {
                ctx.fillText(this._formatTime(t), x + 2, this.THUMB_H + 14);
            }
        }

        // Zoom segments
        for (const seg of this.segments) {
            this._drawSegment(ctx, seg);
        }

        // Playhead
        const px = this._tToX(this.playhead);
        ctx.fillStyle = 'white';
        ctx.fillRect(px - 1, 0, 2, H);

        // Playhead triangle
        ctx.beginPath();
        ctx.moveTo(px - 6, 0);
        ctx.lineTo(px + 6, 0);
        ctx.lineTo(px, 8);
        ctx.closePath();
        ctx.fill();
    }

    _drawSegment(ctx, seg) {
        const x1 = this._tToX(seg.tStart);
        const x2 = this._tToX(seg.tEnd);
        const y1 = this.SEG_Y;
        const y2 = y1 + this.SEG_H;
        const selected = seg === this.selectedSeg;

        // Segment body
        ctx.fillStyle = seg.color + (selected ? '' : 'cc');
        this._roundRectFill(ctx, x1, y1, x2 - x1, this.SEG_H, 4);

        // Border
        if (selected) {
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            this._roundRectStroke(ctx, x1, y1, x2 - x1, this.SEG_H, 4);
        }

        // Resize handles
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillRect(x1, y1 + 2, 3, this.SEG_H - 4);
        ctx.fillRect(x2 - 3, y1 + 2, 3, this.SEG_H - 4);

        // Label
        const label = seg.label || `×${seg.factor.toFixed(1)}`;
        const mid = (x1 + x2) / 2;
        if (x2 - x1 > 30) {
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.fillStyle = 'white';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, mid, y1 + this.SEG_H / 2);
            ctx.textAlign = 'start';
            ctx.textBaseline = 'alphabetic';
        }

        // Ease indicators (subtle gradient tails)
        if (seg.easeIn > 0) {
            const ex = this._tToX(seg.tStart - seg.easeIn);
            const grad = ctx.createLinearGradient(ex, 0, x1, 0);
            grad.addColorStop(0, seg.color + '00');
            grad.addColorStop(1, seg.color + '44');
            ctx.fillStyle = grad;
            ctx.fillRect(ex, y1, x1 - ex, this.SEG_H);
        }
        if (seg.easeOut > 0) {
            const ex = this._tToX(seg.tEnd + seg.easeOut);
            const grad = ctx.createLinearGradient(x2, 0, ex, 0);
            grad.addColorStop(0, seg.color + '44');
            grad.addColorStop(1, seg.color + '00');
            ctx.fillStyle = grad;
            ctx.fillRect(x2, y1, ex - x2, this.SEG_H);
        }
    }

    _roundRectFill(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
        ctx.fill();
    }

    _roundRectStroke(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
        ctx.stroke();
    }

    _formatTime(t) {
        const m = Math.floor(t / 60);
        const s = (t % 60).toFixed(1);
        return m > 0 ? `${m}:${s.padStart(4, '0')}` : `${s}s`;
    }
}

window.Timeline = Timeline;
