# GitLab event projectors

Status: version-1 producer contracts for the Maple Local eventing outbox.

These pure projectors turn bounded, normalized GitLab OTLP log fields into
factual CloudEvents. They do not call GitLab, choose local routing policy,
create Matrix rooms, send Matrix messages, or acknowledge a downstream
consumer. Numeric `gitlab.project.id` is the durable project identity; mutable
project paths are display and subject metadata only.

## Identity and compatibility

The source receiver supplies a stable GitLab delivery UUID in `event.id` and
`gitlab.event.id`. When one delivery becomes multiple facts, their occurrence
IDs are `<delivery-id>:<zero-based-index>`. The OTLP adapter preserves that
occurrence ID and Maple derives the CloudEvent ID from tenant, source kind,
source, occurrence ID, projection ID, and projection revision. Payload hashes
are audit data, not identity.

New envelopes expose that preserved input as optional, backward-compatible
CloudEvents extensions `sourceoccurrenceid` and `sourceidentityquality`.
Historical envelopes lacking both fields remain schema-valid. A downstream
consumer can therefore persist the source occurrence ID, immutable Maple event
ID, and its own deterministic delivery transaction ID without parsing event
data.

The original `gitlab.issue.created@1` projector and
`dev.maple.gitlab.issue.created.v1` output remain unchanged. It accepts the
OTLP LogRecord `eventName` field used by its existing fixture. New projectors
prefer the `event.name` attribute and retain the signal field as a compatibility
fallback.

Complete output fixtures live in
`apps/cli/test/fixtures/gitlab-projectors.v1.json`. Their occurrence and
projection identity inputs are paired by index in
`apps/cli/test/fixtures/gitlab-projector-identities.v1.json`.

## Common input and safety contract

Every new projector requires:

- `event.name`: one explicit event name documented below;
- `gitlab.project.id`: positive OTLP int64;
- `gitlab.project.path`: non-blank bounded text.

Common optional fields are `gitlab.project.old_path`, `gitlab.actor.id`,
`gitlab.actor.name`, `gitlab.actor.username`, `gitlab.event.result`, and
resource `service.name`. Every output payload contains
`project: { id, path, oldPath? }`, `sourceEvent`, the relevant factual object,
and any present actor, result, and service name.

The projector boundary enforces:

- scalar text at most 4 KiB after trimming;
- comment excerpts at most 1,024 UTF-8 bytes after removing control
  characters and normalizing whitespace;
- canonical HTTP(S) URLs without credentials or query strings, at most 2,048
  UTF-8 bytes; comment URLs may retain a note-anchor fragment;
- positive object IDs and non-negative counts/durations;
- hexadecimal revisions, including all-zero before/after revisions;
- at most 20 failed-job summaries and no unknown summary fields;
- no raw payloads, variables, logs, full comments, arbitrary descriptions, or
  secrets.

Projector config objects are closed and currently have no fields, except the
unchanged legacy issue-created `includeBody` option.

## Version-1 event vocabulary

### Project lifecycle

Projector: `gitlab.project.lifecycle@1`

Type: `dev.maple.gitlab.project.lifecycle.v1`

Schema: `urn:maple:event-schema:gitlab-project-lifecycle:v1`

| `event.name`               | Output `action`      |
| -------------------------- | -------------------- |
| `project_create`           | `created`            |
| `project_update`           | `updated`            |
| `project_rename`           | `renamed`            |
| `project_transfer`         | `transferred`        |
| `project_archive`          | `archived`           |
| `project_unarchive`        | `unarchived`         |
| `project_deletion_request` | `deletion_requested` |
| `project_destroy`          | `destroyed`          |

`gitlab.project.old_path` is optional and normally present for rename or
transfer facts. Transfer direction is deliberately not inferred here.

### Issue lifecycle

Projector: `gitlab.issue.lifecycle@1`

Type: `dev.maple.gitlab.issue.lifecycle.v1`

Schema: `urn:maple:event-schema:gitlab-issue-lifecycle:v1`

| `event.name`   | Output `issue.action` |
| -------------- | --------------------- |
| `issue_open`   | `open`                |
| `issue_update` | `update`              |
| `issue_close`  | `close`               |
| `issue_reopen` | `reopen`              |

Required: `gitlab.issue.iid`. Optional: positive `gitlab.issue.id`,
`gitlab.issue.title`, canonical `gitlab.issue.url`, and bounded lowercase
`gitlab.issue.state`. Structured `gitlab.issue.labels` is an optional array of
at most 50 non-blank labels, each at most 256 UTF-8 bytes. The same issue object,
including labels, is used by issue-comment events.

