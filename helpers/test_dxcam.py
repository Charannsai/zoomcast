import dxcam
import os
import sys

print("dxcam imported")
camera = dxcam.create(output_color="BGRA")
frame = camera.grab()
if frame is not None:
    print("Frame grabbed! Shape:", frame.shape)
else:
    print("Failed to grab frame.")
