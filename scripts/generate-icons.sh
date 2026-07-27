#!/usr/bin/env bash
# Regenerate every raster app icon from the single source of truth,
# apps/landing/public/favicon.svg (amber tile + Geist SemiBold "M").
#
# Requires librsvg + imagemagick:  brew install librsvg imagemagick
#
# Only the glyph outline is read out of the source; the three tile variants
# below are generated around it, so the "M" is defined in exactly one place.
#
#   rounded    rx=6/32, glyph at its drawn size. The .svg itself and the 32px
#              .ico frame — drawn small but unmasked by browsers, so the tile
#              carries its own corner radius.
#   small      same tile, glyph scaled 1.33x about the centre. Used for the
#              16px .ico frame: at 16px the default glyph is under 7px tall
#              and antialiases into mush, so small frames get a tighter crop.
#   full-bleed rx=0 and opaque. logo192/logo512 are the apple-touch-icon and
#              the schema.org Organization logo — iOS applies its own corner
#              mask, so transparent corners render as black notches, and
#              Google wants a solid mark.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="apps/landing/public/favicon.svg"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

AMBER="#E8872B"
INK="#272219"

# The one thing every variant shares: the Geist SemiBold "M" outline.
GLYPH="$(sed -n 's/.*<path d="\([^"]*\)".*/\1/p' "$SRC")"
[ -n "$GLYPH" ] || { echo "could not read glyph path from $SRC" >&2; exit 1; }

tile() { # tile <rx> <glyph-scale> <out>
	local rx="$1" scale="$2" out="$3" g=""
	[ "$scale" = "1" ] || g="transform=\"translate(16 16) scale($scale) translate(-16 -16)\""
	cat > "$out" <<-SVG
		<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
		  <rect width="32" height="32" rx="$rx" fill="$AMBER"/>
		  <g $g><path d="$GLYPH" fill="$INK"/></g>
		</svg>
	SVG
}

tile 6 1     "$TMP/rounded.svg"
tile 6 1.33  "$TMP/small.svg"
tile 0 1     "$TMP/square.svg"

render() { rsvg-convert -w "$2" -h "$2" "$1" -o "$3"; }

# --- .ico: 16px from the tighter crop, 32px from the standard tile ----------
render "$TMP/small.svg"   16 "$TMP/16.png"
render "$TMP/rounded.svg" 32 "$TMP/32.png"
for app in landing web local-ui; do
	magick "$TMP/16.png" "$TMP/32.png" "apps/$app/public/favicon.ico"
done

# --- Expo web favicon -------------------------------------------------------
render "$TMP/rounded.svg" 48 apps/mobile/assets/favicon.png

# --- PWA / apple-touch-icon / schema.org logo -------------------------------
for size in 192 512; do
	render "$TMP/square.svg" "$size" "$TMP/logo$size.png"
	magick "$TMP/logo$size.png" -background "$AMBER" -alpha remove -alpha off "$TMP/flat$size.png"
	for app in landing web; do
		cp "$TMP/flat$size.png" "apps/$app/public/logo$size.png"
	done
done

echo "icons regenerated from $SRC"
