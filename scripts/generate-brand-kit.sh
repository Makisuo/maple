#!/usr/bin/env bash
# Build the public brand kit served at https://maple.dev/brand.
#
# Requires librsvg + imagemagick:  brew install librsvg imagemagick
#
# Sibling to generate-icons.sh and deliberately shaped like it: the tree outline
# is read out of apps/landing/public/favicon.svg, so the artwork still lives in
# exactly one place, and the output is committed rather than built in CI (CI has
# no librsvg, and a marketing asset that only exists after a brew install is an
# asset that eventually 404s).
#
# The two properties of the mark that constrain every variant are the same ones
# generate-icons.sh calls out, and they matter more here because these files
# leave the building:
#
#   * It is ONE evenodd path. The eyes and the trunk notch are knockouts, so
#     whatever sits behind reads through them. Every variant keeps
#     fill-rule="evenodd" and a flat fill — a gradient shows through the eyes at
#     a different value than at the silhouette edge and they stop reading as
#     eyes.
#   * It is bottom-cropped: the trunk runs to the very bottom of its 739-unit
#     box. Bare variants ship that box untouched; only tiled variants re-seat it
#     on a baseline, because optically centring a bottom-cropped mark inside a
#     square reads bottom-heavy.
#
# What "colorway" means depends on the variant. On a tile it names a pair (Soot
# is amber-on-ink, Fired is ink-on-amber — the names come from the Maple Logo
# brand sheet). On a bare mark there is no tile, so it collapses to the mark's
# own fill and the files are named for the ink instead: amber / ink / white.
#
# TODO: the brand sheet carries a third tiled colorway, Glaze, used by the X
# header and avatar artboards (04/05). Its two values still have to be read out
# of the Paper file before it can be added to TILED below.
set -euo pipefail

cd "$(dirname "$0")/.."

MARK_SRC="apps/landing/public/favicon.svg"
LOCKUP_SRC="brand/lockup.svg"
WORDMARK_SRC="brand/wordmark.svg"
OUT="apps/landing/public/brand"

AMBER="#E86F00"
INK="#171410"
WHITE="#FFFFFF"
# The reversed lockup sets its type in bone rather than pure white: the brand
# sheet's dark grounds are warm, and #FFFFFF on them reads blue-ish and louder
# than the amber it sits next to. Pure white is kept for the mono cut, which has
# to survive grounds we do not control.
BONE="#E8E0D6"

PNG_SIZES=(256 512 1024)

