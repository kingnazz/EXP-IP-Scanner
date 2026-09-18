#!/usr/bin/env python3
"""Vectorise the supplied EXP IP Scanner logo into the SVG the product uses.

The logo arrived as a raster (`brand/exp-ip-scanner-logo.webp`). A raster cannot
be recoloured for the dark theme and goes soft on a high-DPI display, so the
artwork is traced once, here, and the traced SVG is what ships. This script is
the record of how `brand/exp-ip-scanner-logo.svg` was produced; it is not part
of the build and CI never runs it.

The trace is split into three groups, because they are three different colours
in use rather than three different shapes:

  brand   the orange oval, the signal arcs and the dot in the P -- always the
          brand orange, in both themes
  mark    the "exp" letters, which sit *inside* the orange oval and therefore
          stay dark in both themes
  word    "IP Scanner", which is the only part that follows the theme, so it
          is emitted without a fill and inherits `currentColor`

Requires potrace and Pillow:
  apt-get install potrace && pip install pillow numpy

Usage:
  python3 scripts/trace-logo.py

Writes:
  brand/exp-ip-scanner-logo.svg        the traced master
  src/components/BrandLogo.tsx         the same paths as a themed React component
  site/assets/exp-ip-scanner-logo.svg  the website's copy, for light sections
  site/assets/exp-ip-scanner-logo-light.svg   the same, for the dark footer
"""
import os
import re
import subprocess
import tempfile

import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SOURCE = os.path.join(ROOT, "brand", "exp-ip-scanner-logo.webp")

# The two colours in the artwork. The source samples at #f9891f and #1a1c20;
# the orange is emitted as EXP Technical's published brand orange instead,
# which the website already uses as `--orange`. The two are a hair apart and
# the difference is invisible, but one value across the app, the website and
# the icons is worth more than being faithful to a JPEG-ish sample.
BRAND_ORANGE = "#f58f31"
BRAND_DARK = "#1a1c20"

# The column the "exp" mark ends at and "IP Scanner" begins after, in source
# pixels. The source has a clean 130px gap there (727..856), so the split does
# not cut a letter in half.
WORDMARK_SPLIT_X = 790


def composited():
    """The source over white, as float RGB. The webp carries an alpha channel."""
    rgba = np.array(Image.open(SOURCE).convert("RGBA")).astype(float)
    rgb, alpha = rgba[..., :3], rgba[..., 3:4] / 255.0
    return rgb * alpha + 255 * (1 - alpha)


def masks():
    """The three ink masks, cropped to the artwork's own bounding box."""
    img = composited()
    r, g, b = img[..., 0], img[..., 1], img[..., 2]

    orange = (r > 170) & (g > 70) & (g < 200) & (b < 130)
    dark = (r < 130) & (g < 130) & (b < 150)

    ink = orange | dark
    ys, xs = np.where(ink)
    box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    print(f"  artwork {box[2] - box[0]}x{box[3] - box[1]} at {box[:2]}")

    def crop(m):
        return m[box[1] : box[3], box[0] : box[2]]

    split = WORDMARK_SPLIT_X - box[0]
    left = np.zeros_like(dark, dtype=bool)
    left[:, :WORDMARK_SPLIT_X] = True

    return (
        {
            "brand": crop(orange),
            "mark": crop(dark & left),
            "word": crop(dark & ~left),
        },
        (box[2] - box[0], box[3] - box[1]),
        split,
    )


def trace(mask, name):
    """Run potrace over one mask and return its path data, in source pixels."""
    with tempfile.TemporaryDirectory() as tmp:
        pbm = os.path.join(tmp, f"{name}.pbm")
        svg = os.path.join(tmp, f"{name}.svg")
        # PIL mode "1" is 0=black; potrace traces the black.
        Image.fromarray(np.where(mask, 0, 255).astype("uint8")).convert("1").save(pbm)
        subprocess.run(
            # --turdsize drops specks left by the raster's antialiasing;
            # --alphamax keeps the letterforms' corners crisp rather than
            # rounding them into the curve fit.
            ["potrace", "--svg", "--turdsize", "4", "--alphamax", "1.0", "-o", svg, pbm],
            check=True,
        )
        out = open(svg, encoding="utf-8").read()

    # potrace emits one <g> holding the whole trace, in tenths of a pixel with
    # the Y axis flipped. Both are folded into the group transform, which is
    # reused verbatim so the paths stay in the source's own coordinates.
    transform = re.search(r'<g transform="([^"]+)"', out).group(1)
    paths = re.findall(r'<path d="([^"]+)"', out)
    d = " ".join(p.strip() for p in paths)
    print(f"  {name}: {len(paths)} contours, {len(d) / 1024:.1f} KB")
    return transform, d


