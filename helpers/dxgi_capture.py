import dxcam
import sys
import subprocess
import threading
import time
import ctypes

def main():
    if len(sys.argv) < 3:
        print("Usage: dxgi_capture.py <output_file> <ffmpeg_path> [display_idx]")
        sys.exit(1)
        
    out_path = sys.argv[1]
    ffmpeg_path = sys.argv[2]
    display_idx = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    
    # Initialize DXGI capture. This uses Desktop Duplication API natively!
    # By default, it DOES NOT capture the pointer shape.
    camera = dxcam.create(output_idx=display_idx, output_color="BGRA")
    
    width = camera.width
    height = camera.height
    fps = 60
    
    ffmpeg_args = [
        ffmpeg_path,
        "-y",
        "-f", "rawvideo",
        "-pix_fmt", "bgra",
        "-s", f"{width}x{height}",
        "-r", str(fps),
        "-i", "-", # read from stdin
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        out_path
    ]
    
    # Start ffmpeg encoder
    process = subprocess.Popen(ffmpeg_args, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    
    # We DO NOT use camera.start(). We will manually grab() to perfectly lock framerates.
    
    running = True

    import queue
    frame_queue = queue.Queue(maxsize=300)
    
    # We will share the latest frame across threads using a lock
    latest_frame = None
    frame_lock = threading.Lock()
    
    def grab_loop():
        nonlocal latest_frame
        while running:
            # We want to pull as fast as possible to make sure we always have the freshest possible frame
            # dxcam.grab() is generally quite fast and only captures when something changes or up to max 60hz.
            f = camera.grab()
            if f is not None:
                with frame_lock:
                    latest_frame = f
            time.sleep(0.005) # Yield thread slightly

    def write_loop():
        nonlocal latest_frame
        
        # Wait until we get the very first frame to start the wallclock
        while latest_frame is None and running:
            time.sleep(0.005)
            
        if not running: return
            
        print(f"READY {time.time() * 1000}", flush=True)
        
        start_time = time.perf_counter()
        frames_sent = 0
        
        while running:
            now = time.perf_counter()
            target_frames = int((now - start_time) * fps)
            
            if target_frames > frames_sent:
                frames_to_write = target_frames - frames_sent
                
                with frame_lock:
                    f = latest_frame
                
                if f is not None:
                    # Put EXACT amount of duplicates into queue so ffmpeg never loses a decimal second
                    for _ in range(frames_to_write):
                        try:
                            frame_queue.put_nowait(f)
                            frames_sent += 1
                        except queue.Full:
                            # If ffmpeg is deadlocked, we just skip buffering so we don't crash ram
                            pass
            else:
                time.sleep(0.001)

    def ffmpeg_loop():
        while running:
            try:
                f = frame_queue.get(timeout=0.1)
                process.stdin.write(f.tobytes())
            except queue.Empty:
                continue
            except Exception:
                break
                
    t_grab = threading.Thread(target=grab_loop, daemon=True)
    t_write = threading.Thread(target=write_loop, daemon=True)
    t_ffmpeg = threading.Thread(target=ffmpeg_loop, daemon=True)
    
    t_grab.start()
    t_write.start()
    t_ffmpeg.start()
    
    # Wait for STOP signal from Node.js (via stdin or simply closing stdin)
    try:
        for line in sys.stdin:
            if line.strip() == "STOP":
                break
    except KeyboardInterrupt:
        pass
        
    running = False
    
    # We didn't use camera.start(), so we don't need camera.stop()
    # just close the processes.
    if process.stdin:
        process.stdin.close()
    
    process.wait()
    sys.exit(0)

if __name__ == "__main__":
    main()
