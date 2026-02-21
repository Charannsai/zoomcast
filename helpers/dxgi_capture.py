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

    def capture_loop():
        first_frame = True
        last_frame = None
        frames_sent = 0
        start_time = None
        
        while running:
            # Need to pick up the very first unblocked frame to clock ZERO.
            if start_time is None:
                frame = camera.grab()
                if frame is not None:
                    last_frame = frame
                    start_time = time.perf_counter()
                    print(f"READY {time.time() * 1000}", flush=True)
                    first_frame = False
                    
                    try:
                        process.stdin.write(last_frame.tobytes())
                        frames_sent += 1
                    except Exception:
                        break
                else:
                    time.sleep(0.001)
                continue
            
            now = time.perf_counter()
            target_frames = int((now - start_time) * fps)
            
            if target_frames > frames_sent:
                # We need to send frames to catch up to wall-clock time
                frame = camera.grab()
                if frame is not None:
                    last_frame = frame
                
                if last_frame is not None:
                    try:
                        # Write exactly enough duplicates to lock FFmpeg timeline to physical time
                        frames_to_write = target_frames - frames_sent
                        for _ in range(frames_to_write):
                            process.stdin.write(last_frame.tobytes())
                            frames_sent += 1
                    except Exception:
                        break
            else:
                time.sleep(0.001)
                    
    cap_thread = threading.Thread(target=capture_loop, daemon=True)
    cap_thread.start()
    
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
