/**
 * Wires waterfall row hover to the side-panel attribute inspector.
 * Touch users get the same behaviour via `pointerenter` (rAF debounced).
 */

export function wireInspector(traceId: string) {
	const inspector = document.querySelector<HTMLElement>(`[data-trace-inspector="${traceId}"]`);
	const trace = document.querySelector<HTMLElement>(`[data-trace-id="${traceId}"]`);
	if (!inspector || !trace) return;

	const titleEl = inspector.querySelector<HTMLElement>("[data-inspector-title]")!;
	const durEl = inspector.querySelector<HTMLElement>("[data-inspector-duration]")!;
	const attrsEl = inspector.querySelector<HTMLElement>("[data-inspector-attrs]")!;

	const renderRow = (row: HTMLElement) => {
		const service = row.dataset.service ?? "";
		const op = row.dataset.op ?? "";
		const dur = row.dataset.duration ?? "";
		let attrs: Record<string, string> = {};
		try {
			attrs = JSON.parse(row.dataset.attrs ?? "{}");
		} catch {
			attrs = {};
		}
		titleEl.textContent = `${service} · ${op}`;
		durEl.textContent = `${dur}ms`;
		attrsEl.innerHTML = renderAttrs(attrs);
	};

	trace.addEventListener("pointerover", (e) => {
		const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(".waterfall-row");
		if (row) renderRow(row);
	});
}

function renderAttrs(attrs: Record<string, string>): string {
	const escape = (s: string) =>
		s.replace(/[&<>"']/g, (c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
		);
	const rows = Object.entries(attrs)
		.map(
			([k, v]) =>
				`<dt class="text-fg-muted">${escape(k)}</dt><dd class="text-fg break-all">${escape(v)}</dd>`,
		)
		.join("");
	return `<div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">${rows}</div>`;
}
