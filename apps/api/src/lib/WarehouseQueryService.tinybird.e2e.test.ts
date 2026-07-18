import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { mintOrgReadJwt } from "./tinybird-jwt"

const enabled = process.env.TINYBIRD_LOCAL_E2E === "1"
const apiBase = (process.env.TINYBIRD_LOCAL_E2E_URL ?? "http://127.0.0.1:7181").replace(/\/$/, "")
const gatewayBase = (process.env.TINYBIRD_LOCAL_E2E_GATEWAY_URL ?? "http://127.0.0.1:7182").replace(/\/$/, "")
const workspaceName = `RawSqlE2E_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const datasource = "raw_sql_e2e"

interface LocalTokens {
	readonly admin_token: string
	readonly user_token: string
	readonly workspace_admin_token: string
}

interface LocalWorkspace {
	readonly id: string
	readonly name: string
	readonly token: string
}

let tokens: LocalTokens | undefined
let workspace: LocalWorkspace | undefined
let workspaceSigningKey: string | undefined

const responseJson = async <T>(response: Response): Promise<T> => {
	const text = await response.text()
	if (!response.ok) throw new Error(`Tinybird ${response.status}: ${text.slice(0, 500)}`)
	return JSON.parse(text) as T
}

const listWorkspaces = async (adminToken: string): Promise<ReadonlyArray<LocalWorkspace>> => {
	const response = await fetch(
		`${apiBase}/v1/user/workspaces?with_organization=true&token=${encodeURIComponent(adminToken)}`,
	)
	const body = await responseJson<{ readonly workspaces: ReadonlyArray<LocalWorkspace> }>(response)
	return body.workspaces
}

const createWorkspace = async (localTokens: LocalTokens): Promise<LocalWorkspace> => {
	const response = await fetch(`${apiBase}/v1/workspaces`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${localTokens.user_token}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ name: workspaceName }),
	})
	await responseJson<Record<string, unknown>>(response)
	const created = (await listWorkspaces(localTokens.admin_token)).find(
		(candidate) => candidate.name === workspaceName,
	)
	if (!created) throw new Error("Tinybird Local workspace was not returned after creation")
	return created
}

const buildDatasource = async (target: LocalWorkspace): Promise<void> => {
	const datafile = [
		"SCHEMA >",
		"    OrgId String `json:$.OrgId`,",
		"    value UInt64 `json:$.value`",
		'ENGINE "MergeTree"',
		'ENGINE_SORTING_KEY "OrgId"',
	].join("\n")
	const form = new FormData()
	form.append("data_project://", new Blob([datafile], { type: "text/plain" }), `${datasource}.datasource`)
	const response = await fetch(`${apiBase}/v1/build`, {
		method: "POST",
		headers: { Authorization: `Bearer ${target.token}` },
		body: form,
	})
	const body = await responseJson<{ readonly result: string; readonly error?: string }>(response)
	if (body.result !== "success" && body.result !== "no_changes") {
		throw new Error(`Tinybird local build failed: ${body.error ?? body.result}`)
	}
}

const ingestFixtures = async (target: LocalWorkspace): Promise<void> => {
	const response = await fetch(`${apiBase}/v0/events?name=${datasource}&wait=true`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${target.token}`,
			"Content-Type": "application/x-ndjson",
		},
		body: ['{"OrgId":"org_a","value":1}', '{"OrgId":"org_b","value":2}'].join("\n"),
	})
	await responseJson<Record<string, unknown>>(response)
}

const loadWorkspaceSigningKey = async (target: LocalWorkspace): Promise<string> => {
	const response = await fetch(`${apiBase}/v0/tokens/`, {
		headers: { Authorization: `Bearer ${target.token}` },
	})
	const body = await responseJson<{
		readonly tokens: ReadonlyArray<{
			readonly name: string
			readonly token: string
			readonly scopes: ReadonlyArray<{ readonly type: string }>
		}>
	}>(response)
	const adminToken = body.tokens.find(
		(candidate) =>
			candidate.name === "workspace admin token" &&
			candidate.scopes.some((scope) => scope.type === "ADMIN"),
	)
	if (!adminToken) throw new Error("Tinybird Local did not return a workspace admin token")
	return adminToken.token
}

