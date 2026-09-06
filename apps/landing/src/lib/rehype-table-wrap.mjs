// Wraps every markdown table in a scroll container. Reference pages carry
// four-column flag tables that are wider than a phone; without the wrapper
// they widen the whole page and the fixed header gets cut off. Dependency-free
// on purpose — a hast walk is six lines and the plugin is config-only.
const wrap = (node) => ({
	type: "element",
	tagName: "div",
	properties: { className: ["table-wrap"] },
	children: [node],
})

const walk = (node) => {
	if (!Array.isArray(node.children)) return
	node.children = node.children.map((child) => {
		if (child.type === "element" && child.tagName === "table") return wrap(child)
		walk(child)
		return child
	})
}

export default function rehypeTableWrap() {
	return (tree) => walk(tree)
}
