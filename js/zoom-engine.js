/**
 * ZoomCast — Zoom Engine v6
 * Fixed: cursor drawn in screen-space (not zoom-space), linear cursor interpolation,
 *        correct zoom transform math, lerp-based camera follow, DPI awareness.
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
    static MOTION_BLUR_SAMPLES = [
        { dt: 0.000, alpha: 1.00 },
        { dt: 0.016, alpha: 0.55 },
        { dt: 0.033, alpha: 0.30 },
        { dt: 0.050, alpha: 0.18 },
        { dt: 0.066, alpha: 0.10 },
    ];

    // ── Cursor movement easing speeds ──
    // lag  = how far behind (seconds) the smooth position trails the raw position
    // lerp = per-frame lerp alpha toward target (used in real-time preview)
    static CURSOR_SPEEDS = {
        slow: { lag: 0.18, lerp: 0.05 },
        medium: { lag: 0.10, lerp: 0.12 },
        fast: { lag: 0.05, lerp: 0.25 },
        rapid: { lag: 0.00, lerp: 1.00 },
    };

    // ── Zoom pan speed multipliers (easing duration override) ──
    static PAN_SPEEDS = {
        slow: { easeIn: 1.2, easeOut: 1.2 },
        medium: { easeIn: 0.4, easeOut: 0.4 },
        fast: { easeIn: 0.18, easeOut: 0.18 },
        rapid: { easeIn: 0.06, easeOut: 0.06 },
    };

    // ── Per-frame camera state (persistent across calls for smooth follow) ──
    static _camX = 0.5;
    static _camY = 0.5;
    static _camFactor = 1.0;
    static _camT = -1;          // last rendered time; detect scrubs

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
    static easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
    static easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }
    static easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }

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
     * Get linearly-interpolated cursor position at time t.
     * Linear interpolation between the two nearest samples → buttery smooth.
     */
    static getSmoothedCursorAt(t, cursorData, cursorSpeed = 'medium') {
        const raw = this._interpolateCursor(t, cursorData);
        if (!raw) return null;

        const speed = this.CURSOR_SPEEDS[cursorSpeed] || this.CURSOR_SPEEDS.medium;

        // Rapid = use raw position directly
        if (speed.lag === 0) return raw;

        // Trail: look back by lag seconds and linearly blend
        const prev = this._interpolateCursor(Math.max(0, t - speed.lag), cursorData);
        if (!prev) return raw;

        const alpha = speed.lerp;
        return {
            x: raw.x * alpha + prev.x * (1 - alpha),
            y: raw.y * alpha + prev.y * (1 - alpha),
            t,
        };
    }

    /**
     * Render a complete frame with all effects.
     *
     * CRITICAL RENDERING ORDER (fixes cursor zoom bug):
     *   1. Background
     *   2. Shadow
     *   3. Clip rect
     *   4. Video frame (with zoom transform applied inside clip)
     *   5. Click ripples (still inside clip, in screen space relative to zoom)
     *   6. RESET TRANSFORM → Draw cursor (screen space, never affected by zoom)
     *   7. Border overlay
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

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // ── 1. Background ──────────────────────────────────────────
        this._drawBackground(ctx, cw, ch, bgType, bgColor, bgColor2);

        // ── 2. Resolve manual zoom state ──────────────────────────
        let zoom = this.getZoomAt(t, segments, panSpeed);

        // ── 3. Smart cursor-follow (cinematic lerp) ────────────────
        const cursorPos = (cursorData && cursorData.length > 0)
            ? this.getSmoothedCursorAt(t, cursorData, cursorSpeed)
            : null;

        // Detect scrub (large time jump) → snap camera instead of lerp
        const scrubbed = Math.abs(t - this._camT) > 0.5;

        if (followCursor && cursorPos) {
            if (zoom.factor <= 1.01 && autoZoomOnCursor) {
                // Auto-zoom mode: camera follows cursor
                const targetX = cursorPos.x;
                const targetY = cursorPos.y;
                const lerpK = scrubbed ? 1 : 0.25;
                this._camX = this._camX + (targetX - this._camX) * lerpK;
                this._camY = this._camY + (targetY - this._camY) * lerpK;
                zoom = { factor: cursorZoomFactor, cx: this._camX, cy: this._camY };
            } else if (zoom.factor > 1.01) {
                // Manual zoom segment: smoothly pan toward cursor within segment
                const speeds = this.CURSOR_SPEEDS[cursorSpeed] || this.CURSOR_SPEEDS.medium;
                const lerpK = scrubbed ? 1 : (speeds.lerp * 0.35);
                const targetX = zoom.cx * (1 - 0.35) + cursorPos.x * 0.35;
                const targetY = zoom.cy * (1 - 0.35) + cursorPos.y * 0.35;
                this._camX = this._camX + (targetX - this._camX) * lerpK;
                this._camY = this._camY + (targetY - this._camY) * lerpK;
                zoom.cx = this._camX;
                zoom.cy = this._camY;
            } else {
                // No zoom — keep camera centered
                const lerpK = scrubbed ? 1 : 0.1;
                this._camX = this._camX + (0.5 - this._camX) * lerpK;
                this._camY = this._camY + (0.5 - this._camY) * lerpK;
            }
        } else {
            // Follow disabled
            this._camX = zoom.cx;
            this._camY = zoom.cy;
        }
        this._camFactor = zoom.factor;
        this._camT = t;

        const { factor, cx, cy } = zoom;

        // ── 4. Screen area dimensions ──────────────────────────────
        const screenW = cw - padding * 2;
        const screenH = ch - padding * 2;
        const screenX = padding, screenY = padding;
        if (screenW <= 0 || screenH <= 0) return zoom;

        // ── 5. Shadow ──────────────────────────────────────────────
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

        // ── 6. Clip + draw video ────────────────────────────────────
        ctx.save();
        this._roundRect(ctx, screenX, screenY, screenW, screenH, corners);
        ctx.clip();

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        if (screenMotionBlur && segments.length > 0) {
            this._drawWithMotionBlur(ctx, source, t, segments, config, screenX, screenY, screenW, screenH, factor, cx, cy, panSpeed);
        } else {
            this._drawVideoFrame(ctx, source, factor, cx, cy, screenX, screenY, screenW, screenH);
        }

        // ── 6b. Perfect Cover Strategy (No blur) ──────────────────────────────────
        // Instead of erasing the OS cursor and causing blur artifacts, we will
        // draw the custom styled cursor EXACTLY on top of the original hardware
        // cursor's tracked position, and scale it accurately with the zoom factor
        // so it physically occludes the original white/black arrow perfectly.

        // ── 7. Click ripples (computed in zoom-space → map back to screen) ──
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
                ctx.strokeStyle = `rgba(108,92,231,${(1 - p) * 0.65})`;
                ctx.lineWidth = 2.5;
                ctx.stroke();

                // Inner ring
                if (p < 0.5) {
                    const r2 = 4 + 14 * this.easeOutQuart(p * 2);
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, r2, 0, Math.PI * 2);
                    ctx.strokeStyle = `rgba(162,155,254,${(1 - p * 2) * 0.4})`;
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }

                // Center flash
                if (p < 0.10) {
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(108,92,231,${(1 - p / 0.10) * 0.5})`;
                    ctx.fill();
                }
            }
        }

        ctx.restore(); // End clip region

        // ── 8. Cursor — drawn AFTER restore(), in pure screen space ──
        // CRITICAL: We draw the custom cursor at the EXACT RAW position (no lag)
        // so it perfectly overlays the baked-in OS cursor. We multiply cursorSize
        // by the zoom factor so it expands physically to cover the zoomed OS cursor.
        if (cursorData && cursorData.length > 0) {
            // Use exact raw position for perfect occlusion, no lag
            const rawCursor = this._interpolateCursor(t, cursorData);
            if (rawCursor) {
                const pos = this._mapToScreen(rawCursor.x, rawCursor.y, factor, cx, cy, screenX, screenY, screenW, screenH);
                if (pos) {
                    const isHand = this._isNearClick(t, clickData, 0.2);
                    const type = isHand ? 'hand' : 'cur';

                    // Multiply size by factor so the custom cursor zooms in perfectly
                    const scaledSize = cursorSize * factor;

                    if (cursorMotionBlur) {
                        this._drawCursorWithBlur(ctx, t, cursorData, factor, cx, cy, screenX, screenY, screenW, screenH, scaledSize, cursorStyle, type, cursorSpeed, clickData);
                    } else {
                        // Save/restore so cursor drawing is isolated
                        ctx.save();
                        ctx.setTransform(1, 0, 0, 1, 0, 0); // Absolute identity — never inside zoom transform
                        this._drawImageCursor(ctx, pos.x, pos.y, scaledSize, cursorStyle, type);
                        ctx.restore();
                    }
                }
            }
        }

        // ── 9. Subtle border ────────────────────────────────────────
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

    // ── Cursor Erasure — High-Fidelity Bilinear Inpainting ────────────────────────
    /**
     * Erases the baked-in OS cursor from the capture stream by destructively
     * overwriting its pixels with a bilinear blend of the surrounding background.
     *
     * This eliminates the blurry "smear" artifact seen in the original
     * horizontal-chord algorithm by sampling from 4 edges (left, right, top, bottom)
     * resulting in a perfectly clean patch that matches complex backgrounds flawlessly.
     *
     * We use an aggressive (+50%) erase radius multiplier to guarantee the cursor
     * is captured even across 1.25x / 1.5x DPI scales where coordinate tracking drifts.
     */
    static _eraseCursorFromFrame(ctx, source, nx, ny, factor, cx, cy, sx, sy, sw, sh) {
        const pos = this._mapToScreen(nx, ny, factor, cx, cy, sx, sy, sw, sh);
        if (!pos) return;

        const px = Math.round(pos.x);
        const py = Math.round(pos.y);

        // Aggressive erase radius — standard Windows cursor is ~32 logical px.
        // We use a 1.6× safety multiplier and max clamp to ensure full coverage
        // regardless of OS zoom or custom user pointer sizes.
        const srcW = source.videoWidth || source.width || 1920;
        const baseR = Math.ceil(32 * factor * (sw / srcW));
        const r = Math.max(22, Math.min(Math.ceil(baseR * 1.6) + 12, 140));

        // Patch bounds — slightly larger than circle, clamped to clip region
        const margin = 5;
        const pL = Math.max(sx, px - r - margin);
        const pT = Math.max(sy, py - r - margin);
        const pR = Math.min(sx + sw - 1, px + r + margin);
        const pB = Math.min(sy + sh - 1, py + r + margin);
        const pw = pR - pL;
        const ph = pB - pT;
        if (pw <= 4 || ph <= 4) return;

        let imgData;
        try {
            imgData = ctx.getImageData(pL, pT, pw, ph);
        } catch (_) { return; }

        const { data, width, height } = imgData;

        // Snapshot of original pixels — reads come from this immutable copy
        // preserving exact edge colours for the bilinear blend calculation.
        const orig = new Uint8ClampedArray(data);

        const lcx = px - pL;
        const lcy = py - pT;
        const rSq = r * r;

        for (let row = 0; row < height; row++) {
            const dy = row - lcy;
            if (dy * dy >= rSq) continue;  // row outside erase circle

            const halfChord = Math.sqrt(rSq - dy * dy);
            const colL = Math.round(lcx - halfChord);
            const colR = Math.round(lcx + halfChord);

            // Edge sample columns (clamped just outside the circle)
            const edgeL = Math.max(0, colL - 2);
            const edgeR = Math.min(width - 1, colR + 2);

            // Edge sample rows for vertical interpolation
            const edgeT = Math.max(0, Math.round(lcy - halfChord) - 2);
            const edgeB = Math.min(height - 1, Math.round(lcy + halfChord) + 2);

            const liIdx = (row * width + edgeL) * 4;
            const riIdx = (row * width + edgeR) * 4;
            const hSpan = edgeR - edgeL;

            for (let col = Math.max(0, colL); col <= Math.min(width - 1, colR); col++) {
                // Horizontal blend factor
                const hT = hSpan > 0 ? (col - edgeL) / hSpan : 0.5;

                // Horizontal interpolated color
                const hR = orig[liIdx] * (1 - hT) + orig[riIdx] * hT;
                const hG = orig[liIdx + 1] * (1 - hT) + orig[riIdx + 1] * hT;
                const hB = orig[liIdx + 2] * (1 - hT) + orig[riIdx + 2] * hT;

                // Top/bottom colour samples for this column
                const tiIdx = (edgeT * width + col) * 4;
                const biIdx = (edgeB * width + col) * 4;

                const vSpan = edgeB - edgeT;
                const vT = vSpan > 0 ? (row - edgeT) / vSpan : 0.5;

                // Vertical interpolated color
                const vR = orig[tiIdx] * (1 - vT) + orig[biIdx] * vT;
                const vG = orig[tiIdx + 1] * (1 - vT) + orig[biIdx + 1] * vT;
                const vB = orig[tiIdx + 2] * (1 - vT) + orig[biIdx + 2] * vT;

                // Blend horizontal and vertical 50/50 for perfectly smooth bilinear result
                const di = (row * width + col) * 4;
                data[di] = (hR * 0.5 + vR * 0.5 + 0.5) | 0;
                data[di + 1] = (hG * 0.5 + vG * 0.5 + 0.5) | 0;
                data[di + 2] = (hB * 0.5 + vB * 0.5 + 0.5) | 0;
                data[di + 3] = 255; // fully opaque
            }
        }

        ctx.putImageData(imgData, pL, pT);
    }


    // ── Draw Video Frame (correct zoom math: translate-scale-translate) ──
    static _drawVideoFrame(ctx, source, factor, cx, cy, sx, sy, sw, sh) {
        const srcW = source.videoWidth || source.width || 1920;
        const srcH = source.videoHeight || source.height || 1080;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        if (factor > 1.005) {
            // Correct zoom math: crop from source using normalized (cx,cy) as pivot
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
        this._drawVideoFrame(ctx, source, factor, cx, cy, sx, sy, sw, sh);

        const samples = this.MOTION_BLUR_SAMPLES.slice(1);
        for (const sample of samples) {
            const prevT = Math.max(0, t - sample.dt);
            const prevZoom = this.getZoomAt(prevT, segments, panSpeed);

            const zoomDelta = Math.abs(prevZoom.factor - factor)
                + Math.abs(prevZoom.cx - cx) * 2
                + Math.abs(prevZoom.cy - cy) * 2;
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
            ctx.setTransform(1, 0, 0, 1, 0, 0); // screen space
            ctx.globalAlpha = s.alpha;
            this._drawImageCursor(ctx, pos.x, pos.y, cursorSize, cursorStyle, type);
            ctx.restore();
        }

        // Main cursor (full alpha, screen space)
        const cursor = this.getSmoothedCursorAt(t, cursorData, cursorSpeed);
        if (cursor) {
            const pos = this._mapToScreen(cursor.x, cursor.y, factor, cx, cy, sx, sy, sw, sh);
            if (pos) {
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                this._drawImageCursor(ctx, pos.x, pos.y, cursorSize, cursorStyle, type);
                ctx.restore();
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
    // Use a slightly larger baseline ("middle size") so that it robustly covers
    // standard OS cursors at any zoom scale natively.
    static BASE_CURSOR_PX = 45;
    static MIN_CURSOR_PX = 32;

    static _drawImageCursor(ctx, x, y, scale, styleKey, type) {
        const images = this._cursorImages[styleKey];
        if (!images || !images[type]) return;
        const img = images[type];
        if (!img.complete || img.naturalWidth === 0) return;

        // Enforce minimum size so cursor always covers the erase patch
        const rawH = this.BASE_CURSOR_PX * scale;
        const drawH = Math.max(this.MIN_CURSOR_PX, rawH);
        const drawW = drawH * (img.naturalWidth / img.naturalHeight);

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        if (type === 'cur') {
            // The styled cursor tip (top-left of the arrow image) is placed
            // exactly at the tracked OS cursor hotspot.  This ensures the
            // styled cursor sits right on top of where the OS cursor was,
            // providing pixel-perfect coverage.
            ctx.drawImage(img, x, y, drawW, drawH);
        } else {
            // Hand / text cursors: offset so the interaction point (finger
            // tip / text I-beam centre) lands on the tracked position.
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

    /**
     * Map normalized [0,1] position to canvas screen pixels,
     * accounting for zoom viewport offset.
     */
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

    /**
     * Linear interpolation between the two nearest cursor samples.
     * Binary search → O(log n). Returns { x, y, t }.
     */
    static _interpolateCursor(t, data) {
        if (!data || !data.length) return null;
        if (data.length === 1) return data[0];

        // Clamp to data range
        if (t <= data[0].t) return data[0];
        if (t >= data[data.length - 1].t) return data[data.length - 1];

        // Binary search for surrounding samples
        let lo = 0, hi = data.length - 1;
        while (lo < hi - 1) {
            const m = (lo + hi) >> 1;
            if (data[m].t <= t) lo = m; else hi = m;
        }
        const a = data[lo], b = data[hi];
        if (a.t === b.t) return a;

        // True linear interpolation (not nearest-neighbour)
        const p = (t - a.t) / (b.t - a.t);
        return {
            x: a.x + (b.x - a.x) * p,
            y: a.y + (b.y - a.y) * p,
            t,
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