GLYPH="$(sed -n 's/.*<path d="\([^"]*\)".*/\1/p' "$MARK_SRC")"
[ -n "$GLYPH" ] || { echo "could not read glyph path from $MARK_SRC" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/logo" "$OUT/wordmark" "$OUT/icons"

render() { rsvg-convert -w "$2" -h "$2" "$1" -o "$3"; }
# Lockups are wider than they are tall, so they are rendered to a width and left
# to find their own height. Passing both would squash them, and driving them off
# a height would make the number in the filename mean one thing for a square mark
# and another for a lockup — "-1024" has to mean the same size to a reader.
render_w() { rsvg-convert -w "$2" "$1" -o "$3"; }

# --- bare mark: the actual logo file ----------------------------------------
# Native 739 viewBox, no tile, no padding. This is what someone dropping the
# Maple logo into a deck or a README wants.
bare_mark() { # bare_mark <fill> <name>
	cat > "$OUT/logo/maple-mark-$2.svg" <<-SVG
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 739 739" width="739" height="739" role="img" aria-label="Maple">
		  <path d="$GLYPH" fill-rule="evenodd" fill="$1"/>
		</svg>
	SVG
	for size in "${PNG_SIZES[@]}"; do
		render "$OUT/logo/maple-mark-$2.svg" "$size" "$OUT/logo/maple-mark-$2-$size.png"
	done
}

bare_mark "$AMBER" amber
bare_mark "$INK"   ink
bare_mark "$WHITE" white

# --- tiled mark: the app-icon lockup ----------------------------------------
# Same geometry generate-icons.sh uses for the 32px favicon: 74% of the tile
# wide, seated 2.5 units off the bottom.
SEATED="$(awk 'BEGIN { m = 0.7396 * 32; printf "translate(%.4f %.4f) scale(%.7f)", (32 - m) / 2, 32 - 2.5 - m, m / 739 }')"

tiled_mark() { # tiled_mark <tile-fill> <mark-fill> <name>
	cat > "$OUT/logo/maple-mark-$3.svg" <<-SVG
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="Maple">
		  <rect width="32" height="32" rx="7" fill="$1"/>
		  <g transform="$SEATED"><path d="$GLYPH" fill-rule="evenodd" fill="$2"/></g>
		</svg>
	SVG
	for size in "${PNG_SIZES[@]}"; do
		render "$OUT/logo/maple-mark-$3.svg" "$size" "$OUT/logo/maple-mark-$3-$size.png"
	done
}

tiled_mark "$INK"   "$AMBER" soot
tiled_mark "$AMBER" "$INK"   fired

# --- lockup: mark + wordmark ------------------------------------------------
# brand/lockup.svg comes from scripts/outline-wordmark.py, which draws the
# `09 — Wordmark / lockup` artboard's spec with the type already converted to
# outlines — a wordmark that ships as live <text> renders in a fallback face on
# every machine that does not have Geist installed, which is all of them.
#
# The source carries exactly two flat fills, mark and type, so a colorway here is
# a pair of substitutions rather than a redraw: recoloring both to one value
# makes the mono cuts, recoloring only the type makes the reversed one. Each sed
# is anchored on the exact source hex so the two stay independent.
KIT_DIRS=(logo icons)

if [ -f "$LOCKUP_SRC" ]; then
	KIT_DIRS+=(wordmark)

	lockup() { # lockup <mark-fill> <type-fill> <name>
		sed -e "s/$AMBER/$1/g" -e "s/$INK/$2/g" "$LOCKUP_SRC" > "$OUT/wordmark/maple-lockup-$3.svg"
		for size in "${PNG_SIZES[@]}"; do
			render_w "$OUT/wordmark/maple-lockup-$3.svg" "$size" "$OUT/wordmark/maple-lockup-$3-$size.png"
		done
	}

	wordmark() { # wordmark <fill> <name>
		sed -e "s/$INK/$1/g" "$WORDMARK_SRC" > "$OUT/wordmark/maple-wordmark-$2.svg"
		for size in "${PNG_SIZES[@]}"; do
			render_w "$OUT/wordmark/maple-wordmark-$2.svg" "$size" "$OUT/wordmark/maple-wordmark-$2-$size.png"
		done
	}

	# The primary cut is the file as drawn, so it is copied rather than run
	# through a no-op substitution — a sed that silently stopped matching would
	# otherwise ship an unrecolored file under a colorway name.
	cp "$LOCKUP_SRC" "$OUT/wordmark/maple-lockup-primary.svg"
	for size in "${PNG_SIZES[@]}"; do
		render_w "$OUT/wordmark/maple-lockup-primary.svg" "$size" "$OUT/wordmark/maple-lockup-primary-$size.png"
	done

	lockup "$AMBER" "$BONE"  reversed
	lockup "$INK"   "$INK"   ink
	lockup "$WHITE" "$WHITE" white

	wordmark "$INK"   ink
	wordmark "$WHITE" white
else
	echo "warning: $LOCKUP_SRC missing — skipping the wordmark lockup." >&2
	echo "         Run scripts/outline-wordmark.py first." >&2
	rmdir "$OUT/wordmark"
fi

# --- icons: the shipped app icon set, copied in as-is -----------------------
# Not regenerated here. These are generate-icons.sh's output and the kit should
# hand out the exact bytes the product serves, not a second rendering of them.
cp apps/landing/public/favicon.svg  "$OUT/icons/favicon.svg"
cp apps/landing/public/favicon.ico  "$OUT/icons/favicon.ico"
cp apps/landing/public/logo192.png  "$OUT/icons/logo192.png"
cp apps/landing/public/logo512.png  "$OUT/icons/logo512.png"

# --- zip --------------------------------------------------------------------
# Named directories rather than `-r .` so the archive can live inside the
# directory it archives without swallowing itself on the next run.
( cd "$OUT" && zip -qr maple-brand-kit.zip "${KIT_DIRS[@]}" )

echo "brand kit written to $OUT"
