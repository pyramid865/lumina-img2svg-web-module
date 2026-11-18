import json, os
from PIL import Image, ImageDraw

im = Image.new("RGBA", (200, 200), (255, 255, 255, 255))
d = ImageDraw.Draw(im)
d.ellipse([40, 40, 160, 160], fill=(220, 60, 60, 255))
d.rectangle([80, 20, 120, 180], fill=(40, 80, 200, 255))
a = __import__("numpy").array(im)
out = os.path.join(os.path.dirname(__file__), "_smoke")
os.makedirs(out, exist_ok=True)
json.dump({"w": a.shape[1], "h": a.shape[0], "px": a.ravel().tolist()},
          open(os.path.join(out, "px.json"), "w"))
print("smoke image ok")
