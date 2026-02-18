/**
 * ZoomCast — Zoom Engine v2
 * Smooth zoom effects with proper cursor rendering, easing, and frame composition.
 */

class ZoomSegment {
    constructor(tStart, tEnd, cx, cy, factor = 2.0, color = '#4f8ff7') {
        this.tStart = tStart;
        this.tEnd = tEnd;
        this.cx = cx;       // 0..1 normalized center x
        this.cy = cy;       // 0..1 normalized center y
        this.factor = factor;
        this.color = color;
        this.label = '';
        this.easeIn = 0.4;
        this.easeOut = 0.4;
    }
}

class ZoomEngine {
    static COLORS = ['#4f8ff7', '#9678f6', '#34d399', '#f5a623', '#f06060', '#ec4899', '#38d9e8', '#f97316'];

    // Smooth ease curves
    static easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
    static easeOutQuart(t) {
        return 1 - Math.pow(1 - t, 4);
    }
    static easeInQuart(t) {
        return t * t * t * t;
    }

    /**
     * Calculate zoom state at time t.
     * Uses smooth blending when multiple segments overlap.
     */
    static getZoomAt(t, segments) {
        let bestFactor = 1.0;
        let bestCx = 0.5, bestCy = 0.5;

        for (const seg of segments) {
            const easeInStart = seg.tStart - seg.easeIn;
            const easeOutEnd = seg.tEnd + seg.easeOut;

            if (t < easeInStart || t > easeOutEnd) continue;

            let localFactor;
            if (t < seg.tStart) {
                // Easing in
                const p = Math.max(0, Math.min(1, (t - easeInStart) / seg.easeIn));
                localFactor = 1 + (seg.factor - 1) * this.easeInOutCubic(p);
            } else if (t > seg.tEnd) {
                // Easing out
                const p = Math.max(0, Math.min(1, (t - seg.tEnd) / seg.easeOut));
                localFactor = seg.factor - (seg.factor - 1) * this.easeInOutCubic(p);
            } else {
                // Fully inside
                localFactor = seg.factor;
            }

            if (localFactor > bestFactor) {
                bestFactor = localFactor;
                bestCx = seg.cx;
                bestCy = seg.cy;
            }
        }

        return { factor: bestFactor, cx: bestCx, cy: bestCy };
    }

    /**
     * Auto-generate zoom segments from click data.
     */
    static autoGenerateZooms(clickData, duration, options = {}) {
        const {
            zoomFactor = 2.0,
            segDuration = 2.0,
            minGap = 1.0,
            maxSegments = 40,
        } = options;

        const segments = [];
        let lastEnd = -Infinity;

        for (const click of clickData) {
            if (click.t - lastEnd < minGap) continue;
            if (segments.length >= maxSegments) break;

            const tStart = Math.max(0, click.t - 0.15);
            const tEnd = Math.min(duration, tStart + segDuration);
            const colorIdx = segments.length % this.COLORS.length;

            const seg = new ZoomSegment(tStart, tEnd, click.x, click.y, zoomFactor, this.COLORS[colorIdx]);
            seg.easeIn = 0.4;
            seg.easeOut = 0.4;
            segments.push(seg);
            lastEnd = tEnd;
        }

        return segments;
    }

