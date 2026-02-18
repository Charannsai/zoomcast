/**
 * ZoomCast — Timeline Component v2
 * Canvas-based timeline with thumbnails, zoom segments, playhead,
 * improved drag interactions, cursor style feedback, and snapping.
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

        // Layout constants
        this.THUMB_H = 50;
        this.SEG_TRACK_Y = 56;
        this.SEG_H = 28;
        this.LABEL_Y = 90;
        this.HANDLE_W = 10;       // Wider handle zone for easier grab
        this.SNAP_PX = 6;         // Snap threshold in pixels

        this._drag = null;
        this._hoveredHandle = null; // For cursor style feedback
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
        this.canvas.addEventListener('mouseleave', () => { this._onMouseUp(); this._setCursor('default'); });
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        this.canvas.addEventListener('dblclick', (e) => this._onDoubleClick(e));
    }

    _tToX(t) { return (t / Math.max(this.duration, 0.001)) * this.W; }
    _xToT(x) { return Math.max(0, Math.min(this.duration, (x / this.W) * this.duration)); }

    _setCursor(cursor) {
        this.canvas.style.cursor = cursor;
    }

    /**
     * Find what the mouse is hovering over in the segment track.
     * Returns: { seg, zone } where zone is 'left'|'right'|'body'|null
     */
    _hitTest(x, y) {
        // Check segments in reverse order (top-most first)
        for (let i = this.segments.length - 1; i >= 0; i--) {
            const seg = this.segments[i];
            const sx1 = this._tToX(seg.tStart);
            const sx2 = this._tToX(seg.tEnd);
            const sy1 = this.SEG_TRACK_Y;
            const sy2 = sy1 + this.SEG_H;

            if (y >= sy1 - 2 && y <= sy2 + 2) {
                // Left handle (wider grab zone)
                if (x >= sx1 - 3 && x <= sx1 + this.HANDLE_W) {
                    return { seg, zone: 'left' };
                }
                // Right handle
                if (x >= sx2 - this.HANDLE_W && x <= sx2 + 3) {
                    return { seg, zone: 'right' };
                }
                // Body
                if (x >= sx1 && x <= sx2) {
                    return { seg, zone: 'body' };
                }
            }
        }
        return null;
    }

    /**
     * Snap a time value to the playhead or other segment edges.
     */
    _snap(t, exclude = null) {
        const threshold = this._xToT(this.SNAP_PX) - this._xToT(0);

        // Snap to playhead
        if (Math.abs(t - this.playhead) < threshold) return this.playhead;

        // Snap to segment edges
        for (const seg of this.segments) {
            if (seg === exclude) continue;
            if (Math.abs(t - seg.tStart) < threshold) return seg.tStart;
            if (Math.abs(t - seg.tEnd) < threshold) return seg.tEnd;
        }

        // Snap to round time values (every 0.5s)
        const rounded = Math.round(t * 2) / 2;
        if (Math.abs(t - rounded) < threshold * 0.5) return rounded;

        return t;
    }

    _onMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const hit = this._hitTest(x, y);

        if (hit) {
            const { seg, zone } = hit;
            this.selectedSeg = seg;
            this.onSegmentSelect(seg);

            if (zone === 'left') {
                this._drag = { seg, type: 'left', startX: x, origStart: seg.tStart, origEnd: seg.tEnd };
                this._setCursor('ew-resize');
            } else if (zone === 'right') {
                this._drag = { seg, type: 'right', startX: x, origStart: seg.tStart, origEnd: seg.tEnd };
                this._setCursor('ew-resize');
            } else {
                this._drag = { seg, type: 'move', startX: x, origStart: seg.tStart, origEnd: seg.tEnd };
                this._setCursor('grabbing');
            }

            this.draw();
            return;
        }

        // Nothing hit — seek to position, deselect
        this.selectedSeg = null;
        this.onSegmentSelect(null);
        const t = this._xToT(x);
        this.playhead = t;
        this.onSeek(t);
        this._drag = { type: 'seek' };
        this.draw();
    }

    _onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Dragging
        if (this._drag) {
            if (this._drag.type === 'seek') {
                const t = this._xToT(x);
                this.playhead = t;
                this.onSeek(t);
                this.draw();
                return;
            }

            const { seg, type, startX, origStart, origEnd } = this._drag;
            const dt = this._xToT(x) - this._xToT(startX);
            const minDur = 0.15; // Minimum segment duration

            if (type === 'left') {
                let newStart = origStart + dt;
                newStart = Math.max(0, Math.min(origEnd - minDur, newStart));
                newStart = this._snap(newStart, seg);
                seg.tStart = newStart;
            } else if (type === 'right') {
                let newEnd = origEnd + dt;
                newEnd = Math.max(origStart + minDur, Math.min(this.duration, newEnd));
                newEnd = this._snap(newEnd, seg);
                seg.tEnd = newEnd;
            } else if (type === 'move') {
                const dur = origEnd - origStart;
                let newStart = origStart + dt;
                newStart = Math.max(0, Math.min(this.duration - dur, newStart));
                newStart = this._snap(newStart, seg);
                seg.tStart = newStart;
                seg.tEnd = newStart + dur;
            }

            this.onSegmentChange(seg);
            this.draw();
            return;
        }

        // Hovering — update cursor style
        const hit = this._hitTest(x, y);
        if (hit) {
            if (hit.zone === 'left' || hit.zone === 'right') {
                this._setCursor('ew-resize');
            } else {
                this._setCursor('grab');
            }
        } else {
            this._setCursor('default');
        }
    }

    _onMouseUp() {
        if (this._drag && this._drag.type !== 'seek') {
            // Finalize drag — trigger change event
            if (this._drag.seg) {
                this.onSegmentChange(this._drag.seg);
            }
        }
        this._drag = null;
    }

    /**
     * Double-click to jump playhead to segment center.
     */
    _onDoubleClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const hit = this._hitTest(x, y);
        if (hit && hit.seg) {
            const mid = (hit.seg.tStart + hit.seg.tEnd) / 2;
            this.playhead = mid;
            this.selectedSeg = hit.seg;
            this.onSegmentSelect(hit.seg);
            this.onSeek(mid);
            this.draw();
        }
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

        // Segment track background (subtle)
        ctx.fillStyle = 'rgba(255,255,255,0.02)';
        ctx.fillRect(0, this.SEG_TRACK_Y - 2, W, this.SEG_H + 4);

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

        // Zoom segments (bottom to top for correct overlap)
        for (const seg of this.segments) {
            this._drawSegment(ctx, seg);
        }

        // Snap guide lines (while dragging)
        if (this._drag && this._drag.seg) {
            this._drawSnapGuides(ctx);
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

        // Playhead time tooltip
        ctx.font = 'bold 9px Inter, sans-serif';
        ctx.fillStyle = '#4f8ff7';
        ctx.textAlign = 'center';
        ctx.fillText(this._formatTime(this.playhead), px, H - 4);
        ctx.textAlign = 'start';
    }

    _drawSegment(ctx, seg) {
        const x1 = this._tToX(seg.tStart);
        const x2 = this._tToX(seg.tEnd);
        const y1 = this.SEG_TRACK_Y;
        const w = Math.max(x2 - x1, 4);
        const selected = seg === this.selectedSeg;

        // Ease indicators (gradient tails behind the segment)
        if (seg.easeIn > 0) {
            const ex = this._tToX(seg.tStart - seg.easeIn);
            const grad = ctx.createLinearGradient(ex, 0, x1, 0);
            grad.addColorStop(0, seg.color + '00');
            grad.addColorStop(1, seg.color + '33');
            ctx.fillStyle = grad;
            this._roundRectFill(ctx, ex, y1, x1 - ex, this.SEG_H, 3);
        }
        if (seg.easeOut > 0) {
            const ex = this._tToX(seg.tEnd + seg.easeOut);
            const grad = ctx.createLinearGradient(x2, 0, ex, 0);
            grad.addColorStop(0, seg.color + '33');
            grad.addColorStop(1, seg.color + '00');
            ctx.fillStyle = grad;
            this._roundRectFill(ctx, x2, y1, ex - x2, this.SEG_H, 3);
        }

        // Segment body fill
        if (selected) {
            ctx.fillStyle = seg.color;
        } else {
            ctx.fillStyle = seg.color + 'bb';
        }
        this._roundRectFill(ctx, x1, y1, w, this.SEG_H, 5);

        // Inner gradient highlight (top edge glow)
        const innerGrad = ctx.createLinearGradient(0, y1, 0, y1 + this.SEG_H);
        innerGrad.addColorStop(0, 'rgba(255,255,255,0.15)');
        innerGrad.addColorStop(0.5, 'rgba(255,255,255,0)');
        innerGrad.addColorStop(1, 'rgba(0,0,0,0.1)');
        ctx.fillStyle = innerGrad;
        this._roundRectFill(ctx, x1, y1, w, this.SEG_H, 5);

        // Selection border
        if (selected) {
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            this._roundRectStroke(ctx, x1, y1, w, this.SEG_H, 5);
        }

        // Resize handles (visible bars on edges)
        const handleH = Math.min(16, this.SEG_H - 6);
        const handleY = y1 + (this.SEG_H - handleH) / 2;
        ctx.fillStyle = selected ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)';
        // Left handle = 2 thin bars
        ctx.fillRect(x1 + 3, handleY, 1.5, handleH);
        ctx.fillRect(x1 + 6, handleY, 1.5, handleH);
        // Right handle = 2 thin bars
        ctx.fillRect(x2 - 4.5, handleY, 1.5, handleH);
        ctx.fillRect(x2 - 7.5, handleY, 1.5, handleH);

        // Label (zoom factor + duration)
        if (w > 40) {
            const label = `×${seg.factor.toFixed(1)}`;
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.fillStyle = 'white';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x1 + w / 2, y1 + this.SEG_H / 2);
            ctx.textAlign = 'start';
            ctx.textBaseline = 'alphabetic';
        }

        // Duration text above the segment
        if (w > 50 && selected) {
            const dur = (seg.tEnd - seg.tStart).toFixed(1) + 's';
            ctx.font = '9px Inter, sans-serif';
            ctx.fillStyle = '#9ca3af';
            ctx.textAlign = 'center';
            ctx.fillText(dur, x1 + w / 2, y1 - 5);
            ctx.textAlign = 'start';
        }
    }

    /**
     * Draw vertical snap guide lines while dragging.
     */
    _drawSnapGuides(ctx) {
        if (!this._drag || !this._drag.seg) return;
        const seg = this._drag.seg;
        const edges = [seg.tStart, seg.tEnd];
        const threshold = this._xToT(this.SNAP_PX) - this._xToT(0);

        // Check against playhead
        for (const edge of edges) {
            if (Math.abs(edge - this.playhead) < threshold * 1.5) {
                const x = this._tToX(this.playhead);
                ctx.setLineDash([3, 3]);
                ctx.strokeStyle = '#4f8ff7';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, this.H);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // Check against other segment edges
        for (const otherSeg of this.segments) {
            if (otherSeg === seg) continue;
            const otherEdges = [otherSeg.tStart, otherSeg.tEnd];
            for (const otherEdge of otherEdges) {
                for (const edge of edges) {
                    if (Math.abs(edge - otherEdge) < threshold * 1.5) {
                        const x = this._tToX(otherEdge);
                        ctx.setLineDash([2, 4]);
                        ctx.strokeStyle = '#f5a623';
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(x, 0);
                        ctx.lineTo(x, this.H);
                        ctx.stroke();
                        ctx.setLineDash([]);
                    }
                }
            }
        }
    }

    _roundRectFill(ctx, x, y, w, h, r) {
        if (w <= 0 || h <= 0) return;
        r = Math.min(r, w / 2, h / 2);
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
        if (w <= 0 || h <= 0) return;
        r = Math.min(r, w / 2, h / 2);
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
