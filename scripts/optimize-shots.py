#!/usr/bin/env python3
"""Convert the captured screenshots to WebP for the website.

The capture script drives the real interface at twice the window's pixel
density, which keeps text crisp on a high-DPI laptop and on Windows at 150%
scaling -- and produces PNGs of around half a megabyte each. WebP carries the
same image at roughly a fifth of that, and every browser that can run the site
has supported it for years, so the site ships WebP only and there is no
fallback to keep in step.

Run through `npm run screenshots`, which captures and then converts:

  python3 scripts/optimize-shots.py

Reads and replaces site/assets/shots/*.png. The PNGs are deleted afterwards,
so only one copy of each image is committed.
"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit(
        "Pillow is required to convert the screenshots:\n"
        "  pip install Pillow\n"
        "(only needed when regenerating screenshots, not to build or run the app)"
    )

SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site", "assets", "shots")
# High enough that no compression artefact is visible on a screenshot of text.
QUALITY = 88


def main():
    if not os.path.isdir(SHOTS):
        sys.exit(f"no screenshot directory at {SHOTS}")

    pngs = sorted(f for f in os.listdir(SHOTS) if f.endswith(".png"))
    if not pngs:
        print("No PNGs to convert; the screenshots are already WebP.")
        return

    total_before = 0
    total_after = 0
    for name in pngs:
        png_path = os.path.join(SHOTS, name)
        webp_path = png_path[: -len(".png")] + ".webp"
        before = os.path.getsize(png_path)

        with Image.open(png_path) as image:
            # A screenshot has no transparency to keep, and dropping the alpha
            # channel saves a little more.
            image.convert("RGB").save(webp_path, "WEBP", quality=QUALITY, method=6)

        after = os.path.getsize(webp_path)
        os.remove(png_path)
        total_before += before
        total_after += after
        print(f"  {name[:-4]}.webp  {before // 1024} KiB -> {after // 1024} KiB")

    saved = 100 - round(total_after / total_before * 100)
    print(
        f"\n{len(pngs)} screenshots: {total_before // 1024} KiB -> "
        f"{total_after // 1024} KiB ({saved}% smaller)"
    )


if __name__ == "__main__":
    main()
