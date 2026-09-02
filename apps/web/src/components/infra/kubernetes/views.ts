/**
 * The Kubernetes section's four views, in tab order.
 *
 * One list, three consumers: the view tabs every Kubernetes page carries, the
 * breadcrumb trail, and the ⌘K palette (which keeps each view typeable now that
 * the sidebar shows the section as a single row). Add a view here and all three
 * pick it up; the route file itself is still yours to write.
 */

export type KubernetesView = "pods" | "workloads" | "nodes" | "services"

export interface KubernetesViewDef {
	readonly id: KubernetesView
	readonly title: string
	readonly href: `/infra/kubernetes/${KubernetesView}`
}

/** The section root. Redirects to the first view, carrying the time window. */
export const KUBERNETES_ROOT = "/infra/kubernetes"

export const KUBERNETES_VIEWS = [
	{ id: "pods", title: "Pods", href: "/infra/kubernetes/pods" },
	{ id: "workloads", title: "Workloads", href: "/infra/kubernetes/workloads" },
	{ id: "nodes", title: "Nodes", href: "/infra/kubernetes/nodes" },
	{ id: "services", title: "Services", href: "/infra/kubernetes/services" },
] as const satisfies ReadonlyArray<KubernetesViewDef>

export function kubernetesView(id: KubernetesView): KubernetesViewDef {
	const view = KUBERNETES_VIEWS.find((candidate) => candidate.id === id)
	if (!view) throw new Error(`unknown Kubernetes view: ${id}`)
	return view
}
