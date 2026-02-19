/**
 * ZoomCast — Zoom Engine v5
 * Features: Smart cursor follow (Screen.studio style), motion blur,
 *           cursor animation types, zoom/pan speed controls, high quality rendering
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

    // ── Motion blur sample offsets (temporal) ──
    // Each entry is {dt, alpha} — dt = seconds before current frame to sample
    static MOTION_BLUR_SAMPLES = [
        { dt: 0.000, alpha: 1.00 },
        { dt: 0.016, alpha: 0.55 },
        { dt: 0.033, alpha: 0.30 },
        { dt: 0.050, alpha: 0.18 },
        { dt: 0.066, alpha: 0.10 },
    ];

    // ── Cursor movement easing speeds ──
    static CURSOR_SPEEDS = {
        slow: { lag: 0.18, smoothing: 0.06 }, // very smooth follow
        medium: { lag: 0.10, smoothing: 0.12 },
        fast: { lag: 0.05, smoothing: 0.20 },
        rapid: { lag: 0.00, smoothing: 1.00 }, // near-instant
    };

    // ── Zoom pan speed multipliers (easing duration override) ──
    static PAN_SPEEDS = {
        slow: { easeIn: 1.2, easeOut: 1.2 },
        medium: { easeIn: 0.4, easeOut: 0.4 },
        fast: { easeIn: 0.18, easeOut: 0.18 },
        rapid: { easeIn: 0.06, easeOut: 0.06 },
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

    // ── Easing functions ──
    static easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
    static easeOutQuart(t) {
        return 1 - Math.pow(1 - t, 4);
    }
    static easeOutExpo(t) {
        return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    }
    static easeInOutQuint(t) {
        return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
    }

    /**
     * Get zoom state at time t with optional pan-speed override.
     */
    static getZoomAt(t, segments, panSpeed = 'medium') {
        const speeds = this.PAN_SPEEDS[panSpeed] || this.PAN_SPEEDS.medium;
        let bestFactor = 1.0, bestCx = 0.5, bestCy = 0.5;

        for (const seg of segments) {
            const eIn = speeds.easeIn;
            const eOut = speeds.easeOut;
            const easeInStart = seg.tStart - eIn;
            const easeOutEnd = seg.tEnd + eOut;
            if (t < easeInStart || t > easeOutEnd) continue;

            let localFactor;
            if (t < seg.tStart) {
                const p = Math.max(0, Math.min(1, (t - easeInStart) / eIn));
                localFactor = 1 + (seg.factor - 1) * this.easeInOutCubic(p);
            } else if (t > seg.tEnd) {
                const p = Math.max(0, Math.min(1, (t - seg.tEnd) / eOut));
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
     * Get smoothed cursor position following Screen.studio / FocuSee style.
     * Uses exponential smoothing based on cursorSpeed setting.
     */
    static getSmoothedCursorAt(t, cursorData, cursorSpeed = 'medium') {
        const raw = this._interpolateCursor(t, cursorData);
        if (!raw) return null;

        const speed = this.CURSOR_SPEEDS[cursorSpeed] || this.CURSOR_SPEEDS.medium;

        // If rapid, return raw position
        if (speed.lag === 0) return raw;

        // Look back by lag seconds and exponentially blend
        const prev = this._interpolateCursor(Math.max(0, t - speed.lag), cursorData);
        if (!prev) return raw;

        const alpha = speed.smoothing;
        return {
            x: raw.x * alpha + prev.x * (1 - alpha),
            y: raw.y * alpha + prev.y * (1 - alpha),
            t,
        };
    }

    /**
     * AUTO ZOOM: Compute zoom target based on cursor velocity (Screen.studio style).
     * Returns { factor, cx, cy } — if cursor moves fast → zoom towards it.
     */
    static getCursorDrivenZoom(t, cursorData, config = {}) {
        const {
            autoZoomEnabled = true,
            baseZoom = 1.0,
            maxAutoZoom = 2.0,
            velocityThreshold = 0.08,  // normalized coords/sec
            zoomSmoothLag = 0.3,       // seconds of smoothing window
            panSpeed = 'medium',
        } = config;

        if (!autoZoomEnabled || !cursorData || cursorData.length < 2) {
            return { factor: baseZoom, cx: 0.5, cy: 0.5, autoDriven: false };
        }

        // Compute cursor velocity at time t
        const dt = 0.1;
        const posNow = this._interpolateCursor(t, cursorData);
        const posPrev = this._interpolateCursor(Math.max(0, t - dt), cursorData);
        if (!posNow || !posPrev) return { factor: baseZoom, cx: 0.5, cy: 0.5, autoDriven: false };

        const vx = (posNow.x - posPrev.x) / dt;
        const vy = (posNow.y - posPrev.y) / dt;
        const vel = Math.sqrt(vx * vx + vy * vy);

        // Map velocity to zoom factor
        const velNorm = Math.min(1, vel / (velocityThreshold * 4));
        const targetFactor = baseZoom + (maxAutoZoom - baseZoom) * velNorm;

        // Smooth the zoom over time
        const prevPos = this._interpolateCursor(Math.max(0, t - zoomSmoothLag), cursorData);
        const smoothFactor = prevPos
            ? (baseZoom + (maxAutoZoom - baseZoom) * Math.min(1, Math.sqrt(
                Math.pow((posNow.x - prevPos.x) / zoomSmoothLag, 2) +
                Math.pow((posNow.y - prevPos.y) / zoomSmoothLag, 2)
            ) / velocityThreshold))
            : baseZoom;

        const factor = targetFactor * 0.3 + smoothFactor * 0.7;

        return {
            factor: Math.max(baseZoom, Math.min(maxAutoZoom, factor)),
            cx: posNow.x,
            cy: posNow.y,
            autoDriven: true,
        };
    }

    /**
     * Render a complete frame with all effects — HIGH QUALITY version.
     * Uses imageSmoothingQuality = 'high' for crystal-clear output.
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
            // Motion blur
            screenMotionBlur = false,
            zoomMotionBlur = false,
            cursorMotionBlur = false,
            // Speed controls
            cursorSpeed = 'medium',
            panSpeed = 'medium',
            // Smart cursor follow
            followCursor = true,
            autoZoomOnCursor = false,
            cursorZoomFactor = 2.0,
        } = config;

        const cw = outWidth, ch = outHeight;

        // Enable high-quality image interpolation
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // 1. Background
        this._drawBackground(ctx, cw, ch, bgType, bgColor, bgColor2);

        // 2. Get zoom state
        let zoom = this.getZoomAt(t, segments, panSpeed);

        // 3. Smart cursor-follow: if auto-zoom-on-cursor is on and no manual segment → zoom to cursor
        if (followCursor && cursorData && cursorData.length > 0) {
            if (zoom.factor <= 1.01 && autoZoomOnCursor) {
                // Use cursor position as the zoom center
                const cursor = this.getSmoothedCursorAt(t, cursorData, cursorSpeed);
                if (cursor) {
                    zoom = {
                        factor: cursorZoomFactor,
                        cx: cursor.x,
                        cy: cursor.y,
                        followMode: true,
                    };
                }
            } else if (zoom.factor > 1.01) {
                // When zoomed in via segment → track cursor position within zoom window
                const cursor = this.getSmoothedCursorAt(t, cursorData, cursorSpeed);
                if (cursor) {
                    // Pan the viewport towards the cursor smoothly
                    const panAlpha = 0.35;
                    zoom.cx = zoom.cx * (1 - panAlpha) + cursor.x * panAlpha;
                    zoom.cy = zoom.cy * (1 - panAlpha) + cursor.y * panAlpha;
                }
            }
        }

        const { factor, cx, cy } = zoom;

        // 4. Screen area
        const screenW = cw - padding * 2;
        const screenH = ch - padding * 2;
        const screenX = padding, screenY = padding;
        if (screenW <= 0 || screenH <= 0) return zoom;

        // 5. Shadow
        if (shadow && shadowIntensity > 0) {
            ctx.save();
            ctx.shadowColor = `rgba(0,0,0,${(shadowIntensity / 100) * 0.75})`;
            ctx.shadowBlur = 40 + (shadowIntensity / 100) * 40;
            ctx.shadowOffsetY = 8 + (shadowIntensity / 100) * 12;
            this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
            ctx.fillStyle = '#000';
            ctx.fill();
            ctx.restore();
        }

        // 6. Clip + draw video (with optional motion blur)
        ctx.save();
        this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
        ctx.clip();

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        if (screenMotionBlur && segments.length > 0) {
            // Draw multiple temporally-offset frames blended together for screen motion blur
            this._drawWithMotionBlur(ctx, source, t, segments, config, screenX, screenY, screenW, screenH, factor, cx, cy, panSpeed);
        } else {
            this._drawVideoFrame(ctx, source, factor, cx, cy, screenX, screenY, screenW, screenH);
        }

        // 7. Cursor overlay
        if (cursorData && cursorData.length > 0) {
            const cursor = this.getSmoothedCursorAt(t, cursorData, cursorSpeed);
            if (cursor) {
                const pos = this._mapToScreen(cursor.x, cursor.y, factor, cx, cy, screenX, screenY, screenW, screenH);
                if (pos) {
                    const isHand = this._isNearClick(t, clickData, 0.2);
                    const type = isHand ? 'hand' : 'cur';

                    if (cursorMotionBlur) {
                        this._drawCursorWithBlur(ctx, t, cursorData, factor, cx, cy, screenX, screenY, screenW, screenH, cursorSize, cursorStyle, type, cursorSpeed, clickData);
                    } else {
                        this._drawImageCursor(ctx, pos.x, pos.y, cursorSize, cursorStyle, type);
                    }
                }
            }
        }

        // 8. Click ripples
        if (clickEffects && clickData) {
            for (const click of clickData) {
                const dt = t - click.t;
                if (dt < 0 || dt > 0.7) continue;
                const p = dt / 0.7;
                const pos = this._mapToScreen(click.x, click.y, factor, cx, cy, screenX, screenY, screenW, screenH);
                if (!pos) continue;

                // Outer ring
                const r = 6 + 32 * this.easeOutQuart(p);
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(108, 92, 231, ${(1 - p) * 0.65})`;
                ctx.lineWidth = 2.5;
                ctx.stroke();

                // Inner ring (secondary)
                if (p < 0.5) {
                    const r2 = 4 + 14 * this.easeOutQuart(p * 2);
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, r2, 0, Math.PI * 2);
                    ctx.strokeStyle = `rgba(162, 155, 254, ${(1 - p * 2) * 0.4})`;
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }

                // Center fill flash
                if (p < 0.10) {
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(108, 92, 231, ${(1 - p / 0.10) * 0.5})`;
                    ctx.fill();
                }
            }
        }

        ctx.restore();

        // 9. Subtle border
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();

        return zoom;
    }

    // ── Draw Video Frame ──
    static _drawVideoFrame(ctx, source, factor, cx, cy, sx, sy, sw, sh) {
        const srcW = source.videoWidth || source.width || 1920;
        const srcH = source.videoHeight || source.height || 1080;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        if (factor > 1.005) {
            const cropW = srcW / factor;
            const cropH = srcH / factor;
            const px = cx * srcW;
            const py = cy * srcH;
            const sxc = Math.max(0, Math.min(srcW - cropW, px - cropW / 2));
            const syc = Math.max(0, Math.min(srcH - cropH, py - cropH / 2));
            ctx.drawImage(source, sxc, syc, cropW, cropH, sx, sy, sw, sh);
        } else {
            ctx.drawImage(source, 0, 0, srcW, srcH, sx, sy, sw, sh);
        }
    }

    // ── Screen Motion Blur ──
    static _drawWithMotionBlur(ctx, source, t, segments, config, sx, sy, sw, sh, factor, cx, cy, panSpeed) {
        // Draw the main frame first (fully opaque)
        this._drawVideoFrame(ctx, source, factor, cx, cy, sx, sy, sw, sh);

        // Composite temporal ghost frames on top with decreasing opacity
        const samples = this.MOTION_BLUR_SAMPLES.slice(1); // skip dt=0 (main frame)
        for (const sample of samples) {
            const prevT = Math.max(0, t - sample.dt);
            const prevZoom = this.getZoomAt(prevT, segments, panSpeed);

            // Only blur if zoom state differs (pan/zoom in progress)
            const zoomDelta = Math.abs(prevZoom.factor - factor) + Math.abs(prevZoom.cx - cx) * 2 + Math.abs(prevZoom.cy - cy) * 2;
            if (zoomDelta < 0.01) continue;

            ctx.save();
            ctx.globalAlpha = sample.alpha * Math.min(1, zoomDelta * 4);
            ctx.globalCompositeOperation = 'source-over';
            this._drawVideoFrame(ctx, source, prevZoom.factor, prevZoom.cx, prevZoom.cy, sx, sy, sw, sh);
            ctx.restore();
        }
    }

    // ── Cursor Motion Blur ──
    static _drawCursorWithBlur(ctx, t, cursorData, factor, cx, cy, sx, sy, sw, sh, cursorSize, cursorStyle, type, cursorSpeed, clickData) {
        // Draw ghost cursors at previous positions
        const blurSamples = [
            { dt: 0.050, alpha: 0.18 },
            { dt: 0.033, alpha: 0.30 },
            { dt: 0.016, alpha: 0.55 },
        ];

        for (const s of blurSamples) {
            const prevCursor = this.getSmoothedCursorAt(Math.max(0, t - s.dt), cursorData, cursorSpeed);
            if (!prevCursor) continue;
            const pos = this._mapToScreen(prevCursor.x, prevCursor.y, factor, cx, cy, sx, sy, sw, sh);
            if (!pos) continue;
            ctx.save();
            ctx.globalAlpha = s.alpha;
            this._drawImageCursor(ctx, pos.x, pos.y, cursorSize, cursorStyle, type);
            ctx.restore();
        }

        // Draw main cursor (full alpha)
        const cursor = this.getSmoothedCursorAt(t, cursorData, cursorSpeed);
        if (cursor) {
            const pos = this._mapToScreen(cursor.x, cursor.y, factor, cx, cy, sx, sy, sw, sh);
            if (pos) {
                this._drawImageCursor(ctx, pos.x, pos.y, cursorSize, cursorStyle, type);
            }
        }
    }

    // ── Background Drawing ──
    static _drawBackground(ctx, cw, ch, bgType, bgColor, bgColor2) {
        if (bgType === 'gradient') {
            const grad = ctx.createLinearGradient(0, 0, cw, ch);
            grad.addColorStop(0, bgColor);
            grad.addColorStop(1, bgColor2);
            ctx.fillStyle = grad;
        } else if (bgType === 'radial') {
            const grad = ctx.createRadialGradient(cw / 2, ch / 2, 0, cw / 2, ch / 2, Math.max(cw, ch) / 1.5);
            grad.addColorStop(0, bgColor2);
            grad.addColorStop(1, bgColor);
            ctx.fillStyle = grad;
        } else {
            ctx.fillStyle = bgColor;
        }
        ctx.fillRect(0, 0, cw, ch);
    }

    // ── Image cursor drawing ──
    static BASE_CURSOR_PX = 32;

    static _drawImageCursor(ctx, x, y, scale, styleKey, type) {
        const images = this._cursorImages[styleKey];
        if (!images || !images[type]) return;
        const img = images[type];
        if (!img.complete || img.naturalWidth === 0) return;

        const drawH = this.BASE_CURSOR_PX * scale;
        const drawW = drawH * (img.naturalWidth / img.naturalHeight);

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        if (type === 'cur') {
            ctx.drawImage(img, x, y, drawW, drawH);
        } else {
            ctx.drawImage(img, x - drawW * 0.28, y, drawW, drawH);
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
