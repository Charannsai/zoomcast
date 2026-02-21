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

try:
    ctypes.windll.user32.SetProcessDPIAware()
except Exception:
    pass

def main():
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
                sys.stdout.write(json.dumps(event) + "\n")
                sys.stdout.flush()
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

    listener.stop()

if __name__ == "__main__":
    main()
