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
    
    camera.start(target_fps=fps, video_mode=True)
    
    running = True

    # We store the latest safely extracted python bytes here
    latest_bytes = None
    bytes_lock = threading.Lock()
    
    def listen_stdin():
        nonlocal running
        try:
            for line in sys.stdin:
                if line.strip() == "STOP":
                    running = False
                    break
        except Exception:
            running = False

    def grab_loop():
        nonlocal latest_bytes
        first = True
        while running:
            f = camera.get_latest_frame()
            if f is None:
                continue
                
            # Safely extract from DirectX memory into purely Python memory
            b = f.tobytes()
            with bytes_lock:
                latest_bytes = b
                
    def write_loop():
        nonlocal latest_bytes
        
        # Wait for the first bytes to be available
        while latest_bytes is None and running:
            time.sleep(0.005)
            
        if not running: return
            
        print(f"READY {time.time() * 1000}", flush=True)
        start_time = time.perf_counter()
        frames_sent = 0
        
        while running:
            now = time.perf_counter()
            target_frames = int((now - start_time) * fps)
            
            # Catch up if FFmpeg stalled, or keep 1:1 if it's fine
            frames_to_write = max(0, target_frames - frames_sent)
            
            if frames_to_write > 0:
                with bytes_lock:
                    b = latest_bytes
                
                if b is not None:
                    for _ in range(frames_to_write):
                        try:
                            # Blocking write. If pipe full, this pauses here,
                            # but grab_loop continues flawlessly!
                            process.stdin.write(b)
                            frames_sent += 1
                        except Exception:
                            # FFmpeg exited early/broken pipe
                            break
            else:
                time.sleep(0.001)

    t_listener = threading.Thread(target=listen_stdin, daemon=True)
    t_grab = threading.Thread(target=grab_loop, daemon=True)
    t_write = threading.Thread(target=write_loop, daemon=True)
    
    t_listener.start()
    t_grab.start()
    t_write.start()
    
    # Wait for STOP signal
    try:
        while running:
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    except Exception:
        pass
        
    running = False
    
    camera.stop()
    
    if process.stdin:
        process.stdin.close()
    
    process.wait()
    sys.exit(0)

if __name__ == "__main__":
    main()
