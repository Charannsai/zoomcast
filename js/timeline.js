/**
 * ZoomCast — Timeline Component v3
 * - Zoom-mode: drag segments, seek on timeline
 * - Cut-mode:  click+drag to rubber-band a selection range → "Delete Selection"
 * - Cut zones rendered as hatched overlays
 */

class Timeline {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.duration = options.duration || 1;
        this.segments = options.segments || [];
        this.cuts = options.cuts || [];            // Array of { tStart, tEnd }
        this.playhead = 0;
        this.selectedSeg = null;
        this.selectedClip = null;
        this.hoverScissor = false;
        this.thumbnails = [];

        // Callbacks
        this.onSeek = options.onSeek || (() => { });
        this.onSelectionChange = options.onSelectionChange || (() => { });
        this.onSegmentChange = options.onSegmentChange || (() => { });

        // Layout constants
        this.THUMB_H = 52;
        this.SEG_TRACK_Y = 58;
        this.SEG_H = 28;
        this.HANDLE_W = 10;
        this.SNAP_PX = 6;

        // Video clips (splits) tracking
        this.clips = [{ start: 0, end: this.duration, deleted: false }];

        this._drag = null;
        this._setupEvents();
        this._resize();

        this._resizeObs = new ResizeObserver(() => this._resize());
        this._resizeObs.observe(canvas.parentElement);
    }

    _rebuildCutsFromClips() {
        this.cuts = [];
        for (const clip of this.clips) {
            if (clip.deleted) {
                this.cuts.push({ tStart: clip.start, tEnd: clip.end });
            }
        }
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
        this.canvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
        this.canvas.addEventListener('mouseleave', () => { this._onMouseUp(); this._setCursor('default'); });
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        this.canvas.addEventListener('dblclick', (e) => this._onDoubleClick(e));
    }

    _tToX(t) { return (t / Math.max(this.duration, 0.001)) * this.W; }
    _xToT(x) { return Math.max(0, Math.min(this.duration, (x / this.W) * this.duration)); }
    _setCursor(cursor) { this.canvas.style.cursor = cursor; }

    // ─── Hit testing (zoom segments) ─────────────────────────────────
    _hitTest(x, y) {
        for (let i = this.segments.length - 1; i >= 0; i--) {
            const seg = this.segments[i];
            const sx1 = this._tToX(seg.tStart);
            const sx2 = this._tToX(seg.tEnd);
            const sy1 = this.SEG_TRACK_Y;
            const sy2 = sy1 + this.SEG_H;

            if (y >= sy1 - 2 && y <= sy2 + 2) {
                if (x >= sx1 - 3 && x <= sx1 + this.HANDLE_W) return { seg, zone: 'left' };
                if (x >= sx2 - this.HANDLE_W && x <= sx2 + 3) return { seg, zone: 'right' };
                if (x >= sx1 && x <= sx2) return { seg, zone: 'body' };
            }
        }
        return null;
    }

    _snap(t, exclude = null) {
        const threshold = this._xToT(this.SNAP_PX) - this._xToT(0);
        if (Math.abs(t - this.playhead) < threshold) return this.playhead;
        for (const seg of this.segments) {
            if (seg === exclude) continue;
            if (Math.abs(t - seg.tStart) < threshold) return seg.tStart;
            if (Math.abs(t - seg.tEnd) < threshold) return seg.tEnd;
        }
        const rounded = Math.round(t * 2) / 2;
        if (Math.abs(t - rounded) < threshold * 0.5) return rounded;
        return t;
    }

    // ─── Mouse handlers ───────────────────────────────────────────────
    _onMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const t = this._xToT(x);

        if (this.hoverScissor) {
            this._splitClipAt(this.playhead);
            return;
        }

        // Thumbnails area click (selects a clip, checks handles, moves playhead)
        if (y < this.THUMB_H) {
            // 1. Check clip edges first (trim handles)
            for (const c of this.clips) {
                if (c.deleted) continue;
                const cx1 = this._tToX(c.start);
                const cx2 = this._tToX(c.end);

                if (Math.abs(x - cx1) <= 8) {
                    this.selectedClip = c;
                    this.selectedSeg = null;
                    this.onSelectionChange(null, c);
                    this._drag = { clip: c, type: 'clip-left', startX: x, origStart: c.start };
                    this._setCursor('ew-resize');
                    return;
                }
                if (Math.abs(x - cx2) <= 8) {
                    this.selectedClip = c;
                    this.selectedSeg = null;
                    this.onSelectionChange(null, c);
                    this._drag = { clip: c, type: 'clip-right', startX: x, origEnd: c.end };
                    this._setCursor('ew-resize');
                    return;
                }
            }

            // 2. Otherwise select clip or seek
            this.playhead = t;
            const clip = this.clips.find(c => t >= c.start && t < c.end && !c.deleted);
            this.selectedClip = clip || null;
            this.selectedSeg = null;
            this.onSelectionChange(this.selectedSeg, this.selectedClip);
            this.onSeek(t);
            this._drag = { type: 'seek' };
            this.draw();
            return;
        }

        // Zoom segment hit test
        const hit = this._hitTest(x, y);
        if (hit) {
            const { seg, zone } = hit;
            this.selectedSeg = seg;
            this.selectedClip = null;
            this.onSelectionChange(this.selectedSeg, this.selectedClip);
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

        // Empty area seek
        this.selectedSeg = null;
        this.selectedClip = null;
        this.onSelectionChange(null, null);
        this.playhead = t;
        this.onSeek(t);
        this._drag = { type: 'seek' };
        this.draw();
    }

    _splitClipAt(t) {
        const idx = this.clips.findIndex(c => t > c.start + 0.05 && t < c.end - 0.05);
        if (idx !== -1) {
            const clip = this.clips[idx];
            const newClip = { start: t, end: clip.end, deleted: clip.deleted };
            clip.end = t;
            this.clips.splice(idx + 1, 0, newClip);
            this._rebuildCutsFromClips();
            this.draw();
        }
    }

    _onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const px = this._tToX(this.playhead);
        if (Math.abs(x - px) < 14 && y < 24) {
            this.hoverScissor = true;
            this._setCursor('pointer'); // Will be styled to scissors in a sec, or we just draw it dynamically
            this.draw();
            return;
        } else if (this.hoverScissor) {
            this.hoverScissor = false;
            this.draw();
        }

        // Drag logic
        if (this._drag) {
            if (this._drag.type === 'seek') {
                const t = this._xToT(x);
                this.playhead = t;
                this.onSeek(t);
                this.draw();
                return;
            }

            const dt = this._xToT(x) - this._xToT(this._drag.startX);

            if (this._drag.clip) {
                const clip = this._drag.clip;
                if (this._drag.type === 'clip-left') {
                    const maxStart = clip.end - 0.2;
                    let newStart = this._drag.origStart + dt;
                    // constrain to previous clip end
                    const idx = this.clips.indexOf(clip);
                    const minStart = idx > 0 ? this.clips[idx - 1].end : 0;
                    clip.start = Math.max(minStart, Math.min(maxStart, newStart));
                    this._rebuildCutsFromClips();
                    this.onSelectionChange(null, clip);
                    this.draw();
                } else if (this._drag.type === 'clip-right') {
                    const minEnd = clip.start + 0.2;
                    let newEnd = this._drag.origEnd + dt;
                    // constrain to next clip start
                    const idx = this.clips.indexOf(clip);
                    const maxEnd = idx < this.clips.length - 1 ? this.clips[idx + 1].start : this.duration;
                    clip.end = Math.max(minEnd, Math.min(newEnd, maxEnd));
                    this._rebuildCutsFromClips();
                    this.onSelectionChange(null, clip);
                    this.draw();
                }
                return;
            }

            const { seg, type, startX, origStart, origEnd } = this._drag;
            const minDur = 0.15;
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

        // Hover cursor feedback
        const hit = this._hitTest(x, y);
        if (hit) {
            this._setCursor(hit.zone === 'body' ? 'grab' : 'ew-resize');
        } else if (y < this.THUMB_H) {
            let onHandle = false;
            for (const c of this.clips) {
                if (c.deleted) continue;
                const cx1 = this._tToX(c.start);
                const cx2 = this._tToX(c.end);
                if (Math.abs(x - cx1) <= 8 || Math.abs(x - cx2) <= 8) {
                    onHandle = true;
                    break;
                }
            }
            this._setCursor(onHandle ? 'ew-resize' : 'pointer');
        } else {
            this._setCursor('default');
        }
    }

    _onMouseUp(e) {
        if (this._drag && this._drag.type !== 'seek') {
            if (this._drag.seg) this.onSegmentChange(this._drag.seg);
            if (this._drag.clip) this.onSelectionChange(null, this._drag.clip);
        }
        this._drag = null;
    }

    _onDoubleClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const hit = this._hitTest(x, y);
        if (hit && hit.seg) {
            const mid = (hit.seg.tStart + hit.seg.tEnd) / 2;
            this.playhead = mid;
            this.selectedSeg = hit.seg;
            this.selectedClip = null;
            this.onSelectionChange(this.selectedSeg, this.selectedClip);
            this.onSeek(mid);
            this.draw();
        }
    }

    // ─── Thumbnails ────────────────────────────────────────────────────
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

    // ─── Main Draw ─────────────────────────────────────────────────────
    draw() {
        const { ctx, W, H } = this;
        if (!W) return;

        ctx.clearRect(0, 0, W, H);

        // Background
        ctx.fillStyle = '#1a1e27';
        ctx.fillRect(0, 0, W, H);

        // Thumbnail strip
        if (this.thumbnails.length > 0) {
            let x = 0;
            for (const thumb of this.thumbnails) {
                if (x >= W) break;
                ctx.drawImage(thumb.img, x, 0, thumb.w, this.THUMB_H);
                x += thumb.w;
            }
            // Dim overlay for base thumbnails
            ctx.fillStyle = 'rgba(12, 15, 22, 0.48)';
            ctx.fillRect(0, 0, W, this.THUMB_H);

            // Draw clip outlines and highlight selected
            for (const clip of this.clips) {
                if (clip.deleted) continue;
                const cx1 = this._tToX(clip.start);
                const cx2 = this._tToX(clip.end);
                const cw = cx2 - cx1;

                // Draw split marker lines
                if (clip.start > 0) {
                    ctx.fillStyle = '#1e1e1e';
                    ctx.fillRect(cx1 - 2, 0, 4, this.THUMB_H);
                    ctx.fillStyle = '#f5a623';
                    ctx.fillRect(cx1 - 1, 0, 2, this.THUMB_H);
                }

                if (clip === this.selectedClip) {
                    ctx.strokeStyle = '#f5a623';
                    ctx.lineWidth = 3;
                    ctx.strokeRect(cx1 + 1.5, 1.5, cw - 3, this.THUMB_H - 3);
                    ctx.fillStyle = 'rgba(245, 166, 35, 0.1)';
                    ctx.fillRect(cx1, 0, cw, this.THUMB_H);
                }
            }
        }

        // Separator
        ctx.fillStyle = '#262d3a';
        ctx.fillRect(0, this.THUMB_H, W, 1);

        // Segment track bg
        ctx.fillStyle = 'rgba(255,255,255,0.02)';
        ctx.fillRect(0, this.SEG_TRACK_Y - 2, W, this.SEG_H + 4);

        // Time tick marks + labels
        const numLabels = Math.min(20, Math.floor(W / 60));
        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = '#4d5666';
        for (let i = 0; i <= numLabels; i++) {
            const t = (this.duration * i) / numLabels;
            const x = this._tToX(t);
            ctx.fillStyle = '#333d4d';
            ctx.fillRect(x, this.THUMB_H, 1, 4);
            if (i % 2 === 0) {
                ctx.fillStyle = '#4d5666';
                ctx.fillText(this._formatTime(t), x + 2, this.THUMB_H + 14);
            }
        }

        // Zoom segments
        for (const seg of this.segments) {
            this._drawSegment(ctx, seg);
        }

        // Committed cut zones (deleted clips)
        this._drawCutZones(ctx, W, H);

        // Snap guides (zoom mode)
        if (this._drag && this._drag.seg) {
            this._drawSnapGuides(ctx);
        }

        // Playhead
        const px = this._tToX(this.playhead);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(px - 1, 0, 2, H);
        ctx.beginPath();
        ctx.moveTo(px - 6, 0);
        ctx.lineTo(px + 6, 0);
        ctx.lineTo(px, 8);
        ctx.closePath();
        ctx.fill();

        // Playhead time
        ctx.font = 'bold 9px Inter, sans-serif';
        ctx.fillStyle = '#6aa3f8';
        ctx.textAlign = 'center';
        ctx.fillText(this._formatTime(this.playhead), px, H - 4);
        ctx.textAlign = 'start';

        // Scissor Cutter on Playhead
        ctx.save();
        ctx.translate(px, 12);

        // Background handle circle/box
        ctx.fillStyle = this.hoverScissor ? '#e84393' : '#333';
        ctx.beginPath();
        ctx.arc(0, 0, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Scissor Icon
        ctx.fillStyle = '#fff';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✂', 0, 0);
        ctx.restore();
    }



    // ─── Committed Cut Zones ──────────────────────────────────────────
    _drawCutZones(ctx, W, H) {
        if (!this.cuts || this.cuts.length === 0) return;
        for (const cut of this.cuts) {
            const x1 = this._tToX(cut.tStart);
            const x2 = this._tToX(cut.tEnd);
            const w = Math.max(x2 - x1, 3);

            ctx.fillStyle = 'rgba(180, 40, 100, 0.25)';
            ctx.fillRect(x1, 0, w, H);

            ctx.save();
            ctx.beginPath();
            ctx.rect(x1, 0, w, H);
            ctx.clip();
            ctx.strokeStyle = 'rgba(200, 50, 110, 0.35)';
            ctx.lineWidth = 1;
            for (let i = -H; i < w + H; i += 6) {
                ctx.beginPath();
                ctx.moveTo(x1 + i, 0);
                ctx.lineTo(x1 + i + H, H);
                ctx.stroke();
            }
            ctx.restore();

            ctx.fillStyle = 'rgba(220, 60, 120, 0.85)';
            ctx.fillRect(x1, 0, 2, H);
            ctx.fillRect(x2 - 2, 0, 2, H);

            if (w > 16) {
                ctx.font = '12px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('✂', x1 + w / 2, H / 2);
                ctx.textAlign = 'start';
                ctx.textBaseline = 'alphabetic';
            }
        }
    }

    // ─── Zoom Segment Drawing ─────────────────────────────────────────
    _drawSegment(ctx, seg) {
        const x1 = this._tToX(seg.tStart);
        const x2 = this._tToX(seg.tEnd);
        const y1 = this.SEG_TRACK_Y;
        const w = Math.max(x2 - x1, 4);
        const selected = seg === this.selectedSeg;

        // Ease tails
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

        // Segment body
        ctx.fillStyle = selected ? seg.color : seg.color + 'bb';
        this._roundRectFill(ctx, x1, y1, w, this.SEG_H, 5);

        // Inner gloss
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

        // Resize handles
        const handleH = Math.min(16, this.SEG_H - 6);
        const handleY = y1 + (this.SEG_H - handleH) / 2;
        ctx.fillStyle = selected ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)';
        ctx.fillRect(x1 + 3, handleY, 1.5, handleH);
        ctx.fillRect(x1 + 6, handleY, 1.5, handleH);
        ctx.fillRect(x2 - 4.5, handleY, 1.5, handleH);
        ctx.fillRect(x2 - 7.5, handleY, 1.5, handleH);

        // Label
        if (w > 40) {
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.fillStyle = 'white';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`×${seg.factor.toFixed(1)}`, x1 + w / 2, y1 + this.SEG_H / 2);
            ctx.textAlign = 'start';
            ctx.textBaseline = 'alphabetic';
        }

        // Duration
        if (w > 50 && selected) {
            const dur = (seg.tEnd - seg.tStart).toFixed(1) + 's';
            ctx.font = '9px Inter, sans-serif';
            ctx.fillStyle = '#9ca3af';
            ctx.textAlign = 'center';
            ctx.fillText(dur, x1 + w / 2, y1 - 5);
            ctx.textAlign = 'start';
        }
    }

    _drawSnapGuides(ctx) {
        if (!this._drag || !this._drag.seg) return;
        const seg = this._drag.seg;
        const edges = [seg.tStart, seg.tEnd];
        const threshold = this._xToT(this.SNAP_PX) - this._xToT(0);

        for (const edge of edges) {
            if (Math.abs(edge - this.playhead) < threshold * 1.5) {
                const x = this._tToX(this.playhead);
                ctx.setLineDash([3, 3]);
                ctx.strokeStyle = '#4f8ff7';
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.H); ctx.stroke();
                ctx.setLineDash([]);
            }
        }
        for (const otherSeg of this.segments) {
            if (otherSeg === seg) continue;
            for (const otherEdge of [otherSeg.tStart, otherSeg.tEnd]) {
                for (const edge of edges) {
                    if (Math.abs(edge - otherEdge) < threshold * 1.5) {
                        const x = this._tToX(otherEdge);
                        ctx.setLineDash([2, 4]);
                        ctx.strokeStyle = '#f5a623';
                        ctx.lineWidth = 1;
                        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.H); ctx.stroke();
                        ctx.setLineDash([]);
                    }
                }
            }
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────
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