def groups():
    ink, (width, height), split = masks()
    traced = {name: trace(mask, name) for name, mask in ink.items()}
    return traced, width, height, split


TITLE = "EXP IP Scanner"


def svg_document(traced, width, height, word_fill):
    """The traced artwork as a standalone SVG file."""
    body = []
    for name, fill in (("brand", BRAND_ORANGE), ("mark", BRAND_DARK), ("word", word_fill)):
        transform, d = traced[name]
        body.append(f'  <g transform="{transform}" fill="{fill}">\n    <path d="{d}"/>\n  </g>')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}"'
        f' role="img" aria-label="{TITLE}">\n'
        f"  <title>{TITLE}</title>\n" + "\n".join(body) + "\n</svg>\n"
    )


COMPONENT = '''// The EXP IP Scanner logo, traced from `brand/exp-ip-scanner-logo.webp` by
// `scripts/trace-logo.py`. Do not edit the path data by hand: re-run the script.
//
// Three groups, because three different rules apply. The oval, the signal arcs
// and the dot in the P are always the brand orange. The "exp" letters sit
// inside the orange oval, so they stay dark in both themes. "IP Scanner" is the
// only part that follows the theme, and it does so through `currentColor`
// rather than a token of its own, so it is simply the colour of the text it
// sits next to.

/** The full logo. Width follows from the height; the artwork is {ratio} wide. */
export function BrandLogo({{ height = 20, className }}: {{ height?: number; className?: string }}) {{
  return (
    <svg
      viewBox="0 0 {width} {height_px}"
      height={{height}}
      width={{Math.round(height * {ratio_num})}}
      role="img"
      aria-label="EXP IP Scanner"
      className={{className}}
    >
      <title>EXP IP Scanner</title>
      <g transform="{brand_t}" fill="{orange}">
        <path d="{brand_d}" />
      </g>
      <g transform="{mark_t}" fill="{dark}">
        <path d="{mark_d}" />
      </g>
      <g transform="{word_t}" fill="currentColor">
        <path d="{word_d}" />
      </g>
    </svg>
  );
}}
'''


def main():
    print("EXP IP Scanner logo")
    traced, width, height, _ = groups()
    ratio = width / height

    master = os.path.join(ROOT, "brand", "exp-ip-scanner-logo.svg")
    with open(master, "w", encoding="utf-8") as f:
        f.write(svg_document(traced, width, height, BRAND_DARK))
    print(f"  brand/exp-ip-scanner-logo.svg ({os.path.getsize(master) / 1024:.1f} KB)")

    # The website has no theme switch, so each of its copies fixes the
    # wordmark rather than inheriting a colour: dark for the page, light for
    # the footer, which is the one dark band on it. The footer used to invert
    # the whole image to get white text, which turned the oval white too;
    # a second file keeps the oval orange where it belongs.
    #
    # These replace a 17 KB SVG that was a base64 PNG in an SVG wrapper: same
    # filename, real curves, half the size.
    for name, fill in (
        ("exp-ip-scanner-logo.svg", BRAND_DARK),
        ("exp-ip-scanner-logo-light.svg", "#f4f5f6"),
    ):
        site = os.path.join(ROOT, "site", "assets", name)
        os.makedirs(os.path.dirname(site), exist_ok=True)
        with open(site, "w", encoding="utf-8") as f:
            f.write(svg_document(traced, width, height, fill))
        print(f"  site/assets/{name} ({os.path.getsize(site) / 1024:.1f} KB)")

    component = os.path.join(ROOT, "src", "components", "BrandLogo.tsx")
    with open(component, "w", encoding="utf-8") as f:
        f.write(
            COMPONENT.format(
                width=width,
                height_px=height,
                ratio=f"{ratio:.3f}:1",
                ratio_num=f"{ratio:.4f}",
                orange=BRAND_ORANGE,
                dark=BRAND_DARK,
                brand_t=traced["brand"][0],
                brand_d=traced["brand"][1],
                mark_t=traced["mark"][0],
                mark_d=traced["mark"][1],
                word_t=traced["word"][0],
                word_d=traced["word"][1],
            )
        )
    print(f"  src/components/BrandLogo.tsx ({os.path.getsize(component) / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
