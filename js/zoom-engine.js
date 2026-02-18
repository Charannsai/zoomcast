/**
 * ZoomCast — Zoom Engine v3
 * Smooth zoom effects with multiple cursor styles, auto pointer/hand switching,
 * enhanced easing, and frame composition.
 */

class ZoomSegment {
    constructor(tStart, tEnd, cx, cy, factor = 2.0, color = '#4f8ff7') {
        this.tStart = tStart;
        this.tEnd = tEnd;
        this.cx = cx;
        this.cy = cy;
        this.factor = factor;
        this.color = color;
        this.label = '';
        this.easeIn = 0.4;
        this.easeOut = 0.4;
    }
}

class ZoomEngine {
    static COLORS = ['#4f8ff7', '#9678f6', '#34d399', '#f5a623', '#f06060', '#ec4899', '#38d9e8', '#f97316'];

    // ── Cursor Style Registry ──
    static CURSOR_STYLES = {
        'macos-white': { label: 'macOS White', group: 'Classic' },
        'macos-black': { label: 'macOS Black', group: 'Classic' },
        'windows': { label: 'Windows', group: 'Classic' },
        'minimal': { label: 'Minimal Dot', group: 'Modern' },
        'neon': { label: 'Neon Blue', group: 'Modern' },
        'outlined': { label: 'Outlined', group: 'Modern' },
    };

