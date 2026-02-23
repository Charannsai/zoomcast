/**
 * scripts/build-python-helpers.js
 *
 * Compiles cursor_tracker.py and dxgi_capture.py into standalone Windows .exe files
 * using PyInstaller. The resulting binaries are placed in helpers/bin/ so they get
 * bundled into the Electron app without any Python runtime dependency.
 *
 * Run:  node scripts/build-python-helpers.js
 *   or: npm run build:helpers
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HELPERS = path.join(ROOT, 'helpers');
const BIN_OUT = path.join(HELPERS, 'bin');

// ── Helpers ────────────────────────────────────────────────────────────────────

function run(cmd, cwd) {
    console.log(`\n▶ ${cmd}`);
    try {
        execSync(cmd, { cwd, stdio: 'inherit', shell: true });
    } catch (e) {
        console.error(`\n❌ Command failed: ${cmd}`);
        process.exit(1);
    }
}

function checkPython() {
    const r = spawnSync('python', ['--version'], { shell: true });
    if (r.status !== 0) {
        console.error('❌ Python not found. Install Python 3.9+ and make sure it is in your PATH.');
        process.exit(1);
    }
    console.log('✅ Python:', r.stdout.toString().trim() || r.stderr.toString().trim());
}

function checkPyInstaller() {
    const r = spawnSync('python', ['-m', 'PyInstaller', '--version'], { shell: true });
    if (r.status !== 0) {
        console.log('📦 Installing PyInstaller...');
        run('python -m pip install pyinstaller', ROOT);
    } else {
        console.log('✅ PyInstaller:', (r.stdout.toString() || r.stderr.toString()).trim());
    }
}

function compile(scriptName) {
    const specFile = path.join(HELPERS, `${scriptName}.spec`);
    const distDir = path.join(HELPERS, 'dist');
    const buildDir = path.join(HELPERS, 'build');

    console.log(`\n━━━ Compiling ${scriptName}.py ━━━`);

    // Build using spec file for precise control
    run(
        `python -m PyInstaller "${specFile}" --distpath "${distDir}" --workpath "${buildDir}" --noconfirm`,
        HELPERS
    );

    // Move resulting exe to helpers/bin/
    const exeSrc = path.join(distDir, scriptName, `${scriptName}.exe`);
    const exeDest = path.join(BIN_OUT, `${scriptName}.exe`);

    if (!fs.existsSync(exeSrc)) {
        // PyInstaller onefile mode puts it directly in distDir
        const altSrc = path.join(distDir, `${scriptName}.exe`);
        if (fs.existsSync(altSrc)) {
            fs.copyFileSync(altSrc, exeDest);
        } else {
            console.error(`❌ Built exe not found at: ${exeSrc}`);
            process.exit(1);
        }
    } else {
        fs.copyFileSync(exeSrc, exeDest);
    }

    const size = (fs.statSync(exeDest).size / 1024 / 1024).toFixed(1);
    console.log(`✅ ${scriptName}.exe → helpers/bin/${scriptName}.exe (${size} MB)`);
}

function cleanup() {
    const distDir = path.join(HELPERS, 'dist');
    const buildDir = path.join(HELPERS, 'build');
    [distDir, buildDir].forEach(d => {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    });
    console.log('\n🧹 Cleaned up PyInstaller temp dirs');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  ZoomCast Python Helpers → EXE Compiler   ');
    console.log('═══════════════════════════════════════════');

    checkPython();
    checkPyInstaller();

    // Create output directory
    fs.mkdirSync(BIN_OUT, { recursive: true });

    // Compile both helpers
    compile('cursor_tracker');
    compile('dxgi_capture');

    // Cleanup temp build artifacts
    cleanup();

    console.log('\n═══════════════════════════════════════════');
    console.log('  ✅ All helpers compiled successfully!      ');
    console.log('  📁 Output: helpers/bin/                   ');
    console.log('  • cursor_tracker.exe                      ');
    console.log('  • dxgi_capture.exe                        ');
    console.log('  Run `npm run build` to bundle into app.   ');
    console.log('═══════════════════════════════════════════\n');
}

main();
