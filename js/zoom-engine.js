/**
 * ZoomCast — Zoom Engine v4
 * Image-based cursors, fast rendering, smooth zoom.
 */

class ZoomSegment {
    constructor(tStart, tEnd, cx, cy, factor = 2.0, color = '#6C5CE7') {
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
    static COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#FDCB6E', '#E84393', '#00CEC9', '#FF7675'];

    // ── Cursor image cache ──
    static _cursorImages = {};
    static _cursorLoaded = false;

    static CURSOR_STYLES = {
        'style1': {
            label: 'Default',
            cur: 'assets/style1cur.png',
            hand: 'assets/style1hand.png',
            text: 'assets/style1text.png',
        },
    };

    /**
     * Preload all cursor images. Call once at startup.
     */
    static async preloadCursors() {
        const promises = [];
        for (const [key, style] of Object.entries(this.CURSOR_STYLES)) {
            for (const type of ['cur', 'hand', 'text']) {
                if (!style[type]) continue;
                const img = new Image();
                img.src = style[type];
                const p = new Promise((resolve) => {
                    img.onload = () => resolve();
                    img.onerror = () => resolve();
                });
                promises.push(p);
                if (!this._cursorImages[key]) this._cursorImages[key] = {};
                this._cursorImages[key][type] = img;
            }
        }
        await Promise.all(promises);
        this._cursorLoaded = true;
    }

    // Easing
    static easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
    static easeOutQuart(t) {
        return 1 - Math.pow(1 - t, 4);
    }

    static getZoomAt(t, segments) {
        let bestFactor = 1.0, bestCx = 0.5, bestCy = 0.5;
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

    static autoGenerateZooms(clickData, duration, options = {}) {
        const { zoomFactor = 2.0, segDuration = 2.0, minGap = 1.0, maxSegments = 40 } = options;
        const segments = [];
        let lastEnd = -Infinity;
        for (const click of clickData) {
            if (click.t - lastEnd < minGap) continue;
            if (segments.length >= maxSegments) break;
            const tStart = Math.max(0, click.t - 0.15);
            const tEnd = Math.min(duration, tStart + segDuration);
            const seg = new ZoomSegment(tStart, tEnd, click.x, click.y, zoomFactor, this.COLORS[segments.length % this.COLORS.length]);
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
            bgColor = '#1a1a1a', bgColor2 = '#111111', bgType = 'gradient',
            cursorData = null, cursorSize = 1.0,
            cursorStyle = 'style1',
            clickData = null, clickEffects = true,
        } = config;

        const cw = outWidth, ch = outHeight;

        // 1. Background
        if (bgType === 'gradient') {
            const grad = ctx.createLinearGradient(0, 0, cw, ch);
            grad.addColorStop(0, bgColor);
            grad.addColorStop(1, bgColor2);
            ctx.fillStyle = grad;
        } else {
            ctx.fillStyle = bgColor;
        }
        ctx.fillRect(0, 0, cw, ch);

        // 2. Zoom calc
        const zoom = this.getZoomAt(t, segments);
        const { factor, cx, cy } = zoom;

        // 3. Screen area
        const screenW = cw - padding * 2;
        const screenH = ch - padding * 2;
        const screenX = padding, screenY = padding;
        if (screenW <= 0 || screenH <= 0) return zoom;

        // 4. Shadow
        if (shadow && shadowIntensity > 0) {
            ctx.save();
            ctx.shadowColor = `rgba(0,0,0,${(shadowIntensity / 100) * 0.7})`;
            ctx.shadowBlur = 60;
            ctx.shadowOffsetY = 15;
            this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
            ctx.fillStyle = '#000';
            ctx.fill();
            ctx.restore();
        }

        // 5. Clip + draw video
        ctx.save();
        this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
        ctx.clip();

        const sw = source.videoWidth || source.width || 1920;
        const sh = source.videoHeight || source.height || 1080;

        if (factor > 1.005) {
            const cropW = sw / factor, cropH = sh / factor;
            const px = cx * sw, py = cy * sh;
            const sx = Math.max(0, Math.min(sw - cropW, px - cropW / 2));
            const sy = Math.max(0, Math.min(sh - cropH, py - cropH / 2));
            ctx.drawImage(source, sx, sy, cropW, cropH, screenX, screenY, screenW, screenH);
        } else {
            ctx.drawImage(source, 0, 0, sw, sh, screenX, screenY, screenW, screenH);
        }

        // 6. Cursor overlay (image-based)
        if (cursorData && cursorData.length > 0) {
            const cursor = this._interpolateCursor(t, cursorData);
            if (cursor) {
                const pos = this._mapToScreen(cursor.x, cursor.y, factor, cx, cy, screenX, screenY, screenW, screenH);
                if (pos) {
                    const isHand = this._isNearClick(t, clickData, 0.2);
                    const type = isHand ? 'hand' : 'cur';
                    this._drawImageCursor(ctx, pos.x, pos.y, cursorSize, cursorStyle, type);
                }
            }
        }

        // 7. Click ripples
        if (clickEffects && clickData) {
            for (const click of clickData) {
                const dt = t - click.t;
                if (dt < 0 || dt > 0.6) continue;
                const p = dt / 0.6;
                const pos = this._mapToScreen(click.x, click.y, factor, cx, cy, screenX, screenY, screenW, screenH);
                if (!pos) continue;

                // Ring
                const r = 8 + 30 * this.easeOutQuart(p);
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(108, 92, 231, ${(1 - p) * 0.6})`;
                ctx.lineWidth = 2.5;
                ctx.stroke();

                // Fill flash
                if (p < 0.12) {
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(108, 92, 231, ${(1 - p / 0.12) * 0.3})`;
                    ctx.fill();
                }
            }
        }

        ctx.restore();

        // 8. Border
        ctx.save();
        this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();

        return zoom;
    }

    // ── Image cursor drawing ──
    static _drawImageCursor(ctx, x, y, scale, styleKey, type) {
        const images = this._cursorImages[styleKey];
        if (!images || !images[type]) return;
        const img = images[type];
        if (!img.complete || img.naturalWidth === 0) return;

        const size = Math.max(img.naturalWidth, img.naturalHeight);
        const drawSize = size * scale;
        // Hotspot: top-left for arrow cursor, center for hand
        if (type === 'cur') {
            ctx.drawImage(img, x, y, drawSize, drawSize * (img.naturalHeight / img.naturalWidth));
        } else {
            ctx.drawImage(img, x - drawSize * 0.35, y - drawSize * 0.1, drawSize, drawSize * (img.naturalHeight / img.naturalWidth));
        }
    }

    // ── Preview for cursor picker ──
    static drawCursorPreview(canvas, styleKey) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#242424';
        ctx.fillRect(0, 0, w, h);

        const images = this._cursorImages[styleKey];
        if (!images) return;

        // Draw each cursor type
        const types = ['cur', 'hand', 'text'];
        const spacing = w / (types.length + 1);
        types.forEach((type, i) => {
            const img = images[type];
            if (!img || !img.complete) return;
            const s = 0.55;
            const dw = img.naturalWidth * s;
            const dh = img.naturalHeight * s;
            ctx.drawImage(img, spacing * (i + 1) - dw / 2, (h - dh) / 2, dw, dh);
        });
    }

