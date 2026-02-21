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
    
    # Do not rely on DXCAM's internal video_mode timer, it drops frames.
    camera.start(target_fps=fps, video_mode=False)
    
    running = True

    def capture_loop():
        first_frame = True
        interval = 1.0 / fps
        next_time = time.perf_counter()
        last_frame = None
        
        # Poll dxcam as fast as possible for the absolute newest frame
        while running:
            now = time.perf_counter()
            if now >= next_time:
                # At this exact wall-clock moment, we MUST push a frame to ffmpeg
                frame = camera.get_latest_frame()
                if frame is not None:
                    last_frame = frame
                    
                if last_frame is not None:
                    if first_frame:
                        # Output exactly the time the frame was acquired
                        print(f"READY {time.time() * 1000}", flush=True)
                        first_frame = False
                    try:
                        process.stdin.write(last_frame.tobytes())
                    except Exception:
                        break
                next_time += interval
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
    camera.stop()
    if process.stdin:
        process.stdin.close()
    
    process.wait()
    sys.exit(0)

if __name__ == "__main__":
    main()
