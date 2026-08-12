import { ErrorPersistenceError } from "@maple/domain/http"
import { makeDbExecute, makePersistenceErrorMapper } from "@/platform/db-execute"
import type { DatabaseShape } from "@/platform/DatabaseLive"

export { describeCause } from "@/platform/describe-cause"

export const makePersistenceError = makePersistenceErrorMapper(
	ErrorPersistenceError,
	"Error persistence failure",
)

/**
 * Persistence boundary for the error-issue capabilities. Each service passes
 * its own name so the failure log points at the service that actually ran the
 * query rather than at the facade they were all split out of.
 */
export const makeErrorDatabaseExecute = (database: DatabaseShape, service: string) =>
	makeDbExecute(database, service, makePersistenceError)
