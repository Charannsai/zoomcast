# ZoomCast — Screen.studio for Windows

> A professional screen recorder with cinematic zoom, click tracking, and a full post-recording editor.  
> Inspired by [screen.studio](https://screen.studio) — built entirely for Windows.

---

## 🚀 Quick Start

**Option A — Double-click:**
1. Double-click `Run_ZoomCast.bat`
2. It installs packages and opens ZoomCast

**Option B — Terminal:**
```
pip install mss pillow opencv-python numpy pynput pywin32
python zoomcast.py
```

---

## 📋 Requirements
- Windows 10 / 11
- Python 3.9+
- Packages installed automatically by the `.bat`

---

## 🎬 How It Works — Three Phases

### Phase 1: Record
- Hit **Start Recording** — screen is captured at your chosen FPS
- Your cursor and every click are tracked **separately** from the video
- This means you can reposition, restyle, or animate anything in post
- Hit **Stop** → click **Open Editor**

### Phase 2: Edit
The editor looks and works like Screen.studio:

| Feature | How to use |
|---|---|
| **Timeline thumbnail strip** | Full visual scrubbing of your recording |
| **Zoom segments (blue bars)** | Drag edges to resize, drag body to move |
| **Auto-generated zooms** | Automatically created from your clicks |
| **Add zoom manually** | Click "＋ Add Zoom" or right-click timeline |
| **Zoom centre** | Click anywhere in the preview to set zoom focus |
| **Zoom factor** | Slider in the Properties panel (1.3× to 5×) |
| **Padding + Background** | Add a branded background colour around your screen |
| **Rounded corners** | Slider for corner radius |
| **Drop shadow** | Toggle shadow beneath the recording |
| **Click ripples** | Beautiful animated ripples at every click in output |
| **Playback** | Play/pause to preview the final result |

### Phase 3: Export
- Choose output path
- Click **Render & Export**
- Progress bar tracks frame-by-frame rendering
- Output: **MP4 file** ready to share

---

## ✨ Key Features

- **Click-to-zoom** — every mouse click is tracked; auto-generates zoom segments centred on those clicks
- **Smooth zoom transitions** — cinematic ease-in/ease-out between normal and zoomed view
- **No cursor replacement** — your Windows cursor is kept exactly as-is
- **Click ripple animations** — white ripple ring appears at each click in the final video
- **Background padding** — add any colour around your recording with rounded corners + shadow
- **Drag-and-drop zoom editing** — resize and move zoom segments on the timeline
- **Real-time preview** — see exactly what the output will look like before rendering

---

## 🔧 Tips

- For the best auto-zoom results: click deliberately on UI elements you want highlighted
- To adjust where the zoom focuses: select a zoom segment, then **click on the preview** to reposition the zoom centre
- Right-click the timeline to add/delete zooms at any point
- Use padding + background for a polished "product demo" look