---
"effect": patch
---

Defer HTTP API endpoint compilation and built-in OpenAPI response generation until their routes are requested.

Endpoint codec and middleware initialization defects now surface on the first request to that route and are retried on later requests. Scalar, Swagger, and `openapiPath` responses memoize only successful generation so a documentation defect does not poison the route for the lifetime of the runtime.
