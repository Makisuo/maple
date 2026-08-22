/** `/contact.md` — the agent-readable twin of `/contact`; same copy, from `lib/company.ts`. */
import type { APIRoute } from "astro"
import { contactPage } from "../lib/company"
import { companyPageMarkdown } from "../lib/company-markdown"

export const GET: APIRoute = ({ site }) => companyPageMarkdown(contactPage, site)
