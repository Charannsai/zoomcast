/**
 * make-icon.js  — Generates assets/icon.png and assets/icon.ico from assets/icon.svg
 * Run: node scripts/make-icon.js
 *
 * Requires: npm install --save-dev png-to-ico
 * The SVG → PNG conversion uses the Canvas API built into Electron/Node via the
 * `electron` binary, so we generate a 256×256 PNG programmatically using pure
 * Node.js drawing (no extra deps needed), then bundle it into ICO.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');

// ─── Generate a PNG programmatically ─────────────────────────────────────────
// We use the `canvas` package if available, otherwise write a hand-crafted PNG.
// Since we already have electron (which bundles Chromium canvas), we use a tiny
// helper that just creates a properly-formed PNG bytes for the icon.

async function generatePng(outPath, size = 256) {
    // Try using the png-to-ico-compatible raw PNG header approach
    // Build a simple gradient circle PNG using pure Buffer manipulation
    // For a real icon we create a minimal valid PNG with our brand colors

    const { createCanvas } = (() => {
        try { return require('canvas'); } catch { return null; }
    })() || {};

    if (createCanvas) {
        const canvas = createCanvas(size, size);
        const ctx = canvas.getContext('2d');
        drawIcon(ctx, size);
        fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
        console.log(`✅ Generated ${outPath} via canvas`);
        return;
    }

    // Fallback: copy SVG-derived stub (electron-builder can auto-convert SVG on some platforms)
    // For Windows, we create a simple valid 256x256 PNG using raw bytes via jimp or sharp if available
    try {
        const sharp = require('sharp');
        const svgPath = path.join(ASSETS, 'icon.svg');
        await sharp(svgPath).resize(size, size).png().toFile(outPath);
        console.log(`✅ Generated ${outPath} via sharp`);
        return;
    } catch { }

    console.warn(`⚠️  Could not generate PNG automatically. Please manually provide assets/icon.png (256×256).`);
}

function drawIcon(ctx, size) {
    const s = size / 512; // scale factor relative to our 512px design

    // Background
    const bg = ctx.createLinearGradient(0, 0, size, size);
    bg.addColorStop(0, '#1a1a2e');
    bg.addColorStop(1, '#0d0d1a');
    ctx.fillStyle = bg;
    roundRect(ctx, 0, 0, size, size, size * 0.22);
    ctx.fill();

    // Lens ring
    const cx = 220 * s, cy = 220 * s, r = 140 * s;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1a3a';
    ctx.fill();
    ctx.strokeStyle = '#6C5CE7';
    ctx.lineWidth = 18 * s;
    ctx.stroke();

    // Recording dot
    ctx.beginPath();
    ctx.arc(cx, cy, 32 * s, 0, Math.PI * 2);
    ctx.fillStyle = '#ff6eb4';
    ctx.fill();

    // Handle
    ctx.beginPath();
    ctx.moveTo(331 * s, 331 * s);
    ctx.lineTo(400 * s, 400 * s);
    ctx.strokeStyle = '#6C5CE7';
    ctx.lineWidth = 30 * s;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(405 * s, 405 * s, 22 * s, 0, Math.PI * 2);
    ctx.fillStyle = '#6C5CE7';
    ctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
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

async function main() {
    const pngPath = path.join(ASSETS, 'icon.png');
    const icoPath = path.join(ASSETS, 'icon.ico');

    // Step 1: Generate PNG
    if (!fs.existsSync(pngPath)) {
        await generatePng(pngPath, 256);
    } else {
        console.log(`ℹ️  ${pngPath} already exists, skipping PNG generation`);
    }

    // Step 2: Convert PNG → ICO
    if (fs.existsSync(pngPath)) {
        try {
            const pngToIco = require('png-to-ico');
            const buf = await pngToIco(pngPath);
            fs.writeFileSync(icoPath, buf);
            console.log(`✅ Generated ${icoPath}`);
        } catch (err) {
            console.error('❌ Failed to create ICO:', err.message);
        }
    }
}

main().catch(console.error);