    // ── Utility ──
    static _isNearClick(t, clickData, threshold) {
        if (!clickData || !clickData.length) return false;
        for (const c of clickData) {
            if (Math.abs(t - c.t) < threshold) return true;
        }
        return false;
    }

    static _mapToScreen(nx, ny, factor, cx, cy, sx, sy, sw, sh) {
        let x, y;
        if (factor > 1.005) {
            const cw = 1 / factor, ch = 1 / factor;
            const ox = Math.max(0, Math.min(1 - cw, cx - cw / 2));
            const oy = Math.max(0, Math.min(1 - ch, cy - ch / 2));
            x = sx + ((nx - ox) / cw) * sw;
            y = sy + ((ny - oy) / ch) * sh;
        } else {
            x = sx + nx * sw;
            y = sy + ny * sh;
        }
        if (x < sx - 20 || x > sx + sw + 20 || y < sy - 20 || y > sy + sh + 20) return null;
        return { x, y };
    }

    static _interpolateCursor(t, data) {
        if (!data || !data.length) return null;
        if (data.length === 1) return data[0];
        let lo = 0, hi = data.length - 1;
        while (lo < hi - 1) {
            const m = (lo + hi) >> 1;
            if (data[m].t <= t) lo = m; else hi = m;
        }
        const a = data[lo], b = data[hi];
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
