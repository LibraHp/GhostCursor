"""Generate Windows icons and a 1024px macOS icon from the existing geometry."""
from pathlib import Path
from PIL import Image, ImageDraw

size = 1024
image = Image.new('RGBA', (size, size))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((32, 32, 992, 992), radius=232, fill='#f0f5ff')
mask = Image.new('L', image.size)
ImageDraw.Draw(mask).polygon([(260,176),(820,580),(560,628),(456,876)],fill=255)
gradient = Image.new('RGBA', image.size)
pixels = gradient.load()
for y in range(size):
    for x in range(size):
        t = min(1, max(0, (x + y - 400) / 1100))
        pixels[x,y] = (int(115*(1-t)+37*t),int(180*(1-t)+99*t),int(255*(1-t)+235*t),255)
image.paste(gradient, (0,0), mask)
out = Path(__file__).resolve().parent.parent / 'assets'
image.resize((256,256), Image.Resampling.LANCZOS).save(out/'icon.png')
image.save(out/'icon-mac.png')
image.save(out/'icon.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
