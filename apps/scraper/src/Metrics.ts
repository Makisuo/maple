import { Metric } from "effect"

export const scrapesTotal = Metric.frequency("scraper.scrapes_total", {
	description: "Completed Prometheus scrapes by outcome",
})

export const scrapeDurationMs = Metric.histogram("scraper.scrape_duration_ms", {
	description: "End-to-end scrape duration in milliseconds",
	boundaries: Metric.exponentialBoundaries({
		start: 10,
		factor: 2,
		count: 16,
	}),
})

export const activeTargets = Metric.gauge("scraper.active_targets", {
	description: "Currently active scrape target loops",
})

export const bufferedResults = Metric.gauge("scraper.buffered_results", {
	description: "Scrape results waiting to be reported to the API",
})
