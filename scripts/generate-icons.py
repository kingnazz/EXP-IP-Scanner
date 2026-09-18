#!/usr/bin/env python3
"""Render the EXP IP Scanner application icon at every size it ships in.

One master is drawn at 1024px and downscaled with a high-quality filter, so the
32px icon in the Windows taskbar is a sharpened version of the same artwork
rather than a separately hand-drawn one that drifts out of step.

The mark is a scan sweep: a node, and three arcs radiating from it. It is
deliberately plain -- flat colour, one accent, no gradient mesh, no glow --
because it sits next to File Explorer and Notepad in a technician's taskbar and
should look like it belongs there.

Usage:
  python3 scripts/generate-icons.py

Writes:
  src-tauri/icons/32x32.png, 128x128.png, 128x128@2x.png, icon.png, icon.ico
  public/icon.png                     (the window/tab icon)
  site/assets/favicon.png             (the website icon)
  site/assets/icon-512.png            (the website's product mark)
"""
import math
import os

from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

MASTER = 1024
# The tile: a deep slate, a touch blue, so the accent reads as a signal on it.
TILE_TOP = (22, 30, 41)
TILE_BOTTOM = (13, 18, 26)
# The one accent, matching --accent in the application's dark theme.
ACCENT = (45, 183, 214)
ACCENT_DIM = (24, 121, 145)


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def vertical_gradient(size, top, bottom):
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        grad.putpixel(
            (0, y),
            tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    return grad.resize((size, size), Image.Resampling.BILINEAR)


def draw_master():
    """The 1024px master, drawn at 4x and downscaled for clean edges."""
    scale = 4
    size = MASTER * scale
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    tile = vertical_gradient(size, TILE_TOP, TILE_BOTTOM).convert("RGBA")
    tile.putalpha(rounded_mask(size, round(size * 0.215)))
    canvas.alpha_composite(tile)

    draw = ImageDraw.Draw(canvas)

    # The node the sweep radiates from, set low-left so the arcs have room.
    origin = (round(size * 0.30), round(size * 0.715))
    node_r = round(size * 0.052)
    draw.ellipse(
        [origin[0] - node_r, origin[1] - node_r, origin[0] + node_r, origin[1] + node_r],
        fill=ACCENT,
    )

    # Three arcs, each thinner and dimmer than the last: a signal fading as it
    # travels, which is the honest metaphor for a network sweep.
    arcs = [
        (0.215, 0.040, ACCENT),
        (0.360, 0.034, ACCENT),
        (0.505, 0.028, ACCENT_DIM),
    ]
    for radius_f, width_f, colour in arcs:
        r = round(size * radius_f)
        w = round(size * width_f)
        box = [origin[0] - r, origin[1] - r, origin[0] + r, origin[1] + r]
        # Swept from due north round to due east: the quadrant pointing away
        # from the node into the rest of the tile.
        draw.arc(box, start=-96, end=-2, fill=colour, width=w)

    # A single found device out at the edge of the sweep: the point of the tool.
    far = round(size * 0.505)
    angle = math.radians(-49)
    dot = (
        round(origin[0] + far * math.cos(angle)),
        round(origin[1] + far * math.sin(angle)),
    )
    dot_r = round(size * 0.055)
    draw.ellipse(
        [dot[0] - dot_r, dot[1] - dot_r, dot[0] + dot_r, dot[1] + dot_r],
        fill=(255, 255, 255, 255),
    )

    return canvas.resize((MASTER, MASTER), Image.Resampling.LANCZOS)


def save(image, relpath, size):
    path = os.path.join(ROOT, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    image.resize((size, size), Image.Resampling.LANCZOS).save(path, "PNG", optimize=True)
    print(f"  {relpath} ({size}x{size})")


def main():
    master = draw_master()
    print("EXP IP Scanner icons")
    save(master, "src-tauri/icons/32x32.png", 32)
    save(master, "src-tauri/icons/128x128.png", 128)
    save(master, "src-tauri/icons/128x128@2x.png", 256)
    save(master, "src-tauri/icons/icon.png", 512)
    save(master, "public/icon.png", 256)
    save(master, "site/assets/favicon.png", 64)
    save(master, "site/assets/icon-512.png", 512)

    ico_path = os.path.join(ROOT, "src-tauri/icons/icon.ico")
    # Windows picks the nearest size from the .ico, so every size the shell
    # asks for is present rather than scaled from one bitmap.
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(ico_path, format="ICO", sizes=sizes)
    print(f"  src-tauri/icons/icon.ico ({', '.join(f'{w}x{h}' for w, h in sizes)})")


if __name__ == "__main__":
    main()