    /**
     * Render a complete frame with all effects.
     * Draws: background → shadow → clipped video (with zoom) → cursor → click ripples → border
     */
    static renderFrame(ctx, source, t, segments, config) {
        const {
            outWidth, outHeight,
            padding = 48, corners = 16,
            shadow = true, shadowIntensity = 60,
            bgColor = '#13161c', bgColor2 = '#1e222b', bgType = 'gradient',
            cursorData = null, cursorSize = 1.2,
            clickData = null, clickEffects = true,
        } = config;

        const cw = outWidth;
        const ch = outHeight;

        // ── 1. Background ──
        if (bgType === 'gradient') {
            const grad = ctx.createLinearGradient(0, 0, cw, ch);
            grad.addColorStop(0, bgColor);
            grad.addColorStop(1, bgColor2);
            ctx.fillStyle = grad;
        } else {
            ctx.fillStyle = bgColor;
        }
        ctx.fillRect(0, 0, cw, ch);

        // ── 2. Calculate zoom ──
        const zoom = this.getZoomAt(t, segments);
        const { factor, cx, cy } = zoom;

        // ── 3. Screen area with padding ──
        const screenW = cw - padding * 2;
        const screenH = ch - padding * 2;
        const screenX = padding;
        const screenY = padding;

        if (screenW <= 0 || screenH <= 0) return zoom;

        // ── 4. Shadow ──
        if (shadow && shadowIntensity > 0) {
            const alpha = (shadowIntensity / 100) * 0.65;
            ctx.save();
            ctx.shadowColor = `rgba(0, 0, 0, ${alpha})`;
            ctx.shadowBlur = 50;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 12;
            this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
            ctx.fillStyle = '#000';
            ctx.fill();
            ctx.restore();
        }

        // ── 5. Clip and draw zoomed video ──
        ctx.save();
        this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
        ctx.clip();

        const sw = source.videoWidth || source.width || 1920;
        const sh = source.videoHeight || source.height || 1080;

        if (factor > 1.005) {
            // Zoomed: crop source around center point
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

        // ── 6. Cursor arrow overlay ──
        if (cursorData && cursorData.length > 0) {
            const cursor = this._interpolateCursor(t, cursorData);
            if (cursor) {
                const pos = this._mapToScreen(cursor.x, cursor.y, factor, cx, cy, screenX, screenY, screenW, screenH);
                if (pos) this._drawCursorArrow(ctx, pos.x, pos.y, cursorSize);
            }
        }

        // ── 7. Click ripples ──
        if (clickEffects && clickData) {
            for (const click of clickData) {
                const dt = t - click.t;
                if (dt < 0 || dt > 0.7) continue;
                const progress = dt / 0.7;

                const pos = this._mapToScreen(click.x, click.y, factor, cx, cy, screenX, screenY, screenW, screenH);
                if (!pos) continue;

                // Outer ring
                const r1 = 10 + 35 * this.easeOutQuart(progress);
                const a1 = (1 - progress) * 0.5;
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, r1, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(79, 143, 247, ${a1})`;
                ctx.lineWidth = 2;
                ctx.stroke();

                // Inner ring
                const r2 = 5 + 18 * this.easeOutQuart(progress);
                const a2 = (1 - progress) * 0.35;
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, r2, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(79, 143, 247, ${a2})`;
                ctx.lineWidth = 1.5;
                ctx.stroke();

                // Fill flash
                if (progress < 0.15) {
                    const fa = (1 - progress / 0.15) * 0.2;
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(79, 143, 247, ${fa})`;
                    ctx.fill();
                }
            }
        }

        ctx.restore();

        // ── 8. Subtle border ──
        ctx.save();
        this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();

        return zoom;
    }

    /**
     * Map a normalized (0-1) coordinate to screen pixel position,
     * accounting for zoom crop.
     */
    static _mapToScreen(nx, ny, factor, cx, cy, screenX, screenY, screenW, screenH) {
        let sx, sy;
        if (factor > 1.005) {
            const cropW = 1 / factor;
            const cropH = 1 / factor;
            const ox = Math.max(0, Math.min(1 - cropW, cx - cropW / 2));
            const oy = Math.max(0, Math.min(1 - cropH, cy - cropH / 2));
            sx = screenX + ((nx - ox) / cropW) * screenW;
            sy = screenY + ((ny - oy) / cropH) * screenH;
        } else {
            sx = screenX + nx * screenW;
            sy = screenY + ny * screenH;
        }
        // Check if on screen
        if (sx < screenX - 10 || sx > screenX + screenW + 10) return null;
        if (sy < screenY - 10 || sy > screenY + screenH + 10) return null;
        return { x: sx, y: sy };
    }

    /**
     * Draw a proper arrow cursor instead of a dot.
     */
    static _drawCursorArrow(ctx, x, y, scale) {
        const s = 1.0 * scale;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s, s);

        // Arrow shape (macOS-style pointer)
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 17);
        ctx.lineTo(4.5, 13.5);
        ctx.lineTo(8, 20);
        ctx.lineTo(10.5, 19);
        ctx.lineTo(7, 12.5);
        ctx.lineTo(12, 12);
        ctx.closePath();

        // White fill with black stroke
        ctx.fillStyle = 'white';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 1;
        ctx.lineJoin = 'round';
        ctx.stroke();

        ctx.restore();
    }

    /**
     * Interpolate cursor position at time t (smooth between samples).
     */
    static _interpolateCursor(t, cursorData) {
        if (!cursorData || cursorData.length === 0) return null;
        if (cursorData.length === 1) return cursorData[0];

        // Binary search
        let lo = 0, hi = cursorData.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (cursorData[mid].t <= t) lo = mid;
            else hi = mid;
        }

        const a = cursorData[lo];
        const b = cursorData[hi];
        if (a.t === b.t) return a;

        // Linear interpolation between samples
        const p = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
        return {
            x: a.x + (b.x - a.x) * p,
            y: a.y + (b.y - a.y) * p,
            t: t,
        };
    }

    static _roundRect(ctx, x, y, w, h, r) {
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
    }
}

window.ZoomSegment = ZoomSegment;
window.ZoomEngine = ZoomEngine;
