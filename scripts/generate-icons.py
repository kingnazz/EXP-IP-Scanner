#!/usr/bin/env python3
"""Render the EXP IP Scanner application icon at every size it ships in.

The icon is the brand mark reduced to the two things that survive being 16
pixels wide: the EXP orange, and the "exp" letters. The letters are lifted
straight out of `brand/exp-ip-scanner-logo.webp` rather than set in a typeface
that approximates them, so the icon and the logo are the same artwork.

Two things are deliberately left out. The oval, because filling the tile with
the orange *is* the oval -- keeping the outline would only shrink the letters
inside it, and at 24px, which is what the Windows taskbar actually asks for,
that is the difference between reading "exp" and seeing a smudge. And the
signal arcs from the logo's P, which are lovely at 512px and illegible below
64, and which would have meant shipping two different-looking icons for the
same application.

One master is drawn at 1024px and downscaled with a high-quality filter, so
every size is the same artwork rather than a set that drifts apart.

Usage:
  python3 scripts/generate-icons.py

Writes:
  src-tauri/icons/32x32.png, 128x128.png, 128x128@2x.png, icon.png, icon.ico
  public/icon.png                     (the window/tab icon)
  site/assets/favicon.png             (the website icon)
  site/assets/icon-512.png            (the website's product mark)
"""
import os

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SOURCE = os.path.join(ROOT, "brand", "exp-ip-scanner-logo.webp")

MASTER = 1024

# The EXP brand orange, and the near-black of the wordmark. The tile carries a
# barely-there gradient -- eight points of lightness top to bottom -- which
# reads as depth next to File Explorer without looking like a 2010 gel button.
TILE_TOP = (249, 150, 60)
TILE_BOTTOM = (238, 131, 30)
LETTERS = (26, 28, 32)

# How much of the tile's width the wordmark spans. Enough to be the icon rather
# than a label on it, with the remainder as the margin the shell expects.
LETTER_WIDTH = 0.78

# Where in the source the "exp" wordmark ends and "IP Scanner" begins. The same
# split `scripts/trace-logo.py` uses; the source has a clean 130px gap there.
WORDMARK_SPLIT_X = 790


def wordmark():
    """The "exp" letters from the logo, as an alpha mask cropped to their box.

    Taken from inside the orange oval, which is why the mask wanted here is the
    *dark* one: those pixels are the letterforms themselves.
    """
    rgba = np.array(Image.open(SOURCE).convert("RGBA")).astype(float)
    rgb, alpha = rgba[..., :3], rgba[..., 3:4] / 255.0
    composited = rgb * alpha + 255 * (1 - alpha)
    r, g, b = composited[..., 0], composited[..., 1], composited[..., 2]

    dark = (r < 130) & (g < 130) & (b < 150)
    dark[:, WORDMARK_SPLIT_X:] = False

    ys, xs = np.where(dark)
    mask = Image.fromarray((dark * 255).astype("uint8"), mode="L")
    return mask.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))


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

    letters = wordmark()
    width = round(size * LETTER_WIDTH)
    height = round(width * letters.height / letters.width)
    letters = letters.resize((width, height), Image.Resampling.LANCZOS)

    # Optically centred rather than measured-centred: the "p" descender hangs
    # below the other two letters, so centring the bounding box would leave the
    # word sitting visibly low.
    ink = Image.new("RGBA", (width, height), (*LETTERS, 255))
    ink.putalpha(letters)
    canvas.alpha_composite(ink, ((size - width) // 2, round(size * 0.46) - height // 2))

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
