import { useEffect, useState } from "react"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"

export interface TemplateParameterField {
	key: string
	label: string
	description: string
	required: boolean
	placeholder?: string
}

interface ParameterDialogProps {
	open: boolean
	templateName: string
	parameters: readonly TemplateParameterField[]
	submitting: boolean
	onCancel: () => void
	onSubmit: (values: Record<string, string>) => void
}

export function ParameterDialog({
	open,
	templateName,
	parameters,
	submitting,
	onCancel,
	onSubmit,
}: ParameterDialogProps) {
	const [values, setValues] = useState<Record<string, string>>({})

	useEffect(() => {
		if (open) {
			setValues({})
		}
	}, [open])

	const missing = parameters.filter((p) => p.required && !values[p.key]?.trim()).map((p) => p.key)
	const canSubmit = missing.length === 0 && !submitting

	return (
		<Dialog open={open} onOpenChange={(value) => !value && !submitting && onCancel()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Configure {templateName}</DialogTitle>
					<DialogDescription>
						Provide values for the template parameters. Optional fields can be left blank.
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4 py-2"
					onSubmit={(e) => {
						e.preventDefault()
						if (!canSubmit) return
						const cleaned: Record<string, string> = {}
						for (const [k, v] of Object.entries(values)) {
							if (v.trim().length > 0) cleaned[k] = v.trim()
						}
						onSubmit(cleaned)
					}}
				>
					{parameters.map((param) => (
						<div key={param.key} className="flex flex-col gap-1.5">
							<Label htmlFor={`tpl-param-${param.key}`} className="text-xs font-medium">
								{param.label}
								{param.required && <span className="text-destructive ml-1">*</span>}
							</Label>
							<Input
								id={`tpl-param-${param.key}`}
								type="text"
								placeholder={param.placeholder}
								value={values[param.key] ?? ""}
								onChange={(e) => setValues((prev) => ({ ...prev, [param.key]: e.target.value }))}
								disabled={submitting}
							/>
							{param.description && (
								<span className="text-[10px] text-dim leading-relaxed">{param.description}</span>
							)}
						</div>
					))}
					<DialogFooter>
						<Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={submitting}>
							Cancel
						</Button>
						<Button type="submit" size="sm" disabled={!canSubmit}>
							{submitting ? "Creating..." : "Create dashboard"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
