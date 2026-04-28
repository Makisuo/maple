import type { BaseComponentProps } from "@json-render/react"

interface DataTableProps {
	headers: string[]
	rows: string[][]
	title?: string
}

function maybeFormatNumber(value: string): string {
	const num = Number(value)
	if (value.trim() !== "" && !Number.isNaN(num) && Number.isFinite(num)) {
		if (Number.isInteger(num)) return num.toLocaleString()
		return num.toLocaleString(undefined, { maximumFractionDigits: 4 })
	}
	return value
}

export function DataTable({ props }: BaseComponentProps<DataTableProps>) {
	const { headers, rows, title } = props

	return (
		<div className="space-y-1">
			{title && <p className="text-[11px] font-medium text-muted-foreground">{title}</p>}
			<div className="max-h-[300px] overflow-auto">
				<table className="w-full text-[11px]">
					<thead>
						<tr className="border-b border-border/40 text-left text-muted-foreground">
							{headers.map((h) => (
								<th key={h} className="pb-1 pr-2 font-medium">
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, i) => (
							<tr key={i} className="border-b border-border/20 last:border-0">
								{row.map((cell, j) => (
									<td key={j} className="max-w-[200px] truncate py-1 pr-2">
										{maybeFormatNumber(cell)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	)
}
