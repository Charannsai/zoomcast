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
    
    # We use camera.start(video_mode=True). DXCam spins up a native 
    # highly accurate background thread to guarantee strict 60FPS 
    # frame intervals, completely bypassing Python's terrible sleep() latency.
    camera.start(target_fps=fps, video_mode=True)
    
    running = True

    import queue
    frame_queue = queue.Queue(maxsize=300)
    
    def process_loop():
        first_frame = True
        while running:
            # Blocks precisely until the next 1/60th second frame is ready
            # Returns exactly 60 duplicated or new frames per second.
            f = camera.get_latest_frame()
            if f is None:
                # Should not happen in video_mode=True, but safety fallback.
                time.sleep(0.001)
                continue
                
            if first_frame:
                print(f"READY {time.time() * 1000}", flush=True)
                first_frame = False
                
            try:
                # Put to queue instantly so FFmpeg pipe lag never stalls the DXCam loop
                frame_queue.put_nowait(f)
            except queue.Full:
                pass # Drop frame only if FFmpeg is completely deadlocked >5s behind

    def ffmpeg_loop():
        while running:
            try:
                # Get frames in sequential order from queue
                f = frame_queue.get(timeout=0.1)
                process.stdin.write(f.tobytes())
            except queue.Empty:
                continue
            except Exception:
                break
                
    t_proc = threading.Thread(target=process_loop, daemon=True)
    t_ffmpeg = threading.Thread(target=ffmpeg_loop, daemon=True)
    
    t_proc.start()
    t_ffmpeg.start()
    
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