### Issue comments

Projector: `gitlab.issue.comment@1`

Type: `dev.maple.gitlab.issue.comment.v1`

Schema: `urn:maple:event-schema:gitlab-issue-comment:v1`

The only accepted event is `issue_comment`. Required fields are
`gitlab.issue.iid` and positive `gitlab.comment.id`. Optional fields are
`gitlab.comment.excerpt`, canonical `gitlab.comment.url`, and boolean
`gitlab.comment.system`. The full comment body is never projected.

### Merge-request lifecycle

Projector: `gitlab.merge-request.lifecycle@1`

Type: `dev.maple.gitlab.merge-request.lifecycle.v1`

Schema: `urn:maple:event-schema:gitlab-merge-request-lifecycle:v1`

| `event.name`           | Output `mergeRequest.action` |
| ---------------------- | ---------------------------- |
| `merge_request_open`   | `open`                       |
| `merge_request_update` | `update`                     |
| `merge_request_close`  | `close`                      |
| `merge_request_reopen` | `reopen`                     |
| `merge_request_merge`  | `merge`                      |
| `merge_request_review` | `review`                     |

Required: positive `gitlab.merge_request.iid`. Optional:
`gitlab.merge_request.title`, canonical `gitlab.merge_request.url`, source and
target branches, hexadecimal `gitlab.merge_request.commit`, and bounded
`gitlab.merge_request.review_state`. Review events require `review_state`.
Unlike the initial implementation, arbitrary `merge_request_<token>` events
fail closed.

### Merge-request comments

Projector: `gitlab.merge-request.comment@1`

Type: `dev.maple.gitlab.merge-request.comment.v1`

Schema: `urn:maple:event-schema:gitlab-merge-request-comment:v1`

`merge_request_comment` emits `comment.kind: "comment"` and
`merge_request_review_comment` emits `comment.kind: "review"`. Required fields
are `gitlab.merge_request.iid` and `gitlab.comment.id`; the same bounded comment
fields and sanitization rules as issue comments apply.

### Completed pipelines

Projector: `gitlab.pipeline.completed@1`

Type: `dev.maple.gitlab.pipeline.completed.v1`

Schema: `urn:maple:event-schema:gitlab-pipeline-completed:v1`

The only accepted event is `ci_pipeline_completed`. Required fields are
positive `gitlab.ci.pipeline.id` and terminal
`gitlab.ci.pipeline.status: success|failed|canceled|skipped`. Optional scalar
fields are:

- `gitlab.ci.pipeline.iid`, `name`, `source`, and `detailed_status`;
- positive `gitlab.ci.pipeline.merge_request_iid`, emitted only when the
  pipeline-to-MR association is unambiguous;
- canonical `gitlab.ci.pipeline.url`;
- `vcs.ref` and hexadecimal `vcs.ref.head.revision`;
- non-negative `duration_ms`, `queued_duration_ms`, and `stage_count`;
- paired `failed_job_count` and boolean `failed_jobs_truncated`.

The structured OTLP attribute `gitlab.ci.pipeline.failed_jobs` is an array of
at most 20 objects. Each object permits only positive string-encoded int64
`id`, bounded `name`, optional `stage`, literal status `failed`, and optional
canonical `url`. When summaries are present, count and truncation metadata are
required and must agree with the array length.

```json
{
	"pipeline": {
		"id": "900",
		"status": "failed",
		"url": "https://gitlab.internal/rdev/maple/-/pipelines/900",
		"failedJobCount": "3",
		"failedJobsTruncated": true,
		"failedJobs": [
			{
				"id": "901",
				"name": "unit",
				"stage": "test",
				"status": "failed",
				"url": "https://gitlab.internal/rdev/maple/-/jobs/901"
			}
		]
	}
}
```

### Deployment lifecycle

Projector: `gitlab.deployment.lifecycle@1`

Type: `dev.maple.gitlab.deployment.lifecycle.v1`

Schema: `urn:maple:event-schema:gitlab-deployment-lifecycle:v1`

| `event.name`          | Required `gitlab.deployment.status` |
| --------------------- | ----------------------------------- |
| `deployment_running`  | `running`                           |
| `deployment_success`  | `success`                           |
| `deployment_failed`   | `failed`                            |
| `deployment_canceled` | `canceled`                          |
| `deployment_blocked`  | `blocked`                           |
| `deployment_manual`   | `manual`                            |

Positive `gitlab.deployment.id`, bounded
`gitlab.deployment.environment`, and matching status are required. Optional
fields are hexadecimal `gitlab.deployment.revision` and canonical
`gitlab.deployment.url`.

