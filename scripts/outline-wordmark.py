#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["fonttools[woff]>=4.53", "uharfbuzz>=0.39"]
# ///
"""Outline the Maple wordmark into `brand/`.

Run manually, commit the output:  ./scripts/outline-wordmark.py

This exists because a wordmark that ships as live `<text>` is not an asset —
it renders as a fallback face on any machine without Geist installed, which is
every machine we are handing it to. Paper's SVG export does not outline type
either (it emits a `foreignObject` with the HTML inlined, ~1.8 MB, and the text
still live), so the artboard defines the design and this defines the file.

The geometry is transcribed from the `09 — Wordmark / lockup` artboard in the
Maple Logo file, which in turn takes its proportions from the shipped nav
lockup in apps/landing/src/components/NavBar.tsx:

    mark 96px  ·  type 52px Geist Medium (wght 500)  ·  gap 37px
    tracking -0.02em  ·  vertically centred, line-height 56px

Type is positioned by HarfBuzz rather than by summing advance widths, so the
pair kerning Geist actually carries is the pair kerning that lands in the file.

The mark keeps its own fill separate from the type's so the two can be recoloured
independently downstream — the primary lockup is amber-on-ink, not one colour.
Both fills are flat: the mark's eyes and trunk notch are evenodd knockouts, and a
gradient shows through them at the wrong value.
"""

from __future__ import annotations

import re
import sys
import tempfile
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "apps/landing/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"
MARK_SRC = ROOT / "apps/landing/public/favicon.svg"
OUT = ROOT / "brand"

WORD = "Maple"
WEIGHT = 500
MARK_PX = 96
TYPE_PX = 52
GAP_PX = 37
LINE_PX = 56
TRACKING_EM = -0.02

MARK_FILL = "#E86F00"
TYPE_FILL = "#171410"


def mark_path() -> str:
    d = re.search(r'<path d="([^"]*)"', MARK_SRC.read_text())
    if not d:
        sys.exit(f"could not read glyph path from {MARK_SRC}")
    return d.group(1)


def main() -> None:
    if not FONT.exists():
        sys.exit(f"{FONT} missing — run `bun install` first")

    font = instantiateVariableFont(TTFont(FONT), {"wght": WEIGHT}, inplace=True)
    upem = font["head"].unitsPerEm
    glyphs = font.getGlyphSet()
    scale = TYPE_PX / upem

    # Shape through HarfBuzz so the pair kerning is the font's own — GPOS pulls
    # 25 units out of "Maple" that summing hmtx advances would leave in.
    #
    # Two things have to be right here, and both fail silently. The font handed
    # to HarfBuzz must be the *instanced* one, because advances vary along the
    # weight axis as much as outlines do. And `flavor` must be cleared before
    # saving, or fontTools re-compresses to woff2, HarfBuzz declines to parse it,
    # and every lookup returns .notdef with a uniform upem/2 advance — which
    # reads as a plausible monospaced result rather than as an error.
    font.flavor = None
    with tempfile.NamedTemporaryFile(suffix=".ttf") as tmp:
        font.save(tmp.name)
        buf = hb.Buffer()
        buf.add_str(WORD)
        buf.guess_segment_properties()
        hb.shape(hb.Font(hb.Face(hb.Blob.from_file_path(tmp.name))), buf)

    if any(i.codepoint == 0 for i in buf.glyph_infos):
        sys.exit("HarfBuzz returned .notdef — the face did not load")

    order = font.getGlyphOrder()
    track = TRACKING_EM * upem

    # CSS centres the line box, then seats the baseline inside it by half the
    # leftover leading. Reproducing that is what keeps this file interchangeable
    # with the live lockup rather than merely similar to it.
    asc, desc = font["hhea"].ascent, -font["hhea"].descent
    content = (asc + desc) * scale
    baseline = (MARK_PX - LINE_PX) / 2 + (LINE_PX - content) / 2 + asc * scale

    paths, pen_x = [], 0.0
    ink_top, ink_bottom = None, None
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        glyph = glyphs[order[info.codepoint]]
        pen = SVGPathPen(glyphs)
        glyph.draw(pen)
        if d := pen.getCommands():
            x = (pen_x + pos.x_offset) * scale
            y = baseline - pos.y_offset * scale
            paths.append(f'<path transform="translate({x:.3f} {y:.3f}) scale({scale:.6f} {-scale:.6f})" d="{d}"/>')

            # Track where the type actually puts ink, so the standalone wordmark
            # can be cropped to it. Inheriting the lockup's 96px box would ship a
            # file padded with whitespace nobody can see but everyone has to
            # centre around.
            bounds = BoundsPen(glyphs)
            glyph.draw(bounds)
            if bounds.bounds:
                _, y_min, _, y_max = bounds.bounds
                top, bottom = y - y_max * scale, y - y_min * scale
                ink_top = top if ink_top is None else min(ink_top, top)
                ink_bottom = bottom if ink_bottom is None else max(ink_bottom, bottom)
        pen_x += pos.x_advance + track

    # The trailing track is letter-spacing after the final glyph; CSS keeps it,
    # a wordmark must not — it would bake a gap into the right sidebearing.
    type_w = (pen_x - track) * scale
    total_w = MARK_PX + GAP_PX + type_w

    OUT.mkdir(exist_ok=True)
    head = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total_w:.3f} {MARK_PX}" '
        f'width="{total_w:.3f}" height="{MARK_PX}" role="img" aria-label="Maple">'
    )
    type_g = f'<g fill="{TYPE_FILL}">' + "".join(paths) + "</g>"
    mark_g = (
        f'<g fill="{MARK_FILL}" transform="scale({MARK_PX / 739:.7f})">'
        f'<path fill-rule="evenodd" d="{mark_path()}"/></g>'
    )

    (OUT / "lockup.svg").write_text(
        f"{head}\n  {mark_g}\n  "
        f'<g transform="translate({MARK_PX + GAP_PX} 0)">{type_g}</g>\n</svg>\n'
    )

    wm_h = ink_bottom - ink_top
    wm_head = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {ink_top:.3f} {type_w:.3f} {wm_h:.3f}" '
        f'width="{type_w:.3f}" height="{wm_h:.3f}" role="img" aria-label="Maple">'
    )
    (OUT / "wordmark.svg").write_text(f"{wm_head}\n  {type_g}\n</svg>\n")

    print(f"wrote {OUT}/lockup.svg and {OUT}/wordmark.svg ({total_w:.1f}×{MARK_PX})")


if __name__ == "__main__":
    main()
