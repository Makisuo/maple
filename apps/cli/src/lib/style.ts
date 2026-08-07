// Tiny ANSI styling helpers. Colors are emitted only when stdout is a TTY and
// NO_COLOR is unset, so piped/redirected output stays plain and parseable.

const useColor = (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR)) && !process.env.NO_COLOR

const wrap =
	(open: number, close: number) =>
	(s: string): string =>
		useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s

export const bold = wrap(1, 22)
export const dim = wrap(2, 22)
export const underline = wrap(4, 24)
export const green = wrap(32, 39)
export const cyan = wrap(36, 39)
export const red = wrap(31, 39)
export const gray = wrap(90, 39)
/** Maple's amber/leaf accent (256-color). */
export const amber = (s: string): string => (useColor ? `\x1b[38;5;208m${s}\x1b[39m` : s)

/**
 * The Maple tree mark, quantised to half-blocks: 16 columns x 8 rows, where
 * each row packs two pixels of a 16x16 raster into one cell (▀ top, ▄ bottom,
 * █ both). Regenerate from the same path every other surface uses:
 *
 *   rsvg-convert -w 16 -h 16 -b white <mark>.svg -o m.png   # threshold 150
 *
 * 16px is the floor, not a preference. The mark's identity is the two eye
 * knockouts, and below 16 they smear into the crown — at 12px it is a blob.
 * That is why this is eight rows tall, and why it is printed as a left gutter
 * beside the banner rows rather than stacked above them: the banner already
 * runs eight or nine lines, so the mark costs no extra height.
 *
 * Shape carries without color, which is the point — half-blocks survive
 * NO_COLOR and a piped stdout. The emoji this replaced did neither, and it was
 * a maple *leaf* besides, while the brand mark is a tree.
 *
 * The eyes sit left of centre and the right shoulder stays solid. That is the
 * artwork, not a rounding error.
 */
export const MARK_LINES = [
	"    ▄▄████▄▄    ",
	"   ▄████████▄   ",
	" ▄████████████▄ ",
	"███  ██  ███████",
	"███  ██  ███████",
	" ▀████████████▀ ",
	"   ▀▀▀▀████▀▀   ",
	"     ██████     ",
] as const

/** Display width of one {@link MARK_LINES} row. */
export const MARK_WIDTH = 16
