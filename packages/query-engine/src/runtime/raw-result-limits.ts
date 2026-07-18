import {
	MAX_RAW_SQL_CELL_LENGTH,
	MAX_RAW_SQL_RESULT_BYTES,
	MAX_RAW_SQL_RESULT_ROWS,
} from "@maple/domain/http"

/** Return a caller-safe validation message when raw warehouse output exceeds a hard response limit. */
export const rawSqlResultLimitError = (
	rows: ReadonlyArray<Record<string, unknown>>,
): string | null => {
	if (rows.length > MAX_RAW_SQL_RESULT_ROWS) {
		return `Raw SQL results may contain at most ${MAX_RAW_SQL_RESULT_ROWS} rows`
	}

	let totalBytes = 2
	for (const row of rows) {
		for (const value of Object.values(row)) {
			if (typeof value === "string" && value.length > MAX_RAW_SQL_CELL_LENGTH) {
				return `Raw SQL result cells may contain at most ${MAX_RAW_SQL_CELL_LENGTH} characters`
			}
		}

		let encoded: string
		try {
			encoded = JSON.stringify(row) ?? "null"
		} catch {
			return "Raw SQL results must be JSON serializable"
		}
		totalBytes += new TextEncoder().encode(encoded).byteLength + 1
		if (totalBytes > MAX_RAW_SQL_RESULT_BYTES) {
			return `Raw SQL results may contain at most ${MAX_RAW_SQL_RESULT_BYTES} encoded bytes`
		}
	}

	return null
}
