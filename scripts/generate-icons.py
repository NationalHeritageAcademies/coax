#!/usr/bin/env python3
"""Generate Coax's platform icon set from build/icon.svg.

Outputs:
  build/icon.png     1024x1024 (used by macOS .icns generation + Linux)
  build/icon.ico     multi-resolution .ico for Windows (16/24/32/48/64/128/256)

electron-builder picks these up automatically (see electron-builder.yml).
The source of truth is build/icon.svg; re-run this script after editing it.

Usage:
  python3 scripts/generate-icons.py
"""
from __future__ import annotations

from pathlib import Path
import io

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT / "build" / "icon.svg"
PNG_OUT = ROOT / "build" / "icon.png"
ICO_OUT = ROOT / "build" / "icon.ico"

# Sizes baked into the .ico. The 256 entry uses lossless PNG compression
# (Windows supports it from Vista onward); smaller entries are flat BMPs
# inside the container, which is what we want for crisp small-size rendering.
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def render_png(size: int) -> Image.Image:
    """Render the SVG at the requested square size via cairosvg, return RGBA."""
    if not SVG.exists():
        raise SystemExit(f"missing source SVG: {SVG}")
    data = cairosvg.svg2png(
        url=str(SVG),
        output_width=size,
        output_height=size,
    )
    return Image.open(io.BytesIO(data)).convert("RGBA")


def main() -> None:
    # Master PNG at 1024 — used directly for macOS .app icon (electron-builder
    # converts to .icns via iconutil) and as the Linux desktop icon.
    master = render_png(1024)
    master.save(PNG_OUT, format="PNG", optimize=True)
    print(f"wrote {PNG_OUT.relative_to(ROOT)} ({master.size[0]}x{master.size[1]})")

    # Windows .ico — render each size individually rather than downscaling
    # from 1024, so cairosvg's crisp SVG rasterizer handles small-size
    # pixel snapping (no soft, downscaled mush at 16/24).
    frames = [render_png(s) for s in ICO_SIZES]
    frames[0].save(
        ICO_OUT,
        format="ICO",
        sizes=[(f.size[0], f.size[1]) for f in frames],
        append_images=frames[1:],
    )
    sizes = ",".join(str(s) for s in ICO_SIZES)
    print(f"wrote {ICO_OUT.relative_to(ROOT)} (sizes: {sizes})")


if __name__ == "__main__":
    main()
