#!/usr/bin/env bash
# Regenerate every raster app icon from the single source of truth,
# apps/landing/public/favicon.svg (ink tile + amber tree, the "Soot" colorway).
#
# Requires librsvg + imagemagick:  brew install librsvg imagemagick
#
# Only the tree outline is read out of the source; every tile below is built
# around it, so the artwork is defined in exactly one place.
#
# Two properties of the mark drive the whole file:
#
#   * It is ONE evenodd path. The eyes and the notch beside the trunk are
#     knockouts, so the tile reads through them — every variant must keep
#     fill-rule="evenodd" and a flat tile fill, or the eyes fill in solid.
#   * It is drawn in its own 739-unit box and bottom-cropped: the trunk runs
#     to the very bottom edge. Tiles therefore seat it on a baseline 2.5 units
#     up from the bottom rather than optically centring it, which would read
#     bottom-heavy. Round (maskable) targets centre it instead, because there
#     is no baseline to speak of once the corners are gone.
#
# Variants:
#   rounded    rx=7/32, mark at its drawn size. The 32px .ico frame — drawn
#              small but unmasked by browsers, so the tile carries its own
#              corner radius.
#   small      same tile, mark 1.15x larger and re-seated. Used for the 16px
#              .ico frame: at 16px the eyes are barely a pixel wide and
#              antialias into a single blob, so small frames get a tighter crop.
#   square     rx=0 and opaque. logo192/logo512 are the apple-touch-icon and
#              the schema.org Organization logo — iOS applies its own corner
#              mask, so transparent corners render as black notches, and
#              Google wants a solid mark.
#   bare       no tile, transparent. Android's adaptive foreground (the system
#              draws the background from app.json) and the Expo splash, which
#              composites over its own backgroundColor.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="apps/landing/public/favicon.svg"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TILE="#171410"
MARK="#E86F00"

# The one thing every variant shares: the tree outline.
GLYPH="$(sed -n 's/.*<path d="\([^"]*\)".*/\1/p' "$SRC")"
[ -n "$GLYPH" ] || { echo "could not read glyph path from $SRC" >&2; exit 1; }

# Place the 739-unit mark inside the 32-unit tile.
#   place <mark-fraction-of-tile> <bottom-offset|centre>  ->  "translate() scale()"
#
# The tighter crop has to be re-seated rather than scaled about the centre:
# the mark's baseline already sits at y=29.5, so a naive scale about (16,16)
# pushes its bottom past y=32 and amputates the trunk.
place() {
	awk -v frac="$1" -v seat="$2" 'BEGIN {
		m = frac * 32
		x = (32 - m) / 2
		y = (seat == "centre") ? (32 - m) / 2 : 32 - seat - m
		printf "translate(%.4f %.4f) scale(%.7f)", x, y, m / 739
	}'
}

SEATED="$(place 0.7396 2.5)"     # tiles: 74% wide, trunk on a baseline
TIGHT="$(place 0.8505 1.5)"      # 16px frame: 1.15x the mark, still seated
CENTRED="$(place 0.5 centre)"    # maskable: inside Android's 66% safe circle
SPLASH="$(place 0.4 centre)"     # splash: the mark with room to breathe

tile() { # tile <rx|none> <mark-transform> <out>
	local rx="$1" inner="$2" out="$3" bg=""
	[ "$rx" = "none" ] || bg="<rect width=\"32\" height=\"32\" rx=\"$rx\" fill=\"$TILE\"/>"
	cat > "$out" <<-SVG
		<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
		  $bg
		  <g transform="$inner"><path d="$GLYPH" fill-rule="evenodd" fill="$MARK"/></g>
		</svg>
	SVG
}

tile 7    "$SEATED"  "$TMP/rounded.svg"
tile 7    "$TIGHT"   "$TMP/small.svg"
tile 0    "$SEATED"  "$TMP/square.svg"
tile none "$CENTRED" "$TMP/bare.svg"
tile none "$SPLASH"  "$TMP/splash.svg"

render() { rsvg-convert -w "$2" -h "$2" "$1" -o "$3"; }
flatten() { magick "$1" -background "$TILE" -alpha remove -alpha off "$2"; }

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
	flatten "$TMP/logo$size.png" "$TMP/flat$size.png"
	for app in landing web; do
		cp "$TMP/flat$size.png" "apps/$app/public/logo$size.png"
	done
done

# --- Expo native app icons --------------------------------------------------
# icon.png is the iOS/store icon: full-bleed and opaque, iOS masks its own
# corners. adaptive-icon.png and splash-icon.png stay transparent — Android
# and Expo supply the background from app.json, so baking a tile into the
# foreground would double it up and clip under the system mask.
render "$TMP/square.svg" 1024 "$TMP/icon.png"
flatten "$TMP/icon.png" apps/mobile/assets/icon.png
render "$TMP/bare.svg"   1024 apps/mobile/assets/adaptive-icon.png
render "$TMP/splash.svg" 1024 apps/mobile/assets/splash-icon.png

echo "icons regenerated from $SRC"
