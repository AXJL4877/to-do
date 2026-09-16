"""PNG logo → transparent multi-size ICO (no white/cream plate)."""
from pathlib import Path
from PIL import Image

src = next(Path(r"d:\Desktop\to_do").glob("GT-Image-2.5-Sunb*.png"))
print("src", src)

img = Image.open(src).convert("RGBA")
w, h = img.size
px = img.load()

corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
br = sum(c[0] for c in corners) / 4
bg = sum(c[1] for c in corners) / 4
bb = sum(c[2] for c in corners) / 4
print("bg", round(br), round(bg), round(bb))

out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
op = out.load()
minx, miny, maxx, maxy = w, h, 0, 0
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        dr = abs(r - br) + abs(g - bg) + abs(b - bb)
        bright = (r + g + b) / 3
        if dr < 48 and bright > 200:
            continue
        if dr < 28 and bright > 170:
            continue
        op[x, y] = (r, g, b, a)
        if a > 8:
            minx = min(minx, x)
            miny = min(miny, y)
            maxx = max(maxx, x)
            maxy = max(maxy, y)

print("bbox", minx, miny, maxx, maxy)
crop = out.crop((minx, miny, maxx + 1, maxy + 1))
cw, ch = crop.size
side = max(cw, ch)
pad = max(2, int(side * 0.03))
canvas = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
canvas.paste(crop, ((canvas.size[0] - cw) // 2, (canvas.size[1] - ch) // 2), crop)

# 再放大一点，主体更饱满
scale = 1.15
big = canvas.resize(
    (int(canvas.size[0] * scale), int(canvas.size[1] * scale)),
    Image.Resampling.LANCZOS,
)
bbox = big.getbbox()
if bbox:
    big = big.crop(bbox)
s = max(big.size)
final = Image.new("RGBA", (s, s), (0, 0, 0, 0))
final.paste(big, ((s - big.size[0]) // 2, (s - big.size[1]) // 2), big)

sizes = [16, 24, 32, 48, 64, 128, 256]
icons = []
for sz in sizes:
    mark = final.resize((max(1, int(sz * 0.96)), max(1, int(sz * 0.96))), Image.Resampling.LANCZOS)
    layer = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    layer.paste(mark, ((sz - mark.size[0]) // 2, (sz - mark.size[1]) // 2), mark)
    icons.append(layer)

build = Path(r"d:\Desktop\to_do\todo-editor\build")
build.mkdir(parents=True, exist_ok=True)
ico = build / "icon.ico"
png = build / "icon.png"
public_png = Path(r"d:\Desktop\to_do\todo-editor\public\favicon.png")

icons[-1].save(png)
icons[-1].save(public_png)
icons[-1].save(ico, format="ICO", sizes=[(sz, sz) for sz in sizes])
print("wrote", ico, ico.stat().st_size)
print("wrote", png, png.stat().st_size)
