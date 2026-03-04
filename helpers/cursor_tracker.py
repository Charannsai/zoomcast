"""
ZoomCast — Cursor & Click Tracker
Outputs JSON events to stdout for the Electron main process.
Uses pynput for global mouse event detection.
"""

import sys
import json
import time
import threading
from pynput import mouse
import ctypes
import queue

try:
    ctypes.windll.user32.SetProcessDPIAware()
except Exception:
    pass

def main():
    q = queue.Queue()
    running = True

    def writer_thread():
        while running:
            try:
                event = q.get(timeout=0.1)
                sys.stdout.write(json.dumps(event) + "\n")
                sys.stdout.flush()
            except queue.Empty:
                pass
            except Exception:
                pass

    t_writer = threading.Thread(target=writer_thread, daemon=True)
    t_writer.start()

    def on_click(x, y, button, pressed):
        if pressed:
            event = {
                "type": "click",
                "x": x,
                "y": y,
                "button": "left" if button == mouse.Button.left else "right",
                "time": time.time()
            }
            try:
                q.put_nowait(event)
            except:
                pass

    listener = mouse.Listener(on_click=on_click)
    listener.start()

    # Wait for STOP signal from stdin
    try:
        for line in sys.stdin:
            if line.strip() == "STOP":
                break
    except:
        pass

    running = False
    listener.stop()

if __name__ == "__main__":
    main()
