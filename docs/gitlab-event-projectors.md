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

Every new GitLab projector fails closed unless the normalized occurrence has
`sourceidentityquality: "source"` and a non-null source occurrence ID. This
prevents retries of one GitLab delivery from becoming distinct events. The
generic eventing adapter still supports deterministic derived identity for
other projector families; the restriction is intentionally at the new GitLab
projector boundary.

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

Each factual GitLab `data` payload also has a checked-in JSON Schema under
`packages/eventing-core/schemas`. Fixture tests decode against the schema
selected by `dataschema`, and `schemas:check` fails when generated schemas
drift from the checked-in files.

## Common input and safety contract

Every new projector requires:

- `event.name`: one explicit event name documented below;
- source-provided occurrence identity as described above;
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

Required: `gitlab.issue.iid` and `gitlab.issue.type`. The type is derived from
Work Item Hook `object_attributes.type`, normalized to a lowercase snake token,
and bounded to 64 UTF-8 bytes. It is deliberately not an enum because GitLab
work-item types are configurable. Optional fields are positive
`gitlab.issue.id`, title, canonical URL, and bounded lowercase state.
Structured `gitlab.issue.labels` is an optional array of at most 50 non-blank
labels, each at most 256 UTF-8 bytes. The same issue object, including required
type and any labels, is used by issue-comment events.

Project-scoped Work Item Hooks are normalized into this existing family:
create/open, update, close, and reopen facts use `issue_open`, `issue_update`,
`issue_close`, and `issue_reopen`; work-item notes use `issue_comment`. The
producer must place the normalized Work Item type in `gitlab.issue.type` and
must not expose the raw hook payload. Epics require group hooks and are outside
the current user-namespace project-hook coverage; this is an explicit external
coverage limit, not a second Maple event family.

### Issue comments

Projector: `gitlab.issue.comment@1`

Type: `dev.maple.gitlab.issue.comment.v1`

Schema: `urn:maple:event-schema:gitlab-issue-comment:v1`

The only accepted event is `issue_comment`. Required fields are
`gitlab.issue.iid`, `gitlab.issue.type`, positive `gitlab.comment.id`, a
sanitized `gitlab.comment.excerpt`, and canonical `gitlab.comment.url`.
`gitlab.comment.system` remains optional because GitLab does not identify every
note source as a system note. The full comment body is never projected.

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

Required: positive `gitlab.merge_request.iid`, bounded
`gitlab.merge_request.title`, and canonical `gitlab.merge_request.url`.
Optional fields are source and target branches, hexadecimal
`gitlab.merge_request.commit`, and bounded `gitlab.merge_request.review_state`.
Review events require `review_state`.
Unlike the initial implementation, arbitrary `merge_request_<token>` events
fail closed.

### Merge-request comments

Projector: `gitlab.merge-request.comment@1`

Type: `dev.maple.gitlab.merge-request.comment.v1`

Schema: `urn:maple:event-schema:gitlab-merge-request-comment:v1`

`merge_request_comment` emits `comment.kind: "comment"` and
`merge_request_review_comment` emits `comment.kind: "review"`. Required fields
are `gitlab.merge_request.iid`, MR title and canonical URL,
`gitlab.comment.id`, sanitized excerpt, and canonical comment URL. The same
bounded comment sanitization rules as issue comments apply.

### Completed pipelines

Projector: `gitlab.pipeline.completed@1`

Type: `dev.maple.gitlab.pipeline.completed.v1`

Schema: `urn:maple:event-schema:gitlab-pipeline-completed:v1`

The only accepted event is `ci_pipeline_completed`. Required fields are
positive `gitlab.ci.pipeline.id`, terminal
`gitlab.ci.pipeline.status: success|failed|canceled|skipped`, and canonical
`gitlab.ci.pipeline.url`. Optional scalar fields are:

- `gitlab.ci.pipeline.iid`, `name`, `source`, and `detailed_status`;
- positive `gitlab.ci.pipeline.merge_request_iid`, emitted only when the
  pipeline-to-MR association is unambiguous;
