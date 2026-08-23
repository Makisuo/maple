/** `/about.md` — the agent-readable twin of `/about`; same copy, from `lib/company.ts`. */
import type { APIRoute } from "astro"
import { aboutPage } from "../lib/company"
import { companyPageMarkdown } from "../lib/company-markdown"

export const GET: APIRoute = ({ site }) => companyPageMarkdown(aboutPage, site)
