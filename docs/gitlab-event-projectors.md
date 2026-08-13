# GitLab event projectors

Status: version-1 producer contracts for the Maple Local eventing outbox.

This document describes the projectors registered by the Local runtime. They
normalize the already bounded OTLP fields emitted by the GitLab repository-event
receiver. They do not call GitLab, create Matrix rooms, send Matrix messages,
or acknowledge a downstream consumer.

## Input compatibility

The production receiver exports the normalized event name as the OTLP log
attribute `event.name`. The original issue-created vertical also accepts the
OTLP LogRecord `eventName` field through the existing `signal:event.name`
fixture. New projectors prefer `attribute:event.name` and accept the signal
field as a compatibility fallback.

All project and object IDs are retained as decimal strings because OTLP int64
values are represented that way in the normalized signal model. Project IDs
and object IDs must be positive. Optional numeric durations and stage counts
must be non-negative. Strings are trimmed, rejected when blank, and limited to
4 KiB by the projector boundary. Raw webhook bodies, variables, URLs, secrets,
and confidential text are not projected.

## Version-1 contracts

### `gitlab.project.lifecycle@1`

Input `event.name` values and normalized actions are:

| Input                      | `action`             |
| -------------------------- | -------------------- |
| `project_create`           | `created`            |
| `project_destroy`          | `destroyed`          |
| `project_rename`           | `renamed`            |
| `project_transfer`         | `transferred`        |
| `project_update`           | `updated`            |
| `project_archive`          | `archived`           |
| `project_unarchive`        | `unarchived`         |
| `project_deletion_request` | `deletion_requested` |

Required fields are `gitlab.project.id`, `gitlab.project.path`, and
`event.name`. `gitlab.project.old_path`, `gitlab.actor.id`,
`gitlab.actor.name`, `gitlab.event.result`, and resource `service.name` are
optional.

The output type is `dev.maple.gitlab.project.lifecycle.v1`, with data shaped as:

```json
{
	"project": { "id": "42", "path": "rdev/maple", "oldPath": "rdev/old-maple" },
	"action": "renamed",
	"sourceEvent": "project_rename",
	"actor": { "id": "9", "name": "rdev" },
	"result": "success",
	"serviceName": "gitlab-repository-events"
}
```

### `gitlab.merge-request.lifecycle@1`

The source event must match `merge_request_<action>`, where `<action>` is a
bounded lowercase GitLab action token. The required fields are
`gitlab.project.id`, `gitlab.project.path`, `gitlab.merge_request.iid`, and
`event.name`. Source branch, target branch, merge commit, actor, result, and
resource service name are optional.

The output type is `dev.maple.gitlab.merge-request.lifecycle.v1`. Its subject
is `<project-path>/-/merge_requests/<iid>` and its data has this shape:

```json
{
	"project": { "id": "42", "path": "rdev/maple" },
	"mergeRequest": {
		"iid": "7",
		"action": "open",
		"sourceBranch": "feature/maple",
		"targetBranch": "main",
		"commit": "abc123"
	},
	"sourceEvent": "merge_request_open",
	"actor": { "id": "9", "name": "rdev" },
	"result": "success",
	"serviceName": "gitlab-repository-events"
}
```

### `gitlab.pipeline.completed@1`

The source event must be `ci_pipeline_completed`. The required fields are
`gitlab.project.id`, `gitlab.project.path`, `gitlab.ci.pipeline.id`,
`gitlab.ci.pipeline.status`, and `event.name`. Status must be one of
`success`, `failed`, `canceled`, or `skipped`. Pipeline IID, name, source,
detailed status, ref, revision, durations, stage count, actor, result, and
resource service name are optional.

The output type is `dev.maple.gitlab.pipeline.completed.v1`. Its subject is
`<project-path>/-/pipelines/<id>`:

```json
{
	"project": { "id": "42", "path": "rdev/maple" },
	"pipeline": {
		"id": "900",
		"iid": "12",
		"status": "failed",
		"name": "Maple CI",
		"source": "push",
		"detailedStatus": "failed",
		"ref": "main",
		"sha": "deadbeef",
		"durationMs": "63000",
		"queuedDurationMs": "10000",
		"stageCount": "3"
	},
	"sourceEvent": "ci_pipeline_completed",
	"actor": { "id": "9", "name": "rdev" },
	"result": "failure",
	"serviceName": "gitlab-repository-events"
}
```

## Complete CloudEvent fixtures

These examples use the same source, occurrence IDs, projection IDs, and
revision as the compatibility tests. The IDs are the canonical Maple v1
identity, so retrying the same source occurrence produces the same event ID.
The complete machine-readable set is checked in at
`apps/cli/test/fixtures/gitlab-projectors.v1.json`.

```json
{
	"specversion": "1.0",
	"id": "sha256:0fac0a375c6f8a05fb5ec1a751cf9e3b55282f56c0d135bc8a8c50c6a2a7559f",
	"source": "https://gitlab.internal",
	"type": "dev.maple.gitlab.project.lifecycle.v1",
	"subject": "rdev/maple",
	"time": "2026-08-07T19:42:00.123456789Z",
	"datacontenttype": "application/json",
	"dataschema": "urn:maple:event-schema:gitlab-project-lifecycle:v1",
	"tenantid": "local",
	"projectionid": "gitlab-project-renamed",
	"projectionrevision": 1,
	"projectorid": "gitlab.project.lifecycle",
	"projectorversion": 1,
	"data": {
		"project": { "id": "42", "path": "rdev/maple", "oldPath": "rdev/old-maple" },
		"action": "renamed",
		"sourceEvent": "project_rename",
		"actor": { "id": "9", "name": "rdev" },
		"result": "success",
		"serviceName": "gitlab-repository-events"
	}
}
```

The merge-request fixture uses
`sha256:09992cc6804e056fb2a037b6c9db05c432c4733e229c963675a15a47445f745b`
with occurrence ID `mr-event-7` and projection ID `gitlab-mr-opened`. The
pipeline fixture uses
`sha256:f2bab7e420aa6b97d65f0478d16384b45d3bf61fb9ad9c111c614279cb42e24e`
with occurrence ID `pipeline-event-900` and projection ID
`gitlab-pipeline-completed`; its status is `failed` and its normalized result
is `failure`.

Downstream Matrix delivery may use these stable event IDs for idempotent
transaction IDs, but that consumer protocol is deliberately outside these
projectors.
