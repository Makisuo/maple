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
