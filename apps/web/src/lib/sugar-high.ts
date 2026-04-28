import { highlight } from "sugar-high"

export function highlightCode(code: string): string {
	return highlight(code)
}
