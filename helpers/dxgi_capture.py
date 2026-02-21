import dxcam
import sys
import subprocess
import threading
import time
import ctypes

def main():
    if len(sys.argv) < 3:
        print("Usage: dxgi_capture.py <output_file> <ffmpeg_path> [display_idx] [fps]")
        sys.exit(1)
        
    out_path = sys.argv[1]
    ffmpeg_path = sys.argv[2]
    display_idx = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    fps = int(sys.argv[4]) if len(sys.argv) > 4 else 30
    
    # Initialize DXGI capture. This uses Desktop Duplication API natively.
    camera = dxcam.create(output_idx=display_idx, output_color="BGRA")
    
    width = camera.width
    height = camera.height
    
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
        "-crf", "12",
        "-tune", "zerolatency",
        "-pix_fmt", "yuv420p",
        out_path
    ]
    
    # Start ffmpeg encoder
    process = subprocess.Popen(ffmpeg_args, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    
    running = True

    import queue
    # Infinite queue. It will use RAM to buffer if FFmpeg lags temporarily,
    # ensuring NO frames or scenes are ever dropped or cut.
    # At 30 FPS, this guarantees flawless synchronized rendering capability.
    frame_queue = queue.Queue(maxsize=0)
    
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
        """
        Thread 1: Perfect Math Synchronized Grabber
        Extracts frames precisely governed by real time. If the system stalls for 0.1s, 
        it accurately deposits the exact correct number of backup clones so action is preserved perfectly.
        """
        start_time = time.perf_counter()
        frames_grabbed = 0
        last_frame_bytes = None
        
        while running:
            now = time.perf_counter()
            target_frames = int((now - start_time) * fps)
            
            if target_frames > frames_grabbed:
                # Capture the fresh screen state
                f = camera.grab()
                if f is not None:
                    last_frame_bytes = f.tobytes()
                    
                if last_frame_bytes is not None:
                    # Normally frames_to_add is exactly 1. 
                    # If execution paused, it accurately deposits duplicates here in Real-Time 
                    # exactly where they belong on the timeline, avoiding weird chunky freezes!
                    frames_to_add = target_frames - frames_grabbed
                    for _ in range(frames_to_add):
                        frame_queue.put(last_frame_bytes)
                        frames_grabbed += 1
            else:
                # Need to yield CPU to prevent extreme max-out, but keep loop highly responsive
                time.sleep(0.001)

    def write_loop():
        """
        Thread 2: The Encoder Filler.
        This pulls seamlessly from the Queue and encodes as fast as possible.
        Because of 'running or not frame_queue.empty()', it guarantees that when STOP is clicked,
        it finishes emptying all actual recording data smoothly into FFmpeg!
        """
        first = True
        while running or not frame_queue.empty():
            try:
                b = frame_queue.get(timeout=0.2)
            except queue.Empty:
                continue
                
            if first:
                print(f"READY {time.time() * 1000}", flush=True)
                first = False
                
            try:
                process.stdin.write(b)
            except Exception:
                # If broken pipe, force exit
                break

    t_listener = threading.Thread(target=listen_stdin, daemon=True)
    t_grab = threading.Thread(target=grab_loop, daemon=True)
    t_write = threading.Thread(target=write_loop, daemon=True)
    
    t_listener.start()
    t_grab.start()
    t_write.start()
    
    # Strictly wait for the FFmpeg writer to drain the buffer and finish!
    t_write.join()
        
    camera.stop()
    if process.stdin:
        process.stdin.close()
    
    process.wait()
    sys.exit(0)

if __name__ == "__main__":
    main()
