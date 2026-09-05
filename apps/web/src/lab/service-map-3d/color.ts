const cube = (value: number): number => value * value * value

/** OKLCH → sRGB hex. Out-of-gamut channels clamp, which is fine for accent colors. */
export function oklchToHex(l: number, c: number, hDeg: number): string {
	const h = (hDeg * Math.PI) / 180
	const a = c * Math.cos(h)
	const b = c * Math.sin(h)

	const lp = cube(l + 0.3963377774 * a + 0.2158037573 * b)
	const mp = cube(l - 0.1055613458 * a - 0.0638541728 * b)
	const sp = cube(l - 0.0894841775 * a - 1.291485548 * b)

	const linear = [
		4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp,
		-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp,
		-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp,
	]

	const channels = linear.map((v) => {
		const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055
		return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
	})

	return `#${channels.map((v) => v.toString(16).padStart(2, "0")).join("")}`
}
