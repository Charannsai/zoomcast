import dxcam
import sys
import subprocess
import threading
import time

def main():
    if len(sys.argv) < 3:
        print("Usage: dxgi_capture.py <output_file> <ffmpeg_path>")
        sys.exit(1)
        
    out_path = sys.argv[1]
    ffmpeg_path = sys.argv[2]
    
    # Initialize DXGI capture. This uses Desktop Duplication API natively!
    # By default, it DOES NOT capture the pointer shape.
    camera = dxcam.create(output_color="BGRA")
    
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
    
    # Start camera capture thread internally at 60fps
    camera.start(target_fps=fps, video_mode=True)
    
    running = True

    def capture_loop():
        # Read from dxcam queue
        while running:
            # get_latest_frame waits for a new frame based on target_fps
            frame = camera.get_latest_frame()
            if frame is not None:
                try:
                    process.stdin.write(frame.tobytes())
                except Exception as e:
                    break
                    
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
