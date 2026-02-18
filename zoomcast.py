"""
╔══════════════════════════════════════════════════════════════════╗
║          ZoomCast — Screen.studio for Windows                    ║
║                                                                  ║
║  Phase 1: RECORD  — captures screen + cursor data separately     ║
║  Phase 2: EDIT    — timeline editor, add/drag zoom segments      ║
║  Phase 3: EXPORT  — renders final video with smooth zoom effects ║
╚══════════════════════════════════════════════════════════════════╝

Install once:
    pip install mss pillow opencv-python numpy pynput pywin32

Run:
    python zoomcast.py
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox, colorchooser
import threading, time, math, os, sys, json, tempfile, shutil
import colorsys
from datetime import datetime
from collections import deque
from pathlib import Path

# ════════════════════════════════════════════════════════════════
#  DEPENDENCY CHECK
# ════════════════════════════════════════════════════════════════

def check_and_import():
    missing = []
    for pkg, imp in [("mss","mss"),("pillow","PIL"),
                     ("opencv-python","cv2"),("numpy","numpy"),
                     ("pynput","pynput"),("pywin32","win32api")]:
        try: __import__(imp)
        except ImportError: missing.append(pkg)
    if missing:
        root = tk.Tk(); root.withdraw()
        messagebox.showerror("Missing Packages",
            f"Run in terminal:\n\n  pip install {' '.join(missing)}\n\nThen restart ZoomCast.")
        sys.exit(1)

check_and_import()

import mss, cv2, numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageTk
from pynput import mouse as pmouse

try:
    import win32api, win32gui, win32con
    HAS_WIN32 = True
except ImportError:
    HAS_WIN32 = False

# ════════════════════════════════════════════════════════════════
#  THEME
# ════════════════════════════════════════════════════════════════

class T:
    BG       = "#111118"
    SIDEBAR  = "#1A1A27"
    CARD     = "#1E1E2E"
    CARD2    = "#252535"
    BORDER   = "#2A2A40"
    BLUE     = "#3B82F6"
    BLUE2    = "#2563EB"
    GREEN    = "#10B981"
    RED      = "#EF4444"
    ORANGE   = "#F59E0B"
    PURPLE   = "#8B5CF6"
    TEXT     = "#F0F0FF"
    MUTED    = "#6B7280"
    ZOOM_CLR = "#3B82F6"   # default zoom segment colour

# ════════════════════════════════════════════════════════════════
#  CLICK / CURSOR DATA MODELS
# ════════════════════════════════════════════════════════════════

class ClickEvent:
    __slots__ = ("time","x","y","button")
    def __init__(self, t, x, y, button="left"):
        self.time = t; self.x = x; self.y = y; self.button = button

class CursorSample:
    __slots__ = ("time","x","y")
    def __init__(self, t, x, y):
        self.time = t; self.x = x; self.y = y

class ZoomSegment:
    """A user-defined or auto-generated zoom region on the timeline."""
    def __init__(self, t_start, t_end, cx, cy, factor=2.2, color=T.ZOOM_CLR):
        self.t_start = t_start
        self.t_end   = t_end
        self.cx      = cx    # 0..1 normalised screen position
        self.cy      = cy
        self.factor  = factor
        self.color   = color
        self.label   = ""

# ════════════════════════════════════════════════════════════════
#  RECORDER ENGINE
# ════════════════════════════════════════════════════════════════

class RecorderEngine:
    def __init__(self, monitor_idx=1, fps=30):
        self.monitor_idx = monitor_idx
        self.fps         = fps
        self.running     = False
        self.paused      = False
        self._lock       = threading.Lock()

        # Output data
        self.raw_frames  = []          # numpy RGB frames (no cursor drawn)
        self.cursor_data = []          # list of CursorSample
        self.click_data  = []          # list of ClickEvent
        self.frame_times = []          # timestamp per frame
        self.duration    = 0.0

        self._listener   = None
        self._t_start    = 0.0

    # ── Mouse listener ────────────────────────────────────────────
    def _on_click(self, x, y, button, pressed):
        if pressed and self.running and not self.paused:
            t = time.time() - self._t_start
            with self._lock:
                self.click_data.append(ClickEvent(t, x, y,
                    "left" if "left" in str(button).lower() else "right"))

    def _on_move(self, x, y):
        if self.running and not self.paused:
            t = time.time() - self._t_start
            with self._lock:
                self.cursor_data.append(CursorSample(t, x, y))

    # ── Capture loop ──────────────────────────────────────────────
    def _capture_loop(self):
        interval = 1.0 / self.fps
        with mss.mss() as sct:
            mon_list = sct.monitors
            if self.monitor_idx >= len(mon_list):
                self.monitor_idx = 1
            mon = mon_list[self.monitor_idx]
            self.mon_info = dict(mon)

            while self.running:
                t0 = time.time()
                if self.paused:
                    time.sleep(0.05)
                    continue
                raw = sct.grab(mon)
                frame = np.frombuffer(raw.bgra, dtype=np.uint8)
                frame = frame.reshape((raw.height, raw.width, 4))
                rgb   = frame[:, :, :3][:, :, ::-1].copy()  # BGR→RGB

                t_frame = time.time() - self._t_start
                with self._lock:
                    self.raw_frames.append(rgb)
                    self.frame_times.append(t_frame)

                sleep = interval - (time.time() - t0)
                if sleep > 0:
                    time.sleep(sleep)

    # ── Public ────────────────────────────────────────────────────
    def start(self):
        self._t_start = time.time()
        self.running  = True
        self.paused   = False
        self._listener = pmouse.Listener(
            on_click=self._on_click, on_move=self._on_move)
        self._listener.start()
        threading.Thread(target=self._capture_loop, daemon=True).start()

    def pause(self):
        self.paused = True

    def resume(self):
        self.paused = False

    def stop(self):
        self.running = False
        if self._listener:
            self._listener.stop()
        if self.frame_times:
            self.duration = self.frame_times[-1]

    def frame_count(self):
        with self._lock:
            return len(self.raw_frames)

    def auto_generate_zooms(self, screen_w, screen_h,
                             cluster_gap=0.8, zoom_dur=2.5, factor=2.2):
        """Generate ZoomSegments from click clusters."""
        segments = []
        clicks = sorted(self.click_data, key=lambda c: c.time)
        if not clicks:
            return segments
        # Cluster nearby clicks
        groups = [[clicks[0]]]
        for c in clicks[1:]:
            if c.time - groups[-1][-1].time < cluster_gap:
                groups[-1].append(c)
            else:
                groups.append([c])
        for g in groups:
            t0 = max(0, g[0].time - 0.15)
            t1 = min(self.duration, g[-1].time + zoom_dur)
            cx = sum(c.x for c in g) / len(g) / screen_w
            cy = sum(c.y for c in g) / len(g) / screen_h
            segments.append(ZoomSegment(t0, t1, cx, cy, factor))
        return segments


# ════════════════════════════════════════════════════════════════
#  RENDERER — merges raw frames + cursor + zoom segments → MP4
# ════════════════════════════════════════════════════════════════

class Renderer:
    ANIM_SECS = 0.35   # zoom in/out transition duration

    def __init__(self, engine: RecorderEngine, segments, cfg):
        self.engine   = engine
        self.segments = sorted(segments, key=lambda s: s.t_start)
        self.cfg      = cfg   # dict: bg_color, cursor_size, click_ripple, etc.

    def _smooth_cursor(self, cursor_data, sigma_frames=3):
        """Gaussian-smooth cursor trajectory."""
        if len(cursor_data) < 3:
            return cursor_data
        xs = np.array([c.x for c in cursor_data], dtype=float)
        ys = np.array([c.y for c in cursor_data], dtype=float)
        from scipy.ndimage import gaussian_filter1d
        try:
            xs = gaussian_filter1d(xs, sigma_frames)
            ys = gaussian_filter1d(ys, sigma_frames)
        except Exception:
            pass   # scipy optional; skip smoothing
        out = []
        for i, c in enumerate(cursor_data):
            ns = CursorSample(c.time, xs[i], ys[i])
            out.append(ns)
        return out

    def _get_cursor_pos_at(self, t, cursor_data):
        """Interpolate cursor position at time t."""
        if not cursor_data:
            return None
        lo, hi = 0, len(cursor_data) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if cursor_data[mid].time < t:
                lo = mid + 1
            else:
                hi = mid
        c = cursor_data[lo]
        return (int(c.x), int(c.y))

    def _zoom_factor_at(self, t):
        """Compute current zoom level (factor, cx, cy) using smooth in/out."""
        A = self.ANIM_SECS
        for seg in self.segments:
            if t < seg.t_start - A or t > seg.t_end + A:
                continue
            # ramp in
            if t < seg.t_start:
                alpha = (t - (seg.t_start - A)) / A
            elif t > seg.t_end:
                alpha = 1.0 - (t - seg.t_end) / A
            else:
                alpha = 1.0
            alpha = max(0.0, min(1.0, alpha))
            # ease in-out
            alpha = alpha * alpha * (3 - 2 * alpha)
            fac = 1.0 + (seg.factor - 1.0) * alpha
            return fac, seg.cx, seg.cy
        return 1.0, 0.5, 0.5

    def _draw_click_ripple(self, pil_img, clicks_near, mon):
        """Draw macOS-style ripple circles at click positions."""
        draw = ImageDraw.Draw(pil_img)
        w, h = pil_img.size
        for c, age in clicks_near:
            px = int((c.x - mon["left"]) * w / mon["width"])
            py = int((c.y - mon["top"])  * h / mon["height"])
            r  = int(12 + age * 30)
            opacity = int(200 * max(0, 1 - age / 0.6))
            if opacity < 5:
                continue
            # Outer ring
            draw.ellipse([px-r, py-r, px+r, py+r],
                         outline=(255, 255, 255, opacity), width=2)
            # Inner dot
            r2 = max(3, int(6 * max(0, 1 - age * 3)))
            draw.ellipse([px-r2, py-r2, px+r2, py+r2],
                         fill=(255, 255, 255, min(255, opacity+30)))
        return pil_img

    def render(self, out_path, progress_cb=None):
        engine  = self.engine
        fps     = engine.fps
        frames  = engine.raw_frames
        ftimes  = engine.frame_times
        mon     = engine.mon_info
        sw, sh  = mon["width"], mon["height"]

        cursor_data = engine.cursor_data
        click_data  = engine.click_data

        # Output size
        out_w = self.cfg.get("out_w", sw)
        out_h = self.cfg.get("out_h", sh)

        # Padding / background
        pad    = self.cfg.get("padding", 0)
        bg_clr = self.cfg.get("bg_color", None)
        corner = self.cfg.get("corners", 0)
        shadow = self.cfg.get("shadow", False)

        if bg_clr and pad > 0:
            canvas_w = out_w
            canvas_h = out_h
            rec_w    = int(canvas_w - pad * 2)
            rec_h    = int(canvas_h - pad * 2)
        else:
            canvas_w = out_w
            canvas_h = out_h
            rec_w, rec_h = out_w, out_h
            pad = 0

        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(out_path, fourcc, fps, (canvas_w, canvas_h))

        total  = len(frames)
        cursor_size = self.cfg.get("cursor_size", 1.0)

        for i, (frame_rgb, t) in enumerate(zip(frames, ftimes)):
            # ── Background canvas ────────────────────────────────
            if bg_clr and pad > 0:
                canvas = Image.new("RGB", (canvas_w, canvas_h), bg_clr)
            else:
                canvas = None

            # ── Zoom ─────────────────────────────────────────────
            zoom_f, zcx, zcy = self._zoom_factor_at(t)

            if zoom_f > 1.001:
                pil = Image.fromarray(frame_rgb)
                fw, fh = pil.size

                # Centre of zoom in pixel space
                px = int(zcx * fw)
                py = int(zcy * fh)

                # Crop region (scaled down by zoom_f)
                crop_w = fw / zoom_f
                crop_h = fh / zoom_f
                x1 = max(0, min(fw - crop_w, px - crop_w / 2))
                y1 = max(0, min(fh - crop_h, py - crop_h / 2))
                x2 = x1 + crop_w
                y2 = y1 + crop_h

                pil = pil.crop((x1, y1, x2, y2))
                pil = pil.resize((rec_w, rec_h), Image.LANCZOS)
            else:
                pil = Image.fromarray(frame_rgb).resize((rec_w, rec_h), Image.LANCZOS)

            # ── Rounded corners ───────────────────────────────────
            if corner > 0:
                mask = Image.new("L", (rec_w, rec_h), 0)
                md   = ImageDraw.Draw(mask)
                md.rounded_rectangle([0, 0, rec_w, rec_h], radius=corner, fill=255)
                result = Image.new("RGB", (rec_w, rec_h), (0, 0, 0))
                result.paste(pil, mask=mask)
                pil = result

            # ── Composite onto canvas ─────────────────────────────
            if canvas:
                if shadow:
                    sh_img = Image.new("RGBA", (rec_w + 20, rec_h + 20), (0, 0, 0, 0))
                    sd     = ImageDraw.Draw(sh_img)
                    sd.rounded_rectangle([10, 10, rec_w + 10, rec_h + 10],
                                         radius=corner, fill=(0, 0, 0, 80))
                    sh_img = sh_img.filter(ImageFilter.GaussianBlur(12))
                    canvas.paste(Image.new("RGB", sh_img.size, bg_clr),
                                 (pad - 10, pad - 10),
                                 mask=sh_img.split()[3])
                canvas.paste(pil, (pad, pad))
                pil = canvas

            # ── Cursor overlay ────────────────────────────────────
            cx_abs, cy_abs = self._get_cursor_pos_at(t, cursor_data) or (0, 0)
            # Map to output coords
            if zoom_f > 1.001:
                # Map absolute cursor → zoomed crop space → output
                raw_x = (cx_abs - mon["left"])
                raw_y = (cy_abs - mon["top"])
                cx_crop = (raw_x - x1) / crop_w
                cy_crop = (raw_y - y1) / crop_h
                cur_out_x = int(cx_crop * rec_w) + pad
                cur_out_y = int(cy_crop * rec_h) + pad
            else:
                cur_out_x = int((cx_abs - mon["left"]) / sw * rec_w) + pad
                cur_out_y = int((cy_abs - mon["top"])  / sh * rec_h) + pad

            cur_out_x = max(0, min(canvas_w - 1, cur_out_x))
            cur_out_y = max(0, min(canvas_h - 1, cur_out_y))

            # Draw click ripples
            if self.cfg.get("click_ripple", True):
                ripples = [(c, t - c.time) for c in click_data
                           if 0 <= t - c.time < 0.65]
                if ripples:
                    pil = pil.convert("RGBA")
                    pil = self._draw_click_ripple(pil, ripples, {
                        "left": mon["left"], "top": mon["top"],
                        "width": sw, "height": sh
                    })
                    pil = pil.convert("RGB")

            # ── To BGR for cv2 ─────────────────────────────────────
            bgr = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
            writer.write(bgr)

            if progress_cb and i % 15 == 0:
                progress_cb(i / total)

        writer.release()
        if progress_cb:
            progress_cb(1.0)
        return True


# ════════════════════════════════════════════════════════════════
#  GUI — RECORDER SCREEN
# ════════════════════════════════════════════════════════════════

class RecorderScreen(tk.Frame):
    def __init__(self, master, on_done):
        super().__init__(master, bg=T.BG)
        self.on_done  = on_done
        self._engine  = None
        self._running = False
        self._paused  = False
        self._t_start = 0.0
        self._mon_var = tk.IntVar(value=1)
        self._fps_var = tk.IntVar(value=30)
        self._auto_zoom_var = tk.BooleanVar(value=True)
        self._build()
        self._poll()

    def _build(self):
        # Header
        hdr = tk.Frame(self, bg=T.BG)
        hdr.pack(fill="x", padx=32, pady=(28, 0))
        tk.Label(hdr, text="⬤", fg=T.RED,    bg=T.BG, font=("Segoe UI", 12)).pack(side="left")
        tk.Label(hdr, text="⬤", fg=T.ORANGE, bg=T.BG, font=("Segoe UI", 12)).pack(side="left", padx=4)
        tk.Label(hdr, text="⬤", fg=T.GREEN,  bg=T.BG, font=("Segoe UI", 12)).pack(side="left")
        tk.Label(hdr, text="ZoomCast",
                 bg=T.BG, fg=T.TEXT,
                 font=("Segoe UI", 20, "bold")).pack(side="left", padx=14)
        tk.Label(hdr, text="Screen.studio for Windows",
                 bg=T.BG, fg=T.MUTED,
                 font=("Segoe UI", 10)).pack(side="left")

        tk.Label(self, text="Professional screen recorder with cinematic zoom",
                 bg=T.BG, fg=T.MUTED, font=("Segoe UI", 10)).pack(pady=(4, 24))

        # ── Status card ─────────────────────────────────────────
        sc = self._card(self)
        self._status_lbl = tk.Label(sc, text="Ready to record",
                                    bg=T.CARD, fg=T.MUTED,
                                    font=("Segoe UI", 12))
        self._status_lbl.pack(pady=(16, 4))

        self._timer_lbl = tk.Label(sc, text="00:00",
                                   bg=T.CARD, fg=T.TEXT,
                                   font=("Courier New", 48, "bold"))
        self._timer_lbl.pack()

        self._frames_lbl = tk.Label(sc, text="",
                                    bg=T.CARD, fg=T.MUTED,
                                    font=("Segoe UI", 9))
        self._frames_lbl.pack(pady=(0, 16))

        # ── Settings ─────────────────────────────────────────────
        sc2 = self._card(self, "Recording Settings")
        grid = tk.Frame(sc2, bg=T.CARD)
        grid.pack(fill="x", padx=20, pady=(4, 16))

        for r, (lbl, widget_fn) in enumerate([
            ("Monitor:",      lambda p: ttk.Combobox(p, textvariable=self._mon_var,
                                                     values=[1, 2, 3], width=6, state="readonly")),
            ("Frame rate:",   lambda p: ttk.Combobox(p, textvariable=self._fps_var,
                                                     values=[15, 24, 30, 60], width=6, state="readonly")),
        ]):
            tk.Label(grid, text=lbl, bg=T.CARD, fg=T.TEXT,
                     font=("Segoe UI", 10), anchor="w", width=14).grid(
                         row=r, column=0, pady=5, sticky="w")
            widget_fn(grid).grid(row=r, column=1, pady=5, sticky="w")

        tk.Label(grid, text="Auto-detect zooms from clicks:", bg=T.CARD, fg=T.TEXT,
                 font=("Segoe UI", 10), anchor="w", width=26).grid(
                     row=2, column=0, pady=5, sticky="w")
        tk.Checkbutton(grid, variable=self._auto_zoom_var,
                       bg=T.CARD, fg=T.TEXT, selectcolor=T.CARD2,
                       activebackground=T.CARD).grid(row=2, column=1, sticky="w")

        # ── Controls ─────────────────────────────────────────────
        btn_f = tk.Frame(self, bg=T.BG)
        btn_f.pack(pady=20)
        self._rec_btn   = self._btn(btn_f, "⏺  Start Recording", T.RED,   self._toggle_rec)
        self._rec_btn.pack(side="left", padx=6)
        self._pause_btn = self._btn(btn_f, "⏸  Pause", T.ORANGE, self._toggle_pause, state="disabled")
        self._pause_btn.pack(side="left", padx=6)
        self._edit_btn  = self._btn(btn_f, "✂  Open Editor", T.BLUE, self._go_editor, state="disabled")
        self._edit_btn.pack(side="left", padx=6)

        # ── Tips ─────────────────────────────────────────────────
        tips = tk.Frame(self, bg=T.CARD2)
        tips.pack(fill="x", padx=32, pady=8)
        for t in ["💡 Cursor is recorded separately — keep your Windows cursor as-is",
                  "🖱  Every click is tracked and can auto-generate zoom segments",
                  "✂  After recording, use the Editor to add, remove and adjust zooms"]:
            tk.Label(tips, text=t, bg=T.CARD2, fg=T.MUTED,
                     font=("Segoe UI", 9), anchor="w").pack(
                         fill="x", padx=16, pady=3)

    # ── Helpers ─────────────────────────────────────────────────

    def _card(self, parent, title=None):
        f = tk.Frame(parent, bg=T.CARD, relief="flat")
        f.pack(fill="x", padx=32, pady=6)
        if title:
            tk.Label(f, text=title, bg=T.CARD, fg=T.MUTED,
                     font=("Segoe UI", 9, "bold")).pack(
                         anchor="w", padx=16, pady=(10, 0))
        return f

    def _btn(self, parent, text, color, cmd, state="normal"):
        b = tk.Button(parent, text=text, command=cmd,
                      bg=color, fg="white", relief="flat",
                      font=("Segoe UI", 10, "bold"),
                      padx=16, pady=9, cursor="hand2",
                      activebackground=color, bd=0,
                      state=state)
        return b

    def _toggle_rec(self):
        if not self._running:
            self._start()
        else:
            self._stop()

    def _start(self):
        self._engine = RecorderEngine(self._mon_var.get(), self._fps_var.get())
        self._engine.start()
        self._running = True
        self._t_start = time.time()
        self._rec_btn.config(text="⏹  Stop Recording", bg=T.RED)
        self._pause_btn.config(state="normal")
        self._edit_btn.config(state="disabled")
        self._status_lbl.config(text="● Recording", fg=T.RED)

    def _stop(self):
        if self._engine:
            self._engine.stop()
        self._running = False
        self._paused  = False
        self._rec_btn.config(text="⏺  Start Recording", bg="#555")
        self._rec_btn.config(state="disabled")
        self._pause_btn.config(state="disabled")
        self._edit_btn.config(state="normal")
        self._status_lbl.config(text="Done — open editor to review", fg=T.GREEN)

    def _toggle_pause(self):
        if not self._engine:
            return
        if not self._paused:
            self._engine.pause()
            self._paused = True
            self._pause_btn.config(text="▶  Resume", bg=T.GREEN)
            self._status_lbl.config(text="⏸ Paused", fg=T.ORANGE)
        else:
            self._engine.resume()
            self._paused = False
            self._pause_btn.config(text="⏸  Pause", bg=T.ORANGE)
            self._status_lbl.config(text="● Recording", fg=T.RED)

    def _go_editor(self):
        if not self._engine or not self._engine.raw_frames:
            messagebox.showwarning("No Recording", "Nothing to edit.")
            return
        self.on_done(self._engine, self._auto_zoom_var.get())

    def _poll(self):
        if self._running and not self._paused and self._engine:
            elapsed = int(time.time() - self._t_start)
            self._timer_lbl.config(text=f"{elapsed//60:02d}:{elapsed%60:02d}")
            fc = self._engine.frame_count()
            self._frames_lbl.config(text=f"{fc} frames  |  {len(self._engine.click_data)} clicks recorded")
        self.after(400, self._poll)


# ════════════════════════════════════════════════════════════════
#  GUI — EDITOR SCREEN
# ════════════════════════════════════════════════════════════════

class EditorScreen(tk.Frame):
    THUMB_H    = 52   # timeline thumbnail strip height
    TL_H       = 110  # total timeline panel height
    SEG_H      = 24   # zoom segment bar height
    SEG_Y      = 58   # y of segment bars

    def __init__(self, master, engine: RecorderEngine, auto_zoom: bool, on_back, on_export):
        super().__init__(master, bg=T.BG)
        self.engine    = engine
        self.on_back   = on_back
        self.on_export = on_export

        self.segments: list[ZoomSegment] = []
        self._drag_seg = None    # (segment, drag_type: "move"|"left"|"right", start_x, orig)
        self._sel_seg  = None
        self._thumb_imgs = []    # PhotoImages for timeline

        self.duration = engine.duration or 1.0
        self._playhead = 0.0
        self._play_running = False

        # Preview
        self._preview_frame = None
        self._preview_photo = None

        # Auto-generate zoom from clicks
        if auto_zoom and engine.click_data:
            self.segments = engine.auto_generate_zooms(
                engine.mon_info["width"], engine.mon_info["height"])

        self._build()
        self._render_thumbnails()
        self._draw_timeline()
        self._update_preview(0.0)

    # ── Build UI ────────────────────────────────────────────────

    def _build(self):
        # ── Top bar ──────────────────────────────────────────────
        top = tk.Frame(self, bg=T.SIDEBAR)
        top.pack(fill="x")
        self._btn_s(top, "← Back", T.MUTED, self.on_back).pack(side="left", padx=10, pady=8)
        tk.Label(top, text="ZoomCast Editor", bg=T.SIDEBAR, fg=T.TEXT,
                 font=("Segoe UI", 13, "bold")).pack(side="left", padx=8)
        dur_s = f"{self.duration:.1f}s  ·  {self.engine.frame_count()} frames"
        tk.Label(top, text=dur_s, bg=T.SIDEBAR, fg=T.MUTED,
                 font=("Segoe UI", 9)).pack(side="left", padx=8)
        self._btn_s(top, "⬆  Export Video", T.BLUE, lambda: self.on_export(self.engine, self.segments, self._get_cfg())).pack(side="right", padx=10, pady=8)
        self._btn_s(top, "＋  Add Zoom", T.PURPLE, self._add_zoom_at_playhead).pack(side="right", padx=4, pady=8)
        self._btn_s(top, "🗑  Delete Zoom", T.RED, self._delete_selected).pack(side="right", padx=4, pady=8)

        # ── Main area ────────────────────────────────────────────
        main = tk.Frame(self, bg=T.BG)
        main.pack(fill="both", expand=True)

        # Left: properties panel
        self._props = tk.Frame(main, bg=T.SIDEBAR, width=240)
        self._props.pack(side="left", fill="y")
        self._props.pack_propagate(False)
        self._build_props()

        # Centre: preview + timeline
        centre = tk.Frame(main, bg=T.BG)
        centre.pack(side="left", fill="both", expand=True)

        # Preview canvas
        self._preview_canvas = tk.Canvas(centre, bg="#000000", cursor="crosshair")
        self._preview_canvas.pack(fill="both", expand=True, padx=0, pady=0)
        self._preview_canvas.bind("<Configure>", self._on_resize)
        self._preview_canvas.bind("<Button-1>", self._on_preview_click)

        # Playback controls
        ctrl = tk.Frame(centre, bg=T.CARD, height=36)
        ctrl.pack(fill="x")
        self._btn_s(ctrl, "⏮", T.MUTED, lambda: self._seek(0)).pack(side="left", padx=4, pady=4)
        self._play_btn = self._btn_s(ctrl, "▶ Play", T.GREEN, self._toggle_play)
        self._play_btn.pack(side="left", padx=4, pady=4)
        self._btn_s(ctrl, "⏭", T.MUTED, lambda: self._seek(self.duration)).pack(side="left", padx=4, pady=4)
        self._time_lbl = tk.Label(ctrl, text="0.0s / 0.0s",
                                  bg=T.CARD, fg=T.TEXT, font=("Courier New", 9))
        self._time_lbl.pack(side="left", padx=10)

        # Timeline
        self._tl_frame = tk.Frame(centre, bg=T.CARD2, height=self.TL_H)
        self._tl_frame.pack(fill="x")
        self._tl_frame.pack_propagate(False)

        self._tl = tk.Canvas(self._tl_frame, bg=T.CARD2, height=self.TL_H, cursor="crosshair")
        self._tl.pack(fill="both", expand=True)
        self._tl.bind("<Button-1>",       self._tl_click)
        self._tl.bind("<B1-Motion>",      self._tl_drag)
        self._tl.bind("<ButtonRelease-1>",self._tl_release)
        self._tl.bind("<Configure>",      lambda e: self._draw_timeline())
        self._tl.bind("<Button-3>",       self._tl_right_click)

    def _build_props(self):
        p = self._props
        tk.Label(p, text="Properties", bg=T.SIDEBAR, fg=T.TEXT,
                 font=("Segoe UI", 11, "bold")).pack(pady=(16, 8), padx=16, anchor="w")

        # Zoom segment properties (shown when selected)
        self._seg_props = tk.Frame(p, bg=T.SIDEBAR)
        self._seg_props.pack(fill="x", padx=8)
        tk.Label(self._seg_props, text="Selected Zoom Segment",
                 bg=T.SIDEBAR, fg=T.MUTED, font=("Segoe UI", 8)).pack(anchor="w", padx=8)

        self._seg_factor = tk.DoubleVar(value=2.2)
        self._seg_label  = tk.StringVar(value="")
        for lbl, var, frm, to, res in [
            ("Zoom factor:", self._seg_factor, 1.3, 5.0, 0.1),
        ]:
            row = tk.Frame(self._seg_props, bg=T.SIDEBAR)
            row.pack(fill="x", padx=8, pady=3)
            tk.Label(row, text=lbl, bg=T.SIDEBAR, fg=T.TEXT,
                     font=("Segoe UI", 9), width=14, anchor="w").pack(side="left")
            sl = tk.Scale(row, variable=var, from_=frm, to=to, resolution=res,
                          orient="horizontal", length=130, bg=T.SIDEBAR,
                          fg=T.TEXT, highlightthickness=0, troughcolor=T.CARD2,
                          activebackground=T.BLUE, sliderrelief="flat",
                          command=lambda v: self._apply_seg_props())
            sl.pack(side="left")

        lrow = tk.Frame(self._seg_props, bg=T.SIDEBAR)
        lrow.pack(fill="x", padx=8, pady=3)
        tk.Label(lrow, text="Label:", bg=T.SIDEBAR, fg=T.TEXT,
                 font=("Segoe UI", 9), width=8, anchor="w").pack(side="left")
        tk.Entry(lrow, textvariable=self._seg_label, width=14,
                 bg=T.CARD2, fg=T.TEXT, insertbackground=T.TEXT,
                 relief="flat").pack(side="left")

        # Separator
        tk.Frame(p, bg=T.BORDER, height=1).pack(fill="x", padx=8, pady=10)

        # Global output settings
        tk.Label(p, text="Output Settings", bg=T.SIDEBAR, fg=T.TEXT,
                 font=("Segoe UI", 11, "bold")).pack(pady=(4, 8), padx=16, anchor="w")

        self._padding_var  = tk.IntVar(value=40)
        self._corners_var  = tk.IntVar(value=18)
        self._shadow_var   = tk.BooleanVar(value=True)
        self._ripple_var   = tk.BooleanVar(value=True)
        self._bg_color     = T.CARD2
        self._cursor_sz    = tk.DoubleVar(value=1.0)

        for lbl, var, frm, to, res in [
            ("Padding:",    self._padding_var,  0, 120, 4),
            ("Corners:",    self._corners_var,  0, 40,  1),
        ]:
            row = tk.Frame(p, bg=T.SIDEBAR)
            row.pack(fill="x", padx=16, pady=2)
            tk.Label(row, text=lbl, bg=T.SIDEBAR, fg=T.TEXT,
                     font=("Segoe UI", 9), width=10, anchor="w").pack(side="left")
            tk.Scale(row, variable=var, from_=frm, to=to, resolution=res,
                     orient="horizontal", length=130, bg=T.SIDEBAR,
                     fg=T.TEXT, highlightthickness=0, troughcolor=T.CARD2,
                     activebackground=T.BLUE, sliderrelief="flat").pack(side="left")

        for lbl, var in [("Drop shadow", self._shadow_var),
                         ("Click ripples", self._ripple_var)]:
            row = tk.Frame(p, bg=T.SIDEBAR)
            row.pack(fill="x", padx=16, pady=2)
            tk.Checkbutton(row, text=lbl, variable=var,
                           bg=T.SIDEBAR, fg=T.TEXT, selectcolor=T.CARD2,
                           activebackground=T.SIDEBAR,
                           font=("Segoe UI", 9)).pack(side="left")

        bg_row = tk.Frame(p, bg=T.SIDEBAR)
        bg_row.pack(fill="x", padx=16, pady=4)
        tk.Label(bg_row, text="Background:", bg=T.SIDEBAR, fg=T.TEXT,
                 font=("Segoe UI", 9)).pack(side="left")
        self._bg_swatch = tk.Canvas(bg_row, width=28, height=18,
                                    bg=self._bg_color, relief="flat")
        self._bg_swatch.pack(side="left", padx=6)
        self._bg_swatch.bind("<Button-1>", self._pick_bg)
        tk.Label(bg_row, text="(click to change)", bg=T.SIDEBAR, fg=T.MUTED,
                 font=("Segoe UI", 8)).pack(side="left")

    def _btn_s(self, parent, text, color, cmd):
        return tk.Button(parent, text=text, command=cmd,
                         bg=color, fg="white", relief="flat",
                         font=("Segoe UI", 9, "bold"),
                         padx=10, pady=4, cursor="hand2",
                         activebackground=color, bd=0)

    # ── Thumbnails ───────────────────────────────────────────────

    def _render_thumbnails(self):
        """Generate ~50 thumbnail images for timeline strip."""
        frames = self.engine.raw_frames
        if not frames:
            return
        n = min(60, len(frames))
        step = max(1, len(frames) // n)
        self._thumb_pils = []
        for i in range(0, len(frames), step):
            f = frames[i]
            pil = Image.fromarray(f)
            th  = self.THUMB_H
            tw  = int(pil.width / pil.height * th)
            pil = pil.resize((tw, th), Image.BILINEAR)
            self._thumb_pils.append(pil)

    # ── Timeline drawing ─────────────────────────────────────────

    def _draw_timeline(self):
        tl = self._tl
        tl.delete("all")
        W = tl.winfo_width() or 800
        H = self.TL_H

        # thumbnail strip
        if hasattr(self, "_thumb_pils") and self._thumb_pils:
            x = 0
            self._thumb_imgs = []
            for pil in self._thumb_pils:
                tw = pil.width
                if x + tw > W:
                    break
                ph = ImageTk.PhotoImage(pil)
                self._thumb_imgs.append(ph)
                tl.create_image(x, 0, anchor="nw", image=ph)
                x += tw

        # Dim strip
        tl.create_rectangle(0, 0, W, self.THUMB_H,
                             fill="", stipple="gray25", outline="")

        # Zoom segments
        for seg in self.segments:
            self._draw_segment(tl, seg, W)

        # Playhead
        px = self._t_to_x(self._playhead, W)
        tl.create_line(px, 0, px, H, fill="white", width=2)
        tl.create_polygon(px-6, 0, px+6, 0, px, 10,
                          fill="white", outline="")
        # Time labels
        for i in range(11):
            t = self.duration * i / 10
            x = self._t_to_x(t, W)
            tl.create_line(x, self.THUMB_H - 6, x, self.THUMB_H, fill=T.MUTED)
            if i % 2 == 0:
                tl.create_text(x, self.THUMB_H + 8, text=f"{t:.1f}s",
                               fill=T.MUTED, font=("Segoe UI", 7))

    def _draw_segment(self, tl, seg, W):
        x1 = self._t_to_x(seg.t_start, W)
        x2 = self._t_to_x(seg.t_end,   W)
        y1 = self.SEG_Y
        y2 = self.SEG_Y + self.SEG_H
        selected = seg is self._sel_seg
        clr = seg.color
        border = "white" if selected else "#666666"

        tl.create_rectangle(x1, y1, x2, y2,
                             fill=clr, outline=border, width=2 if selected else 1)
        # Label
        mid = (x1 + x2) // 2
        label = seg.label or f"×{seg.factor:.1f}"
        tl.create_text(mid, y1 + self.SEG_H // 2,
                       text=label, fill="white",
                       font=("Segoe UI", 8, "bold"))
        # Resize handles
        tl.create_rectangle(x1, y1, x1 + 5, y2, fill="white", outline="")
        tl.create_rectangle(x2 - 5, y1, x2, y2, fill="white", outline="")

    def _t_to_x(self, t, W=None):
        if W is None:
            W = self._tl.winfo_width() or 800
        return int(t / max(self.duration, 0.001) * W)

    def _x_to_t(self, x, W=None):
        if W is None:
            W = self._tl.winfo_width() or 800
        return max(0.0, min(self.duration, x / W * self.duration))

    # ── Timeline interaction ─────────────────────────────────────

    def _tl_click(self, e):
        W = self._tl.winfo_width()
        t = self._x_to_t(e.x, W)
        self._sel_seg = None
        self._drag_seg = None

        # Check if clicking on a segment handle or body
        for seg in self.segments:
            x1 = self._t_to_x(seg.t_start, W)
            x2 = self._t_to_x(seg.t_end,   W)
            y1, y2 = self.SEG_Y, self.SEG_Y + self.SEG_H
            if y1 <= e.y <= y2:
                if x1 <= e.x <= x1 + 7:
                    self._drag_seg = (seg, "left", e.x, seg.t_start, seg.t_end)
                    self._sel_seg = seg
                    break
                elif x2 - 7 <= e.x <= x2:
                    self._drag_seg = (seg, "right", e.x, seg.t_start, seg.t_end)
                    self._sel_seg = seg
                    break
                elif x1 <= e.x <= x2:
                    self._drag_seg = (seg, "move", e.x, seg.t_start, seg.t_end)
                    self._sel_seg = seg
                    break

        if not self._sel_seg:
            # Seek
            self._seek(t)

        self._draw_timeline()
        self._update_seg_props()
        self._update_preview(self._playhead)

    def _tl_drag(self, e):
        if not self._drag_seg:
            return
        seg, dtype, sx, ot_start, ot_end = self._drag_seg
        W  = self._tl.winfo_width()
        dt = self._x_to_t(e.x - sx, W)   # delta time

        if dtype == "left":
            seg.t_start = max(0, min(ot_end - 0.1, ot_start + dt))
        elif dtype == "right":
            seg.t_end = max(ot_start + 0.1, min(self.duration, ot_end + dt))
        elif dtype == "move":
            dur = ot_end - ot_start
            seg.t_start = max(0, min(self.duration - dur, ot_start + dt))
            seg.t_end   = seg.t_start + dur

        self._draw_timeline()
        self._update_preview(seg.t_start + (seg.t_end - seg.t_start) / 2)

    def _tl_release(self, e):
        self._drag_seg = None

    def _tl_right_click(self, e):
        W = self._tl.winfo_width()
        t = self._x_to_t(e.x, W)
        menu = tk.Menu(self, tearoff=0, bg=T.CARD, fg=T.TEXT,
                       activebackground=T.BLUE, font=("Segoe UI", 9))
        menu.add_command(label=f"Add Zoom at {t:.2f}s",
                         command=lambda: self._add_zoom(t))
        # Check if right-click on segment
        for seg in self.segments:
            x1 = self._t_to_x(seg.t_start, W)
            x2 = self._t_to_x(seg.t_end, W)
            if x1 <= e.x <= x2 and self.SEG_Y <= e.y <= self.SEG_Y + self.SEG_H:
                menu.add_separator()
                menu.add_command(label="Delete this zoom",
                                 command=lambda s=seg: self._delete_seg(s))
                break
        menu.tk_popup(e.x_root, e.y_root)

    # ── Playback ─────────────────────────────────────────────────

    def _toggle_play(self):
        if self._play_running:
            self._play_running = False
            self._play_btn.config(text="▶ Play", bg=T.GREEN)
        else:
            self._play_running = True
            self._play_btn.config(text="⏸ Pause", bg=T.ORANGE)
            threading.Thread(target=self._play_loop, daemon=True).start()

    def _play_loop(self):
        fps = self.engine.fps
        step = 1.0 / fps
        t = self._playhead
        while self._play_running and t <= self.duration:
            t += step
            self._playhead = t
            self.after(0, self._draw_timeline)
            self.after(0, lambda tt=t: self._update_preview(tt))
            time.sleep(step)
        self._play_running = False
        self.after(0, lambda: self._play_btn.config(text="▶ Play", bg=T.GREEN))

    def _seek(self, t):
        self._playhead = max(0.0, min(self.duration, t))
        self._draw_timeline()
        self._update_preview(self._playhead)

    # ── Preview ──────────────────────────────────────────────────

    def _on_resize(self, e):
        self._update_preview(self._playhead)

    def _on_preview_click(self, e):
        """Click on preview → set zoom centre for selected segment."""
        if not self._sel_seg:
            return
        cw = self._preview_canvas.winfo_width()
        ch = self._preview_canvas.winfo_height()
        self._sel_seg.cx = e.x / cw
        self._sel_seg.cy = e.y / ch
        self._update_preview(self._playhead)

    def _update_preview(self, t):
        frames  = self.engine.raw_frames
        ftimes  = self.engine.frame_times
        if not frames:
            return

        # Find nearest frame
        idx = min(range(len(ftimes)), key=lambda i: abs(ftimes[i] - t))
        frame = frames[idx]
        pil = Image.fromarray(frame)

        # Apply zoom
        rend = Renderer(self.engine, self.segments, self._get_cfg())
        zoom_f, zcx, zcy = rend._zoom_factor_at(t)
        fw, fh = pil.size
        if zoom_f > 1.001:
            crop_w = fw / zoom_f
            crop_h = fh / zoom_f
            px = zcx * fw
            py = zcy * fh
            x1 = max(0, min(fw - crop_w, px - crop_w / 2))
            y1 = max(0, min(fh - crop_h, py - crop_h / 2))
            pil = pil.crop((x1, y1, x1 + crop_w, y1 + crop_h))

        # Fit to canvas
        cw = self._preview_canvas.winfo_width()  or 800
        ch = self._preview_canvas.winfo_height() or 450
        if cw < 10 or ch < 10:
            return
        pil.thumbnail((cw, ch), Image.BILINEAR)

        # Background
        cfg = self._get_cfg()
        if cfg["bg_color"] and cfg["padding"] > 0:
            bg = Image.new("RGB", (cw, ch), cfg["bg_color"])
            ox = (cw - pil.width)  // 2
            oy = (ch - pil.height) // 2
            bg.paste(pil, (ox, oy))
            pil = bg

        self._preview_photo = ImageTk.PhotoImage(pil)
        self._preview_canvas.delete("all")
        x_c = cw // 2
        y_c = ch // 2
        self._preview_canvas.create_image(x_c, y_c, anchor="center",
                                          image=self._preview_photo)

        # Zoom target crosshair for selected segment
        if self._sel_seg:
            seg = self._sel_seg
            tx = int(seg.cx * cw)
            ty = int(seg.cy * ch)
            r = 12
            self._preview_canvas.create_oval(tx-r, ty-r, tx+r, ty+r,
                                             outline=T.BLUE, width=2)
            self._preview_canvas.create_line(tx-r-4, ty, tx+r+4, ty,
                                             fill=T.BLUE, width=1)
            self._preview_canvas.create_line(tx, ty-r-4, tx, ty+r+4,
                                             fill=T.BLUE, width=1)
            self._preview_canvas.create_text(tx+r+6, ty, text="Zoom centre",
                                             fill=T.BLUE, anchor="w",
                                             font=("Segoe UI", 8))

        self._time_lbl.config(text=f"{t:.2f}s / {self.duration:.1f}s  |  "
                                   f"Zoom: ×{zoom_f:.2f}")

    # ── Segment management ───────────────────────────────────────

    def _add_zoom_at_playhead(self):
        self._add_zoom(self._playhead)

    def _add_zoom(self, t):
        dur = min(3.0, self.duration - t)
        if dur < 0.2:
            t = max(0, self.duration - 3.0)
            dur = min(3.0, self.duration)
        seg = ZoomSegment(t, t + dur, 0.5, 0.5, 2.2)
        self.segments.append(seg)
        self._sel_seg = seg
        self._draw_timeline()
        self._update_seg_props()
        self._update_preview(self._playhead)

    def _delete_seg(self, seg):
        if seg in self.segments:
            self.segments.remove(seg)
        if self._sel_seg is seg:
            self._sel_seg = None
        self._draw_timeline()
        self._update_preview(self._playhead)

    def _delete_selected(self):
        if self._sel_seg:
            self._delete_seg(self._sel_seg)

    def _update_seg_props(self):
        if self._sel_seg:
            self._seg_factor.set(self._sel_seg.factor)
            self._seg_label.set(self._sel_seg.label)

    def _apply_seg_props(self):
        if self._sel_seg:
            self._sel_seg.factor = self._seg_factor.get()
            self._sel_seg.label  = self._seg_label.get()
            self._draw_timeline()
            self._update_preview(self._playhead)

    def _pick_bg(self, e):
        c = colorchooser.askcolor(color=self._bg_color, title="Background colour")
        if c and c[1]:
            self._bg_color = c[1]
            self._bg_swatch.config(bg=c[1])

    def _get_cfg(self):
        return {
            "bg_color":    self._bg_color,
            "padding":     self._padding_var.get(),
            "corners":     self._corners_var.get(),
            "shadow":      self._shadow_var.get(),
            "click_ripple":self._ripple_var.get(),
            "cursor_size": self._cursor_sz.get(),
            "out_w":       self.engine.mon_info["width"],
            "out_h":       self.engine.mon_info["height"],
        }


# ════════════════════════════════════════════════════════════════
#  GUI — EXPORT SCREEN
# ════════════════════════════════════════════════════════════════

class ExportScreen(tk.Frame):
    def __init__(self, master, engine, segments, cfg, on_back):
        super().__init__(master, bg=T.BG)
        self.engine   = engine
        self.segments = segments
        self.cfg      = cfg
        self.on_back  = on_back
        self._path    = tk.StringVar(value=self._default_path())
        self._progress= tk.DoubleVar(value=0)
        self._running = False
        self._build()

    def _default_path(self):
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        return str(Path.home() / "Desktop" / f"zoomcast_{ts}.mp4")

    def _build(self):
        tk.Label(self, text="Export Recording",
                 bg=T.BG, fg=T.TEXT,
                 font=("Segoe UI", 18, "bold")).pack(pady=(32, 4))
        tk.Label(self, text="Render your final video with all zoom effects applied",
                 bg=T.BG, fg=T.MUTED, font=("Segoe UI", 10)).pack(pady=(0, 20))

        card = tk.Frame(self, bg=T.CARD)
        card.pack(padx=80, pady=10, fill="x")

        # Path row
        prow = tk.Frame(card, bg=T.CARD)
        prow.pack(fill="x", padx=20, pady=(20, 8))
        tk.Label(prow, text="Save to:", bg=T.CARD, fg=T.TEXT,
                 font=("Segoe UI", 10), width=10, anchor="w").pack(side="left")
        tk.Entry(prow, textvariable=self._path, width=40,
                 bg=T.CARD2, fg=T.TEXT, insertbackground=T.TEXT,
                 relief="flat", font=("Segoe UI", 9)).pack(side="left", padx=6)
        tk.Button(prow, text="Browse", command=self._browse,
                  bg=T.BLUE, fg="white", relief="flat",
                  font=("Segoe UI", 9), padx=8, cursor="hand2").pack(side="left")

        # Summary
        dur  = self.engine.duration
        fps  = self.engine.fps
        fc   = self.engine.frame_count()
        ns   = len(self.segments)
        nc   = len(self.engine.click_data)
        summ = (f"{fc} frames  ·  {dur:.1f}s  ·  {fps} fps  ·  "
                f"{ns} zoom segment{'s' if ns!=1 else ''}  ·  {nc} clicks")
        tk.Label(card, text=summ, bg=T.CARD, fg=T.MUTED,
                 font=("Segoe UI", 9)).pack(pady=(0, 12))

        # Progress
        self._prog_bar = ttk.Progressbar(card, variable=self._progress,
                                         maximum=100, length=500)
        self._prog_bar.pack(pady=8)
        self._prog_lbl = tk.Label(card, text="", bg=T.CARD, fg=T.MUTED,
                                  font=("Segoe UI", 9))
        self._prog_lbl.pack(pady=(0, 20))

        # Buttons
        bf = tk.Frame(self, bg=T.BG)
        bf.pack(pady=16)
        tk.Button(bf, text="← Back to Editor", command=self.on_back,
                  bg=T.MUTED, fg="white", relief="flat",
                  font=("Segoe UI", 10), padx=14, pady=8,
                  cursor="hand2").pack(side="left", padx=6)
        self._export_btn = tk.Button(bf, text="⬆  Render & Export",
                  command=self._start_export,
                  bg=T.BLUE, fg="white", relief="flat",
                  font=("Segoe UI", 10, "bold"), padx=14, pady=8,
                  cursor="hand2")
        self._export_btn.pack(side="left", padx=6)

    def _browse(self):
        p = filedialog.asksaveasfilename(
            defaultextension=".mp4",
            filetypes=[("MP4 Video", "*.mp4"), ("All", "*.*")])
        if p:
            self._path.set(p)

    def _start_export(self):
        if self._running:
            return
        self._running = True
        self._export_btn.config(state="disabled", text="Rendering…")
        threading.Thread(target=self._render, daemon=True).start()

    def _render(self):
        rend = Renderer(self.engine, self.segments, self.cfg)
        path = self._path.get()
        def cb(v):
            self._progress.set(v * 100)
            self._prog_lbl.config(text=f"{int(v*100)}%  —  frame {int(v * self.engine.frame_count())} / {self.engine.frame_count()}")
            self.update_idletasks()
        ok = rend.render(path, cb)
        self.after(0, lambda: self._done(ok, path))

    def _done(self, ok, path):
        self._running = False
        self._export_btn.config(state="normal", text="⬆  Render & Export")
        if ok:
            messagebox.showinfo("Export Complete! 🎉",
                f"Your video has been saved to:\n\n{path}\n\n"
                f"Zoom segments: {len(self.segments)}  ·  "
                f"Duration: {self.engine.duration:.1f}s")
        else:
            messagebox.showerror("Export Failed", "Could not write output file.")


# ════════════════════════════════════════════════════════════════
#  ROOT APP — screen switching
# ════════════════════════════════════════════════════════════════

class ZoomCastApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("ZoomCast — Screen.studio for Windows")
        self.geometry("1100x760")
        self.minsize(900, 640)
        self.configure(bg=T.BG)
        self._screen = None
        self._show_recorder()
        self._style_ttk()

    def _style_ttk(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TCombobox",
                        fieldbackground=T.CARD2, background=T.CARD2,
                        foreground=T.TEXT, selectbackground=T.BLUE)
        style.configure("Horizontal.TProgressbar",
                        troughcolor=T.CARD2, background=T.BLUE,
                        lightcolor=T.BLUE, darkcolor=T.BLUE2)

    def _clear(self):
        if self._screen:
            self._screen.destroy()

    def _show_recorder(self):
        self._clear()
        self._screen = RecorderScreen(self, self._on_rec_done)
        self._screen.pack(fill="both", expand=True)

    def _on_rec_done(self, engine, auto_zoom):
        self._engine = engine
        self._auto_zoom = auto_zoom
        self._show_editor(engine, auto_zoom)

    def _show_editor(self, engine, auto_zoom):
        self._clear()
        self._screen = EditorScreen(
            self, engine, auto_zoom,
            on_back   = self._show_recorder,
            on_export = self._on_export
        )
        self._screen.pack(fill="both", expand=True)

    def _on_export(self, engine, segments, cfg):
        self._clear()
        self._screen = ExportScreen(
            self, engine, segments, cfg,
            on_back = lambda: self._show_editor(engine, False)
        )
        self._screen.pack(fill="both", expand=True)


# ════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    app = ZoomCastApp()
    app.mainloop()
