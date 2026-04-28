import { describe, expect, it } from "vitest"
import { normalizeKey, parseBoolean, parseNumber, parseWhereClause, splitCsv } from "./where-clause"

describe("normalizeKey", () => {
	it("normalizes service alias", () => {
		expect(normalizeKey("service")).toBe("service.name")
		expect(normalizeKey("Service")).toBe("service.name")
	})

	it("passes through service.name unchanged", () => {
		expect(normalizeKey("service.name")).toBe("service.name")
	})

	it("normalizes span alias", () => {
		expect(normalizeKey("span")).toBe("span.name")
	})

	it("normalizes environment aliases", () => {
		expect(normalizeKey("env")).toBe("deployment.environment")
		expect(normalizeKey("environment")).toBe("deployment.environment")
		expect(normalizeKey("deployment.environment")).toBe("deployment.environment")
	})

	it("normalizes commit_sha alias", () => {
		expect(normalizeKey("commit_sha")).toBe("deployment.commit_sha")
		expect(normalizeKey("deployment.commit_sha")).toBe("deployment.commit_sha")
	})

	it("normalizes root.only alias", () => {
		expect(normalizeKey("root.only")).toBe("root_only")
		expect(normalizeKey("root_only")).toBe("root_only")
	})

	it("normalizes errors_only alias", () => {
		expect(normalizeKey("errors_only")).toBe("has_error")
		expect(normalizeKey("has_error")).toBe("has_error")
	})

	it("passes through unknown keys", () => {
		expect(normalizeKey("severity")).toBe("severity")
		expect(normalizeKey("http.method")).toBe("http.method")
		expect(normalizeKey("attr.user_id")).toBe("attr.user_id")
	})

	it("handles whitespace and case", () => {
		expect(normalizeKey("  Service  ")).toBe("service.name")
		expect(normalizeKey("ENV")).toBe("deployment.environment")
	})
})

describe("parseBoolean", () => {
	it("parses true values", () => {
		expect(parseBoolean("true")).toBe(true)
		expect(parseBoolean("1")).toBe(true)
		expect(parseBoolean("yes")).toBe(true)
		expect(parseBoolean("y")).toBe(true)
		expect(parseBoolean("TRUE")).toBe(true)
	})

	it("parses false values", () => {
		expect(parseBoolean("false")).toBe(false)
		expect(parseBoolean("0")).toBe(false)
		expect(parseBoolean("no")).toBe(false)
		expect(parseBoolean("n")).toBe(false)
	})

	it("returns null for invalid values", () => {
		expect(parseBoolean("maybe")).toBeNull()
		expect(parseBoolean("")).toBeNull()
	})
})

describe("parseNumber", () => {
	it("parses valid numbers", () => {
		expect(parseNumber("42")).toBe(42)
		expect(parseNumber("3.14")).toBe(3.14)
		expect(parseNumber("0")).toBe(0)
	})

	it("returns null for invalid numbers", () => {
		expect(parseNumber("abc")).toBeNull()
		expect(parseNumber("")).toBeNull()
		expect(parseNumber("  ")).toBeNull()
	})
})

describe("splitCsv", () => {
	it("splits comma-separated values", () => {
		expect(splitCsv("a,b,c")).toEqual(["a", "b", "c"])
	})

	it("trims whitespace", () => {
		expect(splitCsv(" a , b , c ")).toEqual(["a", "b", "c"])
	})

	it("filters empty values", () => {
		expect(splitCsv("a,,b")).toEqual(["a", "b"])
	})
})

describe("parseWhereClause", () => {
	it("returns empty for blank expression", () => {
		const result = parseWhereClause("")
		expect(result.clauses).toEqual([])
		expect(result.warnings).toEqual([])
	})

	it("returns empty for whitespace-only expression", () => {
		const result = parseWhereClause("   ")
		expect(result.clauses).toEqual([])
		expect(result.warnings).toEqual([])
	})

	it("parses single equals clause", () => {
		const result = parseWhereClause('service.name = "api"')
		expect(result.clauses).toEqual([{ key: "service.name", operator: "=", value: "api" }])
		expect(result.warnings).toEqual([])
	})

	it("parses single-quoted values", () => {
		const result = parseWhereClause("service.name = 'api'")
		expect(result.clauses).toEqual([{ key: "service.name", operator: "=", value: "api" }])
	})

	it("parses unquoted values", () => {
		const result = parseWhereClause("root_only = true")
		expect(result.clauses).toEqual([{ key: "root_only", operator: "=", value: "true" }])
	})

	it("parses greater than operator", () => {
		const result = parseWhereClause("min_duration_ms > 100")
		expect(result.clauses).toEqual([{ key: "min_duration_ms", operator: ">", value: "100" }])
	})

	it("parses less than operator", () => {
		const result = parseWhereClause("max_duration_ms < 500")
		expect(result.clauses).toEqual([{ key: "max_duration_ms", operator: "<", value: "500" }])
	})

	it("parses greater than or equal operator", () => {
		const result = parseWhereClause("min_duration_ms >= 50")
		expect(result.clauses).toEqual([{ key: "min_duration_ms", operator: ">=", value: "50" }])
	})

	it("parses less than or equal operator", () => {
		const result = parseWhereClause("max_duration_ms <= 1000")
		expect(result.clauses).toEqual([{ key: "max_duration_ms", operator: "<=", value: "1000" }])
	})

	it("parses exists operator", () => {
		const result = parseWhereClause("attr.user_id exists")
		expect(result.clauses).toEqual([{ key: "attr.user_id", operator: "exists", value: "" }])
	})

	it("parses contains operator", () => {
		const result = parseWhereClause('service.name contains "api"')
		expect(result.clauses).toEqual([{ key: "service.name", operator: "contains", value: "api" }])
	})

	it("parses contains with unquoted value", () => {
		const result = parseWhereClause("service.name contains api")
		expect(result.clauses).toEqual([{ key: "service.name", operator: "contains", value: "api" }])
	})

	it("parses multiple AND-joined clauses", () => {
		const result = parseWhereClause('service.name = "api" AND has_error = true AND min_duration_ms > 100')
		expect(result.clauses).toHaveLength(3)
		expect(result.clauses[0]).toEqual({
			key: "service.name",
			operator: "=",
			value: "api",
		})
		expect(result.clauses[1]).toEqual({
			key: "has_error",
			operator: "=",
			value: "true",
		})
		expect(result.clauses[2]).toEqual({
			key: "min_duration_ms",
			operator: ">",
			value: "100",
		})
	})

	it("handles case-insensitive AND", () => {
		const result = parseWhereClause('service.name = "api" and root_only = true')
		expect(result.clauses).toHaveLength(2)
	})

	it("produces warning for unparseable clauses", () => {
		const result = parseWhereClause("not a valid clause")
		expect(result.clauses).toEqual([])
		expect(result.warnings).toHaveLength(1)
		expect(result.warnings[0].message).toContain("Unsupported clause syntax ignored")
	})

	it("handles mix of valid and invalid clauses", () => {
		const result = parseWhereClause('service.name = "api" AND invalid clause AND root_only = true')
		expect(result.clauses).toHaveLength(2)
		expect(result.warnings).toHaveLength(1)
	})

	it("detects unclosed quotes", () => {
		const result = parseWhereClause('service.name = "unclosed')
		expect(result.clauses).toEqual([])
		expect(result.warnings).toHaveLength(1)
		expect(result.warnings[0].message).toContain("Unclosed quote")
	})

	it("lowercases keys", () => {
		const result = parseWhereClause('Service.Name = "api"')
		expect(result.clauses[0].key).toBe("service.name")
	})
})
