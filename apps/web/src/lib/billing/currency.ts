const currencyFormatters = new Map<string, Intl.NumberFormat>()

/** Format an amount in dollars (Autumn totals are dollars, not cents). */
export function formatCurrency(amount: number, currency: string): string {
	const key = currency.toUpperCase()
	let formatter = currencyFormatters.get(key)
	if (!formatter) {
		formatter = new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: key,
			minimumFractionDigits: 2,
		})
		currencyFormatters.set(key, formatter)
	}
	return formatter.format(amount)
}