const scopedToken = (target: LocalWorkspace, signingKey: string): string =>
	mintOrgReadJwt({
		signingKey,
		workspaceId: target.id,
		orgId: "org_a",
		datasourceNames: [datasource],
		nowSeconds: Math.floor(Date.now() / 1000),
		ttlSeconds: 600,
	})

describe.skipIf(!enabled)("Tinybird Local raw-SQL JWT E2E", () => {
	beforeAll(async () => {
		tokens = await responseJson<LocalTokens>(await fetch(`${apiBase}/tokens`))
		workspace = await createWorkspace(tokens)
		workspaceSigningKey = await loadWorkspaceSigningKey(workspace)
		await buildDatasource(workspace)
		await ingestFixtures(workspace)
	}, 120_000)

	afterAll(async () => {
		if (tokens === undefined || workspace === undefined) return
		const response = await fetch(
			`${apiBase}/v1/workspaces/${workspace.id}?hard_delete_confirmation=yes`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${tokens.user_token}` },
			},
		)
		if (!response.ok) throw new Error(`Failed to delete Tinybird E2E workspace (${response.status})`)
	}, 30_000)

	it("enforces the org filter through /v0/sql across predicates, UNIONs, and subqueries", async () => {
		if (workspace === undefined || workspaceSigningKey === undefined) {
			throw new Error("workspace not initialized")
		}
		for (const query of [
			`SELECT OrgId, value FROM ${datasource} WHERE OrgId = 'org_a' OR 1=1 ORDER BY OrgId`,
			`SELECT OrgId, value FROM ${datasource} WHERE OrgId = 'org_a' UNION ALL SELECT OrgId, value FROM ${datasource} WHERE OrgId = 'org_b'`,
			`SELECT OrgId, value FROM (SELECT OrgId, value FROM ${datasource}) ORDER BY OrgId`,
		]) {
			const response = await fetch(`${apiBase}/v0/sql`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${scopedToken(workspace, workspaceSigningKey)}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ q: `${query} FORMAT JSON` }),
			})
			const body = await responseJson<{
				readonly data: ReadonlyArray<Record<string, unknown>>
			}>(response)
			assert.deepStrictEqual(body.data, [{ OrgId: "org_a", value: 1 }])
		}
	})

	it("enforces the same isolation through the ClickHouse-compatible gateway", async () => {
		if (workspace === undefined || workspaceSigningKey === undefined) {
			throw new Error("workspace not initialized")
		}
		for (const query of [
			`SELECT OrgId, value FROM ${datasource} WHERE OrgId = 'org_a' OR 1=1 ORDER BY OrgId`,
			`SELECT OrgId, value FROM ${datasource} WHERE OrgId = 'org_a' UNION ALL SELECT OrgId, value FROM ${datasource} WHERE OrgId = 'org_b'`,
			`SELECT OrgId, value FROM (SELECT OrgId, value FROM ${datasource}) ORDER BY OrgId`,
		]) {
			const response = await fetch(`${gatewayBase}/?database=${encodeURIComponent(workspace.name)}`, {
				method: "POST",
				headers: {
					"X-ClickHouse-Key": scopedToken(workspace, workspaceSigningKey),
					"X-ClickHouse-Database": workspace.name,
					"Content-Type": "text/plain",
				},
				body: `${query} FORMAT JSONEachRow`,
			})
			const text = await response.text()
			if (!response.ok) {
				throw new Error(`Tinybird gateway ${response.status}: ${text.slice(0, 500)}`)
			}
			const rows = text
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
			assert.deepStrictEqual(rows, [{ OrgId: "org_a", value: 1 }])
		}
	})
})
