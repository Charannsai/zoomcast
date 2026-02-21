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
    
    # We will manually grab frames in a fast background thread, 
    # and use a strict wall-clock writer to feed FFmpeg perfectly.
    
    running = True

    # Shared state
    latest_frame = None
    frame_lock = threading.Lock()
    
    def grab_loop():
        nonlocal latest_frame
        while running:
            f = camera.grab()
            if f is not None:
                with frame_lock:
                    latest_frame = f
            else:
                time.sleep(0.002)

    def write_loop():
        nonlocal latest_frame
        
        # Wait for the first frame
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
                    # Write directly to FFmpeg. If FFmpeg lags, this blocks.
                    # When it unblocks, target_frames will be larger, and it will
                    # catch up by writing the CURRENT frame multiple times!
                    for _ in range(frames_to_write):
                        try:
                            process.stdin.write(f.tobytes())
                            frames_sent += 1
                        except Exception:
                            # Broken pipe, FFmpeg died
                            break
            else:
                # Sleep tiny amount to prevent high CPU usage when ahead of time
                time.sleep(0.001)
                
    t_grab = threading.Thread(target=grab_loop, daemon=True)
    t_write = threading.Thread(target=write_loop, daemon=True)
    
    t_grab.start()
    t_write.start()
    
    # Wait for STOP signal from Node.js (via stdin or simply closing stdin)
    try:
        for line in sys.stdin:
            if line.strip() == "STOP":
                break
    except KeyboardInterrupt:
        pass
        
    running = False
    
    # Terminate properly to flush FFmpeg buffers
    if process.stdin:
        process.stdin.close()
    
    process.wait()
    sys.exit(0)

if __name__ == "__main__":
    main()