- `vcs.ref` and hexadecimal `vcs.ref.head.revision`;
- non-negative `duration_ms`, `queued_duration_ms`, and `stage_count`;
- for failed pipelines only, required non-negative `failed_job_count`, boolean
  `failed_jobs_truncated`, and `failed_jobs` summary array.

The structured OTLP attribute `gitlab.ci.pipeline.failed_jobs` is an array of
at most 20 objects. Each object permits only positive string-encoded int64
`id`, bounded `name`, optional `stage`, literal status `failed`, and optional
canonical `url`. For failed pipelines, count and truncation metadata must agree
with the array length. Non-failed terminal pipelines reject failed-job metadata
rather than presenting a misleading empty failure summary.

```json
{
	"pipeline": {
		"id": "900",
		"status": "failed",
		"url": "https://gitlab.example.test/example/widgets/-/pipelines/900",
		"failedJobCount": "3",
		"failedJobsTruncated": true,
		"failedJobs": [
			{
				"id": "901",
				"name": "unit",
				"stage": "test",
				"status": "failed",
				"url": "https://gitlab.example.test/example/widgets/-/jobs/901"
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
`gitlab.deployment.environment`, matching status, hexadecimal
`gitlab.deployment.revision`, and canonical `gitlab.deployment.url` are all
required.

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
optional because delete facts may not have a resolvable web URL and some hook
variants omit a commit count. Raw delivery names are not accepted by this
projector.

### Release lifecycle

Projector: `gitlab.release.lifecycle@1`

Type: `dev.maple.gitlab.release.lifecycle.v1`

Schema: `urn:maple:event-schema:gitlab-release-lifecycle:v1`

`release_create`, `release_update`, and `release_delete` map to matching
`release.action` values. Bounded `gitlab.release.tag` is required. Positive
`gitlab.release.id`, bounded name, and canonical URL are optional because
delete hooks and older GitLab payload variants can omit them. Release
descriptions are intentionally excluded.

Other optional fields follow the same source-fidelity rule: actor metadata can
be absent for system actions; issue global ID/title/state/URL and MR branch,
commit, or non-review review-state fields can be absent from some update or
delete hook forms; pipeline timing, ref, detailed status, and MR association can
be absent or ambiguous; failed-job `stage` and `url` can be absent from the
bounded lookup result; job pipeline/ref/timing/URL fields can be absent during
early lifecycle states. Projectors never synthesize these values. Tests cover
minimal valid events and reject omission of every field declared required.

## Complete sample CloudEvent

The checked-in fixture set contains one complete envelope for each output
family and enriched variants where useful. For example:

```json
{
	"specversion": "1.0",
	"id": "sha256:7f8aea4bc391d3b954fecd9ef5356b02aaeb4289ddfa25ef9c3c16217b0d77d1",
	"source": "https://gitlab.example.test",
	"type": "dev.maple.gitlab.deployment.lifecycle.v1",
	"subject": "example/widgets/-/deployments/501",
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
		"project": { "id": "42", "path": "example/widgets" },
		"deployment": {
			"id": "501",
			"environment": "production",
			"status": "failed",
			"revision": "a8123fa",
			"url": "https://gitlab.example.test/example/widgets/-/deployments/501"
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
Work Item `object_attributes.type`, MR title/URL/review/comment facts, pipeline
canonical URL and bounded failed-job count/truncation summaries, deployment
identity/environment/status/revision/URL, job lifecycle fields, semantic ref
transitions, or release facts. For project-scoped Work Item Hooks the exact
handoff is: normalize `object_attributes.type` to lowercase snake case in
`gitlab.issue.type`; select one existing `issue_*` event name; emit the same
bounded issue/comment fields as an Issue Hook; and assign the indexed stable
source occurrence ID before OTLP export. The receiver owns webhook
normalization, duplicate semantic-transition suppression, source UUID indexing,
excerpt pre-sanitization, canonical URL construction, and failed-job
lookup/truncation. Maple validates and projects those facts but does not
reconstruct missing webhook data or call GitLab. Group-hook Epic coverage must
be implemented by the producer if that external scope is later authorized.
