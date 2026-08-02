/** Static server for the poster generator + a /save sink that writes PNGs to disk. */
const ROOT = new URL(".", import.meta.url).pathname
const OUT = `${ROOT}out`

await Bun.$`mkdir -p ${OUT}`.quiet()

Bun.serve({
	port: 4899,
	async fetch(req) {
		const url = new URL(req.url)

		if (req.method === "POST" && url.pathname === "/save") {
			const { name, dataUrl } = (await req.json()) as { name: string; dataUrl: string }
			const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1)
			const path = `${OUT}/${name}.png`
			await Bun.write(path, Buffer.from(b64, "base64"))
			return new Response(`wrote ${path}`)
		}

		const path = url.pathname === "/" ? "/index.html" : url.pathname
		const file = Bun.file(ROOT + path.slice(1))
		if (await file.exists()) {
			return new Response(file, { headers: { "cache-control": "no-store" } })
		}
		return new Response("not found", { status: 404 })
	},
})

console.log("poster generator on http://127.0.0.1:4899")
