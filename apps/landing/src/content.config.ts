import { defineCollection, z } from "astro:content"
import { glob } from "astro/loaders"

const roadmap = defineCollection({
	loader: glob({ pattern: "**/*.md", base: "./src/content/roadmap" }),
	schema: z.object({
		title: z.string(),
		status: z.enum(["shipped", "in-progress", "planned", "exploring"]),
		category: z.enum(["traces", "logs", "metrics", "alerting", "integrations", "platform", "ai"]),
		quarter: z.string(),
		description: z.string(),
		order: z.number().default(0),
		shipped_date: z.string().optional(),
	}),
})

const docs = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/docs" }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		group: z.string(),
		order: z.number().default(0),
		draft: z.boolean().default(false),
		sdk: z
			.enum(["effect", "node", "nextjs", "python", "go", "rust", "java", "csharp", "kotlin", "laravel"])
			.optional(),
	}),
})

const blog = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/blog" }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		date: z.coerce.date(),
		author: z.string().default("Maple Team"),
		// Byline subtitle (role/title). Omitted for the "Maple Team" default.
		authorRole: z.string().optional(),
		category: z.enum(["engineering", "product", "guides", "company"]).optional(),
		// Optional real cover screenshot served from /public/blog; falls back to a
		// generated on-brand motif when omitted.
		cover: z.string().optional(),
		coverAlt: z.string().optional(),
		featured: z.boolean().default(false),
		draft: z.boolean().default(false),
	}),
})

// One entry per monthly release — the filename is the permalink (`2026-07.md`
// → /changelog/2026-07), so it sorts chronologically on disk too. `highlights`
// feeds the index panel; the body is the full release note.
const changelog = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/changelog" }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		date: z.coerce.date(), // month close — sorts the ledger, drives <time>
		highlights: z.array(z.string()).default([]),
		// Release cover served from /public/changelog. Doubles as the per-release
		// OG card; without it the page falls back to the generic /og-image.png.
		cover: z.string().optional(),
		coverAlt: z.string().optional(),
		// Drives the BREAKING marker only. The prose stays in the body so there
		// is one source of truth for what actually broke.
		breaking: z.boolean().default(false),
		draft: z.boolean().default(false),
	}),
})

// Customer logos rendered in the homepage "trusted by" marquee. Frontmatter-only
// entries (no body) — one file per company. The entry id (filename) maps to a
// brand logo component in the LOGOS registry inside CustomerLogos.astro.
const logos = defineCollection({
	loader: glob({ pattern: "**/*.md", base: "./src/content/logos" }),
	schema: z.object({
		name: z.string(),
		href: z.string().url().optional(), // present → linked, absent → static
		order: z.number().default(0),
	}),
})

export const collections = { roadmap, docs, blog, changelog, logos }
