import { Link } from "@tanstack/react-router"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { LAB_ENTRIES, type LabEntry } from "@/lab/registry"

const SECTIONS: ReadonlyArray<{ kind: LabEntry["kind"]; title: string; blurb: string }> = [
	{
		kind: "lab",
		title: "Labs",
		blurb: "Component galleries over fixture data. Open one, change the component, watch it re-render.",
	},
	{
		kind: "bench",
		title: "Benches",
		blurb: "Synthetic perf harnesses. The Playwright gates in apps/web/perf drive these URLs; open them in a foreground tab when measuring by hand.",
	},
]

/**
 * `/lab` — the one page that lists every lab and bench surface. Reads the
 * registry so it can never drift from what is routable; the parity test keeps
 * the registry honest against the route tree.
 */
export function LabIndex() {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Lab" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Scroll>
						<div className="flex flex-col">
							<div className="border-b px-4 py-3">
								<h1 className="text-sm font-semibold">Lab</h1>
								<p className="text-xs text-muted-foreground">
									Dev-only surfaces. Everything here is a 404 in production and stays out of
									the startup bundle.
								</p>
							</div>
							{SECTIONS.map((section) => {
								const entries = LAB_ENTRIES.filter((entry) => entry.kind === section.kind)
								return (
									<section key={section.kind} className="border-b px-4 py-4">
										<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
											{section.title}
										</h2>
										<p className="mt-1 text-xs text-muted-foreground">{section.blurb}</p>
										<ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
											{entries.map((entry) => (
												<li key={entry.path}>
													<Link
														to={entry.path}
														className="flex h-full flex-col gap-1 rounded-md border bg-card px-3 py-2.5 transition-colors hover:bg-accent"
													>
														<span className="flex items-baseline justify-between gap-2">
															<span className="text-sm font-medium">
																{entry.title}
															</span>
															<span className="font-mono text-[11px] text-muted-foreground">
																{entry.path}
															</span>
														</span>
														<span className="text-xs text-muted-foreground">
															{entry.description}
														</span>
														{entry.session === "required" && (
															<span className="mt-1 self-start rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
																Session required
															</span>
														)}
													</Link>
												</li>
											))}
										</ul>
									</section>
								)
							})}
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
