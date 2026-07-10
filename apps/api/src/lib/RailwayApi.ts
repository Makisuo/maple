/**
 * Minimal fetch-based client for Railway's public GraphQL API
 * (https://backboard.railway.com/graphql/v2). Used by the api for token
 * validation and project/environment/service discovery; the streaming/polling
 * paths live in apps/railway-connector.
 *
 * Railway has no public OAuth — orgs paste a workspace or account API token.
 * Both authenticate with `Authorization: Bearer`. The endpoint is a fixed
 * trusted host, so plain fetch (no SSRF validation) is fine here; tests stub
 * `globalThis.fetch`.
 */
import { Effect, Option, Schema } from "effect"

export const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2"

export class RailwayApiRequestError extends Error {
	readonly unauthorized: boolean
	readonly status: number | null

	constructor(message: string, options?: { unauthorized?: boolean; status?: number | null }) {
		super(message)
		this.name = "RailwayApiRequestError"
		this.unauthorized = options?.unauthorized ?? false
		this.status = options?.status ?? null
	}
}

const GraphqlErrorsSchema = Schema.Array(
	Schema.Struct({
		message: Schema.optionalKey(Schema.String),
	}),
)

const decodeGraphqlErrors = Schema.decodeUnknownSync(GraphqlErrorsSchema)

export interface RailwayGraphqlResult {
	readonly data: unknown
	readonly errors: ReadonlyArray<{ readonly message?: string }>
}

/** Railway signals auth failures both via HTTP 401 and via GraphQL errors like "Not Authorized". */
const isUnauthorizedMessage = (message: string): boolean => /not authorized|unauthorized/i.test(message)

export const railwayGraphqlQuery = Effect.fn("RailwayApi.graphqlQuery")(function* (
	token: string,
	request: { readonly query: string; readonly variables?: Record<string, unknown> },
	options?: { readonly url?: string },
) {
	const url = options?.url ?? RAILWAY_GRAPHQL_URL

	const response = yield* Effect.tryPromise({
		try: async (signal) => {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					query: request.query,
					...(request.variables === undefined ? {} : { variables: request.variables }),
				}),
				signal,
			})
			return { status: res.status, body: await res.text() }
		},
		catch: (error) =>
			new RailwayApiRequestError(
				error instanceof Error ? error.message : "Railway API request failed",
			),
	}).pipe(
		Effect.timeout(15_000),
		Effect.catchTag("TimeoutError", () =>
			Effect.fail(new RailwayApiRequestError("Railway API request timed out")),
		),
	)

	if (response.status === 401 || response.status === 403) {
		return yield* Effect.fail(
			new RailwayApiRequestError("Railway rejected the API token", {
				unauthorized: true,
				status: response.status,
			}),
		)
	}
	if (response.status >= 400) {
		return yield* Effect.fail(
			new RailwayApiRequestError(`Railway API returned HTTP ${response.status}`, {
				status: response.status,
			}),
		)
	}

	const parsed = yield* Effect.try({
		try: () => JSON.parse(response.body) as { data?: unknown; errors?: unknown },
		catch: () => new RailwayApiRequestError("Railway API returned invalid JSON"),
	})

	let errors: ReadonlyArray<{ readonly message?: string }> = []
	if (Array.isArray(parsed.errors)) {
		try {
			errors = decodeGraphqlErrors(parsed.errors)
		} catch {
			errors = [{ message: "Railway API returned unrecognized GraphQL errors" }]
		}
	}

	return {
		data: parsed.data ?? null,
		errors,
	} satisfies RailwayGraphqlResult
})

const graphqlErrorMessage = (errors: ReadonlyArray<{ readonly message?: string }>): string =>
	errors
		.map((error) => error.message)
		.filter((message): message is string => typeof message === "string" && message.length > 0)
		.join("; ") || "Railway API returned GraphQL errors"

/** Fail when a GraphQL-level error is present, flagging auth-shaped messages as unauthorized. */
const requireData = (
	result: RailwayGraphqlResult,
): Effect.Effect<unknown, RailwayApiRequestError> => {
	if (result.errors.length > 0) {
		const message = graphqlErrorMessage(result.errors)
		return Effect.fail(
			new RailwayApiRequestError(message, { unauthorized: isUnauthorizedMessage(message) }),
		)
	}
	if (result.data === null) {
		return Effect.fail(new RailwayApiRequestError("Railway API response carried no data"))
	}
	return Effect.succeed(result.data)
}

// ── Token validation ──────────────────────────────────────────────────────────

