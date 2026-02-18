/**
 * ZoomCast — Zoom Engine
 * Handles zoom calculation with smooth easing curves.
 */

class ZoomSegment {
    constructor(tStart, tEnd, cx, cy, factor = 2.2, color = '#3b82f6') {
        this.tStart = tStart;
        this.tEnd = tEnd;
        this.cx = cx;       // 0..1 normalized
        this.cy = cy;       // 0..1 normalized
        this.factor = factor;
        this.color = color;
        this.label = '';
        this.easeIn = 0.3;  // seconds for ease-in
        this.easeOut = 0.3; // seconds for ease-out
    }
}

class ZoomEngine {
    static COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#22d3ee', '#f97316'];

    // Cubic bezier ease-in-out
    static easeInOut(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    static easeOut(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    static easeIn(t) {
        return t * t * t;
    }

    /**
     * Calculate zoom factor and center at time t given all segments.
     * Returns { factor, cx, cy }
     */
    static getZoomAt(t, segments) {
        let factor = 1.0;
        let cx = 0.5, cy = 0.5;

        for (const seg of segments) {
            if (t < seg.tStart - seg.easeIn || t > seg.tEnd + seg.easeOut) continue;

            let segFactor = seg.factor;
            let localFactor = 1.0;

            if (t < seg.tStart) {
                // Easing in before segment starts
                const p = (t - (seg.tStart - seg.easeIn)) / seg.easeIn;
                localFactor = 1 + (segFactor - 1) * this.easeIn(Math.max(0, Math.min(1, p)));
            } else if (t > seg.tEnd) {
                // Easing out after segment ends
                const p = (t - seg.tEnd) / seg.easeOut;
                localFactor = segFactor - (segFactor - 1) * this.easeOut(Math.max(0, Math.min(1, p)));
            } else {
                // Inside segment - full zoom
                localFactor = segFactor;
            }

            if (localFactor > factor) {
                factor = localFactor;
                cx = seg.cx;
                cy = seg.cy;
            }
        }

        return { factor, cx, cy };
    }

    /**
     * Auto-generate zoom segments from click data.
     */
    static autoGenerateZooms(clickData, duration, options = {}) {
        const {
            zoomFactor = 2.2,
            segDuration = 2.5,
            minGap = 0.8,
            maxSegments = 50,
        } = options;

        const segments = [];
        let lastEnd = -Infinity;

        for (const click of clickData) {
            if (click.t - lastEnd < minGap) continue;
            if (segments.length >= maxSegments) break;

            const tStart = Math.max(0, click.t - 0.2);
            const tEnd = Math.min(duration, tStart + segDuration);
            const colorIdx = segments.length % this.COLORS.length;

            const seg = new ZoomSegment(tStart, tEnd, click.x, click.y, zoomFactor, this.COLORS[colorIdx]);
            segments.push(seg);
            lastEnd = tEnd;
        }

        return segments;
    }

    /**
     * Render a frame with zoom + background + corners + shadow onto a canvas.
     * @param {CanvasRenderingContext2D} ctx - Target canvas context
     * @param {HTMLVideoElement|HTMLCanvasElement|HTMLImageElement} source - Source frame
     * @param {number} t - Current time
     * @param {Array} segments - Zoom segments
     * @param {Object} config - Appearance config
     */
    static renderFrame(ctx, source, t, segments, config) {
        const {
            outWidth, outHeight,
            padding = 48, corners = 16,
            shadow = true, shadowIntensity = 60,
            bgColor = '#0f0f1a', bgColor2 = '#1a0a2e', bgType = 'gradient',
            cursorData = null, cursorSize = 1.2,
            clickData = null, clickEffects = true,
        } = config;

        const cw = outWidth;
        const ch = outHeight;

        // 1. Draw background
        if (bgType === 'gradient') {
            const grad = ctx.createLinearGradient(0, 0, cw, ch);
            grad.addColorStop(0, bgColor);
            grad.addColorStop(1, bgColor2);
            ctx.fillStyle = grad;
        } else {
            ctx.fillStyle = bgColor;
        }
        ctx.fillRect(0, 0, cw, ch);

        // 2. Calculate zoom
        const zoom = this.getZoomAt(t, segments);
        const { factor, cx, cy } = zoom;

        // 3. Calculate screen area (with padding)
        const screenW = cw - padding * 2;
        const screenH = ch - padding * 2;
        const screenX = padding;
        const screenY = padding;

        // 4. Draw shadow behind screen
        if (shadow) {
            const alpha = (shadowIntensity / 100) * 0.7;
            ctx.save();
            ctx.shadowColor = `rgba(0, 0, 0, ${alpha})`;
            ctx.shadowBlur = 40;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 8;
            this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
            ctx.fillStyle = '#000';
            ctx.fill();
            ctx.restore();
        }

        // 5. Clip to rounded rectangle and draw zoomed frame
        ctx.save();
        this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
        ctx.clip();

        // Source dimensions
        const sw = source.videoWidth || source.width;
        const sh = source.videoHeight || source.height;

        if (factor > 1.001) {
            // Zoomed: crop source before drawing
            const cropW = sw / factor;
            const cropH = sh / factor;
            const px = cx * sw;
            const py = cy * sh;
            const sx = Math.max(0, Math.min(sw - cropW, px - cropW / 2));
            const sy = Math.max(0, Math.min(sh - cropH, py - cropH / 2));
            ctx.drawImage(source, sx, sy, cropW, cropH, screenX, screenY, screenW, screenH);
        } else {
            ctx.drawImage(source, 0, 0, sw, sh, screenX, screenY, screenW, screenH);
        }

        // 6. Draw cursor overlay
        if (cursorData) {
            const cursor = this._getCursorAt(t, cursorData);
            if (cursor) {
                let curX, curY;
                if (factor > 1.001) {
                    const cropW = 1 / factor;
                    const cropH = 1 / factor;
                    const ox = Math.max(0, Math.min(1 - cropW, cx - cropW / 2));
                    const oy = Math.max(0, Math.min(1 - cropH, cy - cropH / 2));
                    curX = screenX + ((cursor.x - ox) / cropW) * screenW;
                    curY = screenY + ((cursor.y - oy) / cropH) * screenH;
                } else {
                    curX = screenX + cursor.x * screenW;
                    curY = screenY + cursor.y * screenH;
                }

                const r = 6 * cursorSize;
                // Cursor dot
                ctx.fillStyle = 'white';
                ctx.beginPath();
                ctx.arc(curX, curY, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = 'rgba(0,0,0,0.4)';
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
        }

        // 7. Click ripple effects
        if (clickEffects && clickData) {
            for (const click of clickData) {
                const dt = t - click.t;
                if (dt < 0 || dt > 0.6) continue;
                const progress = dt / 0.6;
                const rippleR = 20 + 40 * progress;
                const alpha = 1 - progress;

                let clickX, clickY;
                if (factor > 1.001) {
                    const cropW = 1 / factor;
                    const cropH = 1 / factor;
                    const ox = Math.max(0, Math.min(1 - cropW, cx - cropW / 2));
                    const oy = Math.max(0, Math.min(1 - cropH, cy - cropH / 2));
                    clickX = screenX + ((click.x - ox) / cropW) * screenW;
                    clickY = screenY + ((click.y - oy) / cropH) * screenH;
                } else {
                    clickX = screenX + click.x * screenW;
                    clickY = screenY + click.y * screenH;
                }

                ctx.beginPath();
                ctx.arc(clickX, clickY, rippleR, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(59, 130, 246, ${alpha * 0.6})`;
                ctx.lineWidth = 2.5;
                ctx.stroke();
            }
        }

        ctx.restore();

        // 8. Thin border on rounded rect
        ctx.save();
        this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();

        return zoom;
    }

    static _roundRect(ctx, x, y, w, h, r) {
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
    }

    static _getCursorAt(t, cursorData) {
        if (!cursorData || cursorData.length === 0) return null;
        // Binary search for nearest
        let lo = 0, hi = cursorData.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cursorData[mid].t < t) lo = mid + 1;
            else hi = mid;
        }
        return cursorData[lo];
    }
}

// Make available globally
window.ZoomSegment = ZoomSegment;
window.ZoomEngine = ZoomEngine;
