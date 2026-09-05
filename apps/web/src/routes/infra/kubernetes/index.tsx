import { createFileRoute, redirect } from "@tanstack/react-router"
import { Schema } from "effect"

import { TimeRangeSearchFields } from "@/components/time-range-picker/search"

/**
 * The section root. The sidebar's single Kubernetes row points here, and the
 * breadcrumb does too; both land on the first view with the window intact.
 *
 * A redirect rather than a page of its own: a separate overview was descoped
 * (2026-07) in favour of the lists carrying their fleet band inline, so there
 * is nothing for this URL to show that Pods doesn't already.
 */

const searchSchema = Schema.Struct(TimeRangeSearchFields)

export const Route = createFileRoute("/infra/kubernetes/")({
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
	beforeLoad: ({ search }) => {
		throw redirect({ to: "/infra/kubernetes/pods", search, replace: true })
	},
})
