/**
 * generate-icon.js
 * Creates assets/icon.png (256×256) and assets/icon.ico for the Windows build.
 * Uses only Node.js built-ins + png-to-ico (already installed).
 *
 * The PNG is built by encoding raw RGBA pixel data using a hand-rolled
 * PNG encoder (zlib deflate + PNG chunks).
 *
 * Run: node scripts/generate-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
const SIZE = 256;

// ─────────────────────────────────────────────────────────────────
// Minimal PNG encoder (no external deps)
// ─────────────────────────────────────────────────────────────────
function crc32(buf) {
    const table = [];
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
    }
    let crc = 0xFFFFFFFF;
    for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.allocUnsafe(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(pixels, width, height) {
    // Build raw scanlines (filter byte 0 = None per row)
    const raw = [];
    for (let y = 0; y < height; y++) {
        raw.push(0); // filter type None
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            raw.push(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]);
        }
    }
    const deflated = zlib.deflateSync(Buffer.from(raw), { level: 9 });

    const IHDR_data = Buffer.allocUnsafe(13);
    IHDR_data.writeUInt32BE(width, 0);
    IHDR_data.writeUInt32BE(height, 4);
    IHDR_data[8] = 8;  // bit depth
    IHDR_data[9] = 2;  // color type: RGB … wait we want RGBA = 6
    IHDR_data[9] = 6;  // RGBA
    IHDR_data[10] = 0; IHDR_data[11] = 0; IHDR_data[12] = 0;

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG sig
        chunk('IHDR', IHDR_data),
        chunk('IDAT', deflated),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ─────────────────────────────────────────────────────────────────
// Draw the icon into a pixel buffer
// ─────────────────────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function setPixel(pixels, w, x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= w) return;
    const i = (y * w + x) * 4;
    // Alpha-blend over existing pixel
    const sa = a / 255;
    const da = pixels[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa < 0.001) return;
    pixels[i] = Math.round((r * sa + pixels[i] * da * (1 - sa)) / oa);
    pixels[i + 1] = Math.round((g * sa + pixels[i + 1] * da * (1 - sa)) / oa);
    pixels[i + 2] = Math.round((b * sa + pixels[i + 2] * da * (1 - sa)) / oa);
    pixels[i + 3] = Math.round(oa * 255);
}

function fillCircle(pixels, w, cx, cy, r, R, G, B, A) {
    const x0 = Math.floor(cx - r - 1), x1 = Math.ceil(cx + r + 1);
    const y0 = Math.floor(cy - r - 1), y1 = Math.ceil(cy + r + 1);
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
            const edge = clamp(r - dist + 0.5, 0, 1);
            if (edge > 0) setPixel(pixels, w, x, y, R, G, B, Math.round(A * edge));
        }
    }
}

function strokeCircle(pixels, w, cx, cy, r, lw, R, G, B, A) {
    const outer = r + lw / 2, inner = r - lw / 2;
    const x0 = Math.floor(cx - outer - 1), x1 = Math.ceil(cx + outer + 1);
    const y0 = Math.floor(cy - outer - 1), y1 = Math.ceil(cy + outer + 1);
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
            const outerEdge = clamp(outer - dist + 0.5, 0, 1);
            const innerEdge = clamp(dist - inner + 0.5, 0, 1);
            const alpha = Math.min(outerEdge, innerEdge);
            if (alpha > 0) setPixel(pixels, w, x, y, R, G, B, Math.round(A * alpha));
        }
    }
}

function drawLine(pixels, w, x1, y1, x2, y2, lw, R, G, B, A) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.ceil(len * 2);
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const px = x1 + dx * t, py = y1 + dy * t;
        fillCircle(pixels, w, px, py, lw / 2, R, G, B, A);
    }
}

function roundedRect(pixels, w, x, y, rw, rh, r, R, G, B, A) {
    for (let py = y; py < y + rh; py++) {
        for (let px = x; px < x + rw; px++) {
            // Distance from nearest rounded corner
            const cx = clamp(px, x + r, x + rw - r);
            const cy = clamp(py, y + r, y + rh - r);
            const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
            const edge = clamp(r - dist + 0.5, 0, 1);
            if (edge > 0) setPixel(pixels, w, px, py, R, G, B, Math.round(A * edge));
        }
    }
}

function drawIcon() {
    const W = SIZE;
    const pixels = new Uint8Array(W * W * 4); // RGBA, starts transparent
    const s = W / 512; // scale from 512-px design

    // ── Background (dark rounded square) ──
    roundedRect(pixels, W, 0, 0, W, W, Math.round(115 * s), 0x1a, 0x1a, 0x2e, 255);

    // ── Lens fill (dark inner) ──
    fillCircle(pixels, W, 220 * s, 220 * s, 138 * s, 0x1a, 0x1a, 0x3a, 255);

    // ── Lens ring (purple stroke, 18px wide) ──
    strokeCircle(pixels, W, 220 * s, 220 * s, 140 * s, 18 * s, 0x6C, 0x5C, 0xE7, 255);

    // ── Outer glow ring ──
    strokeCircle(pixels, W, 220 * s, 220 * s, 148 * s, 8 * s, 0x6C, 0x5C, 0xE7, 55);

    // ── Recording dot (pink/rose) ──
    fillCircle(pixels, W, 220 * s, 220 * s, 30 * s, 0xff, 0x6e, 0xb4, 255);

    // ── Handle line ──
    drawLine(pixels, W, 331 * s, 331 * s, 400 * s, 400 * s, 28 * s, 0x6C, 0x5C, 0xE7, 255);

    // ── Handle cap ──
    fillCircle(pixels, W, 404 * s, 404 * s, 22 * s, 0x6C, 0x5C, 0xE7, 255);

    // ── Lens highlight ──
    fillCircle(pixels, W, 180 * s, 170 * s, 20 * s, 0xff, 0xff, 0xff, 20);

    return pixels;
}

async function main() {
    console.log('🎨 Generating ZoomCast icon...');
    const pixels = drawIcon();

    // Write PNG
    const pngPath = path.join(ASSETS, 'icon.png');
    const pngBuf = encodePNG(pixels, SIZE, SIZE);
    fs.writeFileSync(pngPath, pngBuf);
    console.log(`✅ Written: ${pngPath} (${pngBuf.length} bytes)`);

    // Write ICO
    const icoPath = path.join(ASSETS, 'icon.ico');
    try {
        const pngToIcoMod = require('png-to-ico');
        const pngToIco = pngToIcoMod.default || pngToIcoMod;
        const icoBuf = await pngToIco(pngPath);
        fs.writeFileSync(icoPath, icoBuf);
        console.log(`✅ Written: ${icoPath} (${icoBuf.length} bytes)`);
    } catch (err) {
        console.error('❌ ICO generation failed:', err.message);
        process.exit(1);
    }

    console.log('\n🚀 Icon ready. Now run: npm run build');
}

main();
