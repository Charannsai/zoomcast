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
    
    first_frame = True
    start_time = None
    frames_sent = 0
    running = True

    def listen_stdin():
        nonlocal running
        try:
            for line in sys.stdin:
                if line.strip() == "STOP":
                    running = False
                    break
        except Exception:
            running = False

    t_listener = threading.Thread(target=listen_stdin, daemon=True)
    t_listener.start()
    
    # We will poll `get_latest_frame()` which native-blocks until exactly 1/60th sec.
    # It guarantees no stutter. However, if FFmpeg stutters, we just push exactly 
    # the amount of lost frames to catch up.
    
    try:
        while running:
            f = camera.get_latest_frame()
            if f is None:
                # Fallback safety if the renderer skips
                continue
                
            if first_frame:
                start_time = time.perf_counter()
                print(f"READY {time.time() * 1000}", flush=True)
                first_frame = False
            
            # The exact number of frames that SHOULD have been written by now
            now = time.perf_counter()
            target_frames = int((now - start_time) * fps)
            
            # Usually frames_to_write is 1. If FFmpeg lags, it might be 2 or 3.
            # If our loop is running faster than physical time (impossible with get_latest_frame, but safe), it's 0.
            frames_to_write = max(0, target_frames - frames_sent)
            
            if frames_to_write > 0:
                # Convert only once to save CPU
                f_bytes = f.tobytes()
                for _ in range(frames_to_write):
                    try:
                        process.stdin.write(f_bytes)
                        frames_sent += 1
                    except Exception:
                        break # FFmpeg closed

            # Process STDIN to catch the FAST STOP signal from JS
            # (select/poll on stdin is not safe in windows, so we relies on closing the pipe)
            
    except KeyboardInterrupt:
        pass
    except Exception as e:
        pass
        
    camera.stop()
    
    if process.stdin:
        process.stdin.close()
    
    process.wait()
    sys.exit(0)

if __name__ == "__main__":
    main()