    // Easing functions
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
                const p = Math.max(0, Math.min(1, (t - easeInStart) / seg.easeIn));
                localFactor = 1 + (seg.factor - 1) * this.easeInOutCubic(p);
            } else if (t > seg.tEnd) {
                const p = Math.max(0, Math.min(1, (t - seg.tEnd) / seg.easeOut));
                localFactor = seg.factor - (seg.factor - 1) * this.easeInOutCubic(p);
            } else {
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
     */
    static renderFrame(ctx, source, t, segments, config) {
        const {
            outWidth, outHeight,
            padding = 48, corners = 16,
            shadow = true, shadowIntensity = 60,
            bgColor = '#13161c', bgColor2 = '#1e222b', bgType = 'gradient',
            cursorData = null, cursorSize = 1.2,
            cursorStyle = 'macos-white',
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

        // ── 6. Cursor overlay ──
        if (cursorData && cursorData.length > 0) {
            const cursor = this._interpolateCursor(t, cursorData);
            if (cursor) {
                const pos = this._mapToScreen(cursor.x, cursor.y, factor, cx, cy, screenX, screenY, screenW, screenH);
                if (pos) {
                    // Auto-detect hand mode: show hand cursor within ±0.25s of any click
                    const isHand = this._isNearClick(t, clickData, 0.25);
                    this._drawCursor(ctx, pos.x, pos.y, cursorSize, cursorStyle, isHand);
                }
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

                const r1 = 10 + 35 * this.easeOutQuart(progress);
                const a1 = (1 - progress) * 0.5;
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, r1, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(79, 143, 247, ${a1})`;
                ctx.lineWidth = 2;
                ctx.stroke();

                const r2 = 5 + 18 * this.easeOutQuart(progress);
                const a2 = (1 - progress) * 0.35;
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, r2, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(79, 143, 247, ${a2})`;
                ctx.lineWidth = 1.5;
                ctx.stroke();

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

    // ═══════════════════════════════════════════════════════════════
    // CURSOR DRAWING — All styles
    // ═══════════════════════════════════════════════════════════════

    /**
     * Draw cursor with the selected style.
     * @param {string} style - Style key from CURSOR_STYLES
     * @param {boolean} isHand - Whether to show hand/pointer finger
     */
    static _drawCursor(ctx, x, y, scale, style, isHand) {
        switch (style) {
            case 'macos-white':
                isHand ? this._drawHandMacOS(ctx, x, y, scale, '#fff', 'rgba(0,0,0,0.65)') :
                    this._drawArrowMacOS(ctx, x, y, scale, '#fff', 'rgba(0,0,0,0.65)');
                break;
            case 'macos-black':
                isHand ? this._drawHandMacOS(ctx, x, y, scale, '#1a1a1a', 'rgba(255,255,255,0.8)') :
                    this._drawArrowMacOS(ctx, x, y, scale, '#1a1a1a', 'rgba(255,255,255,0.8)');
                break;
            case 'windows':
                isHand ? this._drawHandWindows(ctx, x, y, scale) :
                    this._drawArrowWindows(ctx, x, y, scale);
                break;
            case 'minimal':
                isHand ? this._drawHandMinimal(ctx, x, y, scale) :
                    this._drawDotMinimal(ctx, x, y, scale);
                break;
            case 'neon':
                isHand ? this._drawHandNeon(ctx, x, y, scale) :
                    this._drawArrowNeon(ctx, x, y, scale);
                break;
            case 'outlined':
                isHand ? this._drawHandOutlined(ctx, x, y, scale) :
                    this._drawArrowOutlined(ctx, x, y, scale);
                break;
            default:
                this._drawArrowMacOS(ctx, x, y, scale, '#fff', 'rgba(0,0,0,0.65)');
        }
    }

    // ─── macOS Style Arrow ───
    static _drawArrowMacOS(ctx, x, y, scale, fill, stroke) {
        const s = scale;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s, s);

        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 18);
        ctx.lineTo(4.5, 14);
        ctx.lineTo(8, 21);
        ctx.lineTo(10.5, 20);
        ctx.lineTo(7, 13);
        ctx.lineTo(12, 12.5);
        ctx.closePath();

        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        ctx.restore();
    }

    // ─── macOS Style Hand ───
    static _drawHandMacOS(ctx, x, y, scale, fill, stroke) {
        const s = scale * 0.9;
        ctx.save();
        ctx.translate(x - 5 * s, y - 1 * s);
        ctx.scale(s, s);

        // Index finger pointing up
        ctx.beginPath();
        ctx.moveTo(8, 0);
        ctx.lineTo(6.5, 0.5);
        ctx.lineTo(6, 8);
        // Other fingers curled
        ctx.lineTo(3, 9);
        ctx.lineTo(2, 10.5);
        ctx.lineTo(1, 12);
        ctx.lineTo(0.5, 15);
        ctx.lineTo(1, 17);
        ctx.lineTo(2.5, 19);
        ctx.lineTo(5, 21);
        ctx.lineTo(9, 22);
        ctx.lineTo(12, 21);
        ctx.lineTo(14, 19);
        ctx.lineTo(14.5, 16);
        ctx.lineTo(14, 13);
        ctx.lineTo(13, 11);
        ctx.lineTo(12, 9);
        ctx.lineTo(10, 8);
        ctx.lineTo(10, 0.5);
        ctx.lineTo(8.5, 0);
        ctx.closePath();

        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Finger detail lines
        ctx.beginPath();
        ctx.moveTo(6.5, 10);
        ctx.lineTo(6.5, 14);
        ctx.moveTo(9.5, 10);
        ctx.lineTo(9.5, 14);
        ctx.moveTo(12, 11);
        ctx.lineTo(12, 14);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 0.6;
        ctx.stroke();

        ctx.restore();
    }

    // ─── Windows Style Arrow ───
    static _drawArrowWindows(ctx, x, y, scale) {
        const s = scale;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s, s);

        // Classic Windows arrow (wider, asymmetric)
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 20);
        ctx.lineTo(5, 16);
        ctx.lineTo(8, 22);
        ctx.lineTo(11, 21);
        ctx.lineTo(8, 15);
        ctx.lineTo(14, 14);
        ctx.closePath();

        // Black fill with white inset
        ctx.fillStyle = '#000';
        ctx.fill();

        // White inner arrow
        ctx.beginPath();
        ctx.moveTo(2, 3);
        ctx.lineTo(2, 17);
        ctx.lineTo(5.5, 14);
        ctx.lineTo(8.5, 20);
        ctx.lineTo(9.5, 19.5);
        ctx.lineTo(6.5, 13.5);
        ctx.lineTo(11, 13);
        ctx.closePath();
        ctx.fillStyle = '#fff';
        ctx.fill();

        ctx.restore();
    }

    // ─── Windows Style Hand ───
    static _drawHandWindows(ctx, x, y, scale) {
        const s = scale * 0.85;
        ctx.save();
        ctx.translate(x - 4 * s, y);
        ctx.scale(s, s);

        ctx.beginPath();
        ctx.moveTo(7.5, 0);
        ctx.lineTo(6, 0.8);
        ctx.lineTo(5.5, 8);
        ctx.lineTo(3, 9.5);
        ctx.lineTo(1.5, 11);
        ctx.lineTo(0.5, 14);
        ctx.lineTo(1, 17);
        ctx.lineTo(3, 20);
        ctx.lineTo(6, 22);
        ctx.lineTo(10, 22);
        ctx.lineTo(13, 20);
        ctx.lineTo(14, 17);
        ctx.lineTo(14, 13);
        ctx.lineTo(13, 10);
        ctx.lineTo(11, 8.5);
        ctx.lineTo(10, 8);
        ctx.lineTo(9.5, 0.8);
        ctx.lineTo(8, 0);
        ctx.closePath();

        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.stroke();

        ctx.restore();
    }

    // ─── Minimal Dot ───
    static _drawDotMinimal(ctx, x, y, scale) {
        const r = 5 * scale;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    // ─── Minimal Hand (ring) ───
    static _drawHandMinimal(ctx, x, y, scale) {
        const r = 7 * scale;
        // Outer ring
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2 * scale;
        ctx.stroke();
        // Center dot
        ctx.beginPath();
        ctx.arc(x, y, 2.5 * scale, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fill();
    }

    // ─── Neon Arrow ───
    static _drawArrowNeon(ctx, x, y, scale) {
        const s = scale;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s, s);

        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 18);
        ctx.lineTo(4.5, 14);
        ctx.lineTo(8, 21);
        ctx.lineTo(10.5, 20);
        ctx.lineTo(7, 13);
        ctx.lineTo(12, 12.5);
        ctx.closePath();

        // Glow
        ctx.shadowColor = '#4f8ff7';
        ctx.shadowBlur = 12;
        ctx.fillStyle = '#4f8ff7';
        ctx.fill();
        ctx.shadowBlur = 0;

        // Bright inner
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fill();

        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 0.8;
        ctx.lineJoin = 'round';
        ctx.stroke();

        ctx.restore();
    }

    // ─── Neon Hand ───
    static _drawHandNeon(ctx, x, y, scale) {
        const r = 7 * scale;
        ctx.save();

        // Glow ring
        ctx.shadowColor = '#4f8ff7';
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.strokeStyle = '#4f8ff7';
        ctx.lineWidth = 2.5 * scale;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Inner glow
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1 * scale;
        ctx.stroke();

        // Center
        ctx.beginPath();
        ctx.arc(x, y, 2 * scale, 0, Math.PI * 2);
        ctx.fillStyle = '#4f8ff7';
        ctx.fill();

        ctx.restore();
    }

    // ─── Outlined Arrow ───
    static _drawArrowOutlined(ctx, x, y, scale) {
        const s = scale;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s, s);

        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 18);
        ctx.lineTo(4.5, 14);
        ctx.lineTo(8, 21);
        ctx.lineTo(10.5, 20);
        ctx.lineTo(7, 13);
        ctx.lineTo(12, 12.5);
        ctx.closePath();

        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.stroke();

        ctx.restore();
    }

    // ─── Outlined Hand ───
    static _drawHandOutlined(ctx, x, y, scale) {
        const s = scale * 0.85;
        ctx.save();
        ctx.translate(x - 5 * s, y - 1 * s);
        ctx.scale(s, s);

        ctx.beginPath();
        ctx.moveTo(8, 0);
        ctx.lineTo(6.5, 0.5);
        ctx.lineTo(6, 8);
        ctx.lineTo(3, 9);
        ctx.lineTo(2, 10.5);
        ctx.lineTo(1, 12);
        ctx.lineTo(0.5, 15);
        ctx.lineTo(1, 17);
        ctx.lineTo(2.5, 19);
        ctx.lineTo(5, 21);
        ctx.lineTo(9, 22);
        ctx.lineTo(12, 21);
        ctx.lineTo(14, 19);
        ctx.lineTo(14.5, 16);
        ctx.lineTo(14, 13);
        ctx.lineTo(13, 11);
        ctx.lineTo(12, 9);
        ctx.lineTo(10, 8);
        ctx.lineTo(10, 0.5);
        ctx.lineTo(8.5, 0);
        ctx.closePath();

        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.3;
        ctx.lineJoin = 'round';
        ctx.stroke();

        ctx.restore();
    }

    // ═══════════════════════════════════════════════════════════════
    // CURSOR PREVIEW — For the style picker thumbnails
    // ═══════════════════════════════════════════════════════════════

    /**
     * Draw a cursor preview pair (pointer + hand) on a small canvas.
     */
    static drawCursorPreview(canvas, styleKey) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Background
        ctx.fillStyle = '#191d25';
        ctx.fillRect(0, 0, w, h);

        // Draw pointer on left
        this._drawCursor(ctx, w * 0.3, h * 0.45, 0.8, styleKey, false);
        // Draw hand on right
        this._drawCursor(ctx, w * 0.7, h * 0.45, 0.8, styleKey, true);
    }

    // ═══════════════════════════════════════════════════════════════
    // UTILITY METHODS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Check if time t is near any click event (for pointer→hand transition).
     */
    static _isNearClick(t, clickData, threshold) {
        if (!clickData || clickData.length === 0) return false;
        for (const click of clickData) {
            if (Math.abs(t - click.t) < threshold) return true;
        }
        return false;
    }

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
        if (sx < screenX - 10 || sx > screenX + screenW + 10) return null;
        if (sy < screenY - 10 || sy > screenY + screenH + 10) return null;
        return { x: sx, y: sy };
    }

    static _interpolateCursor(t, cursorData) {
        if (!cursorData || cursorData.length === 0) return null;
        if (cursorData.length === 1) return cursorData[0];

        let lo = 0, hi = cursorData.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (cursorData[mid].t <= t) lo = mid;
            else hi = mid;
        }

        const a = cursorData[lo];
        const b = cursorData[hi];
        if (a.t === b.t) return a;

        const p = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
        return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, t };
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