const MeSchema = Schema.Struct({
	me: Schema.Struct({
		name: Schema.optionalKey(Schema.NullOr(Schema.String)),
		email: Schema.optionalKey(Schema.NullOr(Schema.String)),
	}),
})

const decodeMe = Schema.decodeUnknownEffect(MeSchema)

export interface RailwayTokenIdentity {
	readonly tokenType: "account" | "workspace"
	readonly accountName: string | null
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * Relay-style connection shapes from Railway's public schema. Per-environment
 * services come from `serviceInstances` (a service only runs in environments
 * where it has an instance); the project-level `services` list is the fallback
 * when an environment carries no instances.
 */
const connection = <S extends Schema.Top>(node: S) =>
	Schema.Struct({
		edges: Schema.Array(Schema.Struct({ node })),
	})

const ProjectsSchema = Schema.Struct({
	projects: connection(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			environments: connection(
				Schema.Struct({
					id: Schema.String,
					name: Schema.String,
					serviceInstances: Schema.optionalKey(
						connection(
							Schema.Struct({
								serviceId: Schema.String,
								serviceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
							}),
						),
					),
				}),
			),
			services: connection(
				Schema.Struct({
					id: Schema.String,
					name: Schema.String,
				}),
			),
		}),
	),
})

const decodeProjects = Schema.decodeUnknownEffect(ProjectsSchema)

const PROJECTS_QUERY = `
query mapleDiscovery {
  projects {
    edges {
      node {
        id
        name
        environments {
          edges {
            node {
              id
              name
              serviceInstances {
                edges {
                  node {
                    serviceId
                    serviceName
                  }
                }
              }
            }
          }
        }
        services {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  }
}
`

const ME_QUERY = `
query mapleValidateToken {
  me {
    name
    email
  }
}
`

export interface RailwayDiscoveredServiceData {
	readonly id: string
	readonly name: string
}

export interface RailwayDiscoveredEnvironmentData {
	readonly id: string
	readonly name: string
	readonly services: ReadonlyArray<RailwayDiscoveredServiceData>
}

export interface RailwayDiscoveredProjectData {
	readonly id: string
	readonly name: string
	readonly environments: ReadonlyArray<RailwayDiscoveredEnvironmentData>
}

export const fetchRailwayProjects = Effect.fn("RailwayApi.fetchProjects")(function* (
	token: string,
	options?: { readonly url?: string },
) {
	const result = yield* railwayGraphqlQuery(token, { query: PROJECTS_QUERY }, options)
	const data = yield* requireData(result)
	const decoded = yield* decodeProjects(data).pipe(
		Effect.mapError(() => new RailwayApiRequestError("Railway projects response had an unexpected shape")),
	)

	return decoded.projects.edges.map(({ node: project }): RailwayDiscoveredProjectData => {
		const projectServices = project.services.edges.map(({ node }) => ({
			id: node.id,
			name: node.name,
		}))
		return {
			id: project.id,
			name: project.name,
			environments: project.environments.edges.map(({ node: environment }) => {
				const instances = environment.serviceInstances?.edges ?? []
				const services =
					instances.length > 0
						? instances.map(({ node }) => ({
								id: node.serviceId,
								name: node.serviceName ?? node.serviceId,
							}))
						: projectServices
				return {
					id: environment.id,
					name: environment.name,
					services,
				}
			}),
		}
	})
})

/**
 * Validate a pasted token and classify it. Account (personal) tokens resolve
 * `me`; workspace/team tokens cannot (no user principal) but can list
 * projects, so a failed `me` falls through to the projects query before the
 * token is rejected.
 */
export const validateRailwayToken = Effect.fn("RailwayApi.validateToken")(function* (
	token: string,
	options?: { readonly url?: string },
) {
	const me = yield* railwayGraphqlQuery(token, { query: ME_QUERY }, options).pipe(
		Effect.flatMap(requireData),
		Effect.flatMap((data) =>
			decodeMe(data).pipe(
				Effect.mapError(() => new RailwayApiRequestError("Railway me response had an unexpected shape")),
			),
		),
		Effect.option,
	)

	if (Option.isSome(me)) {
		return {
			tokenType: "account",
			accountName: me.value.me.name ?? me.value.me.email ?? null,
		} satisfies RailwayTokenIdentity
	}

	// `me` failed — a workspace token still lists projects. Let a hard failure
	// here propagate: it means the token is invalid for both principals.
	yield* fetchRailwayProjects(token, options)
	return {
		tokenType: "workspace",
		accountName: null,
	} satisfies RailwayTokenIdentity
})