### Job lifecycle

Projector: `gitlab.job.lifecycle@1`

Type: `dev.maple.gitlab.job.lifecycle.v1`

Schema: `urn:maple:event-schema:gitlab-job-lifecycle:v1`

The event is `ci_job_<status>` and `gitlab.ci.job.status` must match. Allowed
statuses are `created`, `pending`, `preparing`, `waiting_for_resource`,
`running`, `success`, `failed`, `canceled`, `skipped`, `manual`, and
`scheduled`. Positive `gitlab.ci.job.id`, bounded `gitlab.ci.job.name`, and
status are required. Optional fields are stage, canonical job URL, positive
pipeline ID, ref/revision, non-negative duration, and boolean `allow_failure`.

### Ref lifecycle

Projector: `gitlab.ref.lifecycle@1`

Type: `dev.maple.gitlab.ref.lifecycle.v1`

Schema: `urn:maple:event-schema:gitlab-ref-lifecycle:v1`

The production receiver normalizes raw `push`, `tag_push`, and
`repository_update` deliveries into exactly six deduplicated semantic facts:

| `event.name`    | `ref.type` | `ref.action` |
| --------------- | ---------- | ------------ |
| `branch_create` | `branch`   | `create`     |
| `branch_update` | `branch`   | `update`     |
| `branch_delete` | `branch`   | `delete`     |
| `tag_create`    | `tag`      | `create`     |
| `tag_update`    | `tag`      | `update`     |
| `tag_delete`    | `tag`      | `delete`     |

Required fields are bounded `vcs.ref` and hexadecimal
`vcs.ref.base.revision`/`vcs.ref.head.revision`. All-zero revisions are valid.
Canonical `gitlab.ref.url` and non-negative `gitlab.push.commit_count` are
optional. Raw delivery names are not accepted by this projector.

### Release lifecycle

Projector: `gitlab.release.lifecycle@1`

Type: `dev.maple.gitlab.release.lifecycle.v1`

Schema: `urn:maple:event-schema:gitlab-release-lifecycle:v1`

`release_create`, `release_update`, and `release_delete` map to matching
`release.action` values. Bounded `gitlab.release.tag` is required. Positive
`gitlab.release.id`, bounded name, and canonical URL are optional. Release
descriptions are intentionally excluded.

## Complete sample CloudEvent

The checked-in fixture set contains one complete envelope for each output
family and enriched variants where useful. For example:

```json
{
	"specversion": "1.0",
	"id": "sha256:b7b29d2a12f061dc3e8b6c3bcb550302783b834541b6a8db7b104b4d14f41464",
	"source": "https://gitlab.internal",
	"type": "dev.maple.gitlab.deployment.lifecycle.v1",
	"subject": "rdev/maple/-/deployments/501",
	"time": "2026-08-07T19:42:00.123456789Z",
	"datacontenttype": "application/json",
	"dataschema": "urn:maple:event-schema:gitlab-deployment-lifecycle:v1",
	"tenantid": "local",
	"projectionid": "gitlab-deployment_failed",
	"projectionrevision": 1,
	"projectorid": "gitlab.deployment.lifecycle",
	"projectorversion": 1,
	"sourceoccurrenceid": "delivery-deployment:deployment_failed",
	"sourceidentityquality": "source",
	"data": {
		"project": { "id": "42", "path": "rdev/maple" },
		"deployment": {
			"id": "501",
			"environment": "production",
			"status": "failed",
			"revision": "a8123fa",
			"url": "https://gitlab.internal/rdev/maple/-/deployments/501"
		},
		"sourceEvent": "deployment_failed",
		"result": "failure",
		"serviceName": "gitlab-repository-events"
	}
}
```

Downstream delivery may derive an idempotent Matrix transaction ID from the
immutable Maple CloudEvent ID. That transaction policy and Matrix's structured
`info.selfenrichment.maple` content are downstream consumer contracts and do
not belong in these projectors.

## Producer handoff

The receiver must emit the explicit event vocabulary and fields above before a
corresponding projection is activated. In particular, a producer upgrade is
needed wherever the current receiver does not yet emit issue/comment facts,
MR title/URL/review/comment facts, pipeline canonical URL and bounded failed
jobs, deployment identity/environment/status/revision/URL, job lifecycle
fields, semantic ref transitions, or release facts. The receiver owns webhook
normalization, duplicate semantic-transition suppression, source UUID indexing,
excerpt pre-sanitization, and failed-job lookup/truncation. Maple validates and
projects those facts but does not reconstruct missing webhook data or call
GitLab.
