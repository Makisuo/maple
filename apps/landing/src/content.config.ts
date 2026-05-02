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
		sdk: z.enum(["effect"]).optional(),
	}),
})

export const collections = { roadmap, docs }
