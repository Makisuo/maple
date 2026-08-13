//! Vendored-fixture replay — the CI acceptance gate for the classifier.
//!
//! Replays `fixtures/classification/` (the pruned corpus vendored from
//! trace-capture, see its README) through the classifier's real entry points and
//! asserts the hand-reviewed per-capture goldens, the false-positive ceiling over
//! the negative sets, and the indexed-vs-direct differential (write-side plan
//! §6.1–§6.3). Unlike the sibling `ai_classifier_corpus_test.rs` — which needs
//! `TRACE_CAPTURE_DIR` pointing at the full corpus checkout and remains the
//! full-fidelity local gate — this runs on every plain `cargo test`.
//!
//! Each fixture line is one span's classifier inputs in OTLP/JSON typed encoding,
//! plus a `weight`: negatives were deduplicated onto representatives, and `weight`
//! counts the corpus population each line stands for, so weighted sums here are
//! statements about all 9,945 corpus spans, not just the 2,117 survivors. Lines
//! are rehydrated into a synthetic `ExportTraceServiceRequest` and decoded through
//! `otlp_json::normalize` + the generated types — the same two steps ingest runs
//! on the wire — so typed-value handling is exercised, not reimplemented.
//!
//! Span events ride along and are fed through `classify_span_full` — llamaindex's
//! session key rides a `workflow.output` event attribute, so this is load-bearing.
//! Link *contents* were never captured and the classifier exposes no link
//! accessor, so the fixture's `links_count` field is currently unread.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::KeyValue;
use opentelemetry_proto::tonic::trace::v1::Span;
use sha2::{Digest, Sha256};

use crate::ai_classifier::{session_state, ResourceContext, SpanClassification};
use crate::ai_registry::registry;
use crate::otlp_json;

const FIXTURE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/classification");

fn fixture_bytes(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIXTURE_DIR}/{name}"))
        .unwrap_or_else(|e| panic!("read {FIXTURE_DIR}/{name}: {e}"))
}

fn fixture_json(name: &str) -> serde_json::Value {
    serde_json::from_slice(&fixture_bytes(name)).unwrap_or_else(|e| panic!("parse {name}: {e}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn number(value: &serde_json::Value) -> usize {
    value
        .as_u64()
        .unwrap_or_else(|| panic!("expected a number, got {value:?}")) as usize
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

/// One fixture line, decoded exactly as ingest would decode it off the wire.
struct FixtureSpan {
    capture: String,
    /// Corpus spans this line represents (1 for seed captures, >=1 for the
    /// deduplicated negatives).
    weight: usize,
    /// A single-span request: `resource_spans[0].scope_spans[0].spans[0]`.
    request: ExportTraceServiceRequest,
}

impl FixtureSpan {
    fn resource_attrs(&self) -> &[KeyValue] {
        self.request.resource_spans[0]
            .resource
            .as_ref()
            .map(|r| r.attributes.as_slice())
            .unwrap_or(&[])
    }

    fn span(&self) -> &Span {
        &self.request.resource_spans[0].scope_spans[0].spans[0]
    }

    /// Hoist resource+scope, classify the span — the row writer's exact shape,
    /// events included.
    fn classify(&self) -> SpanClassification<'_> {
        let scope_spans = &self.request.resource_spans[0].scope_spans[0];
        let resource = ResourceContext::new(registry(), self.resource_attrs());
        let scope = resource.scope(scope_spans.scope.as_ref(), &scope_spans.schema_url);
        let span = self.span();
        scope.classify_span_full(&span.name, &span.attributes, &span.events)
    }
}

/// Rehydrate one JSONL line into a one-span OTLP/JSON request and decode it
/// through the crate's own wire path (`normalize` + the generated types).
///
/// The `expect` below is a whole-gate tripwire, not a per-line one: `serde_json`
/// refuses an unpaired surrogate escape ("unexpected end of hex escape"), so one bad
/// line panics the fixture loader and every test that reads it. The generator is what
/// keeps that from happening — it truncates oversized values on UTF-16 code units and
/// then drops a trailing lone high surrogate, precisely so this stays a tripwire for a
/// mangled re-vendor rather than a hazard of ordinary corpus growth. openrouter already
/// carries astral characters inside truncated values, so the boundary is reachable; if
/// this ever fires on a fresh fixture, fix the truncation upstream in trace-capture's
/// `scripts/generate-classification-fixture.ts`, not here.
fn decode_line(line: &str) -> FixtureSpan {
    let record: serde_json::Value = serde_json::from_str(line).expect("fixture line json");
    let capture = record["capture"].as_str().expect("capture").to_string();
    let weight = number(&record["weight"]);

    let events: Vec<serde_json::Value> = record["events"]
        .as_array()
        .expect("events")
        .iter()
        .map(|event| {
            serde_json::json!({
                "name": event["name"],
                "attributes": event["attrs"],
            })
        })
        .collect();
    let mut body = serde_json::json!({
        "resourceSpans": [{
            "resource": { "attributes": record["resource_attrs"] },
            "scopeSpans": [{
                "scope": {
                    "name": record["scope_name"],
                    "version": record["scope_version"],
                },
                "schemaUrl": record["scope_schema_url"],
                "spans": [{
                    "name": record["span_name"],
                    "attributes": record["span_attrs"],
                    "events": events,
                }],
            }],
        }],
    });
    otlp_json::normalize(&mut body, "resourceSpans");
    let request: ExportTraceServiceRequest =
        serde_json::from_value(body).expect("fixture line decodes as OTLP/JSON");

    // The fixture carries a `links_count` field, but link *contents* were never
    // captured and the classifier exposes no link accessor, so nothing here
    // reconstitutes links. The field stays in the fixture format so the vendored
    // artifact does not churn.
    assert_eq!(
        request.resource_spans.len(),
        1,
        "one ResourceSpans per line"
    );
    assert_eq!(request.resource_spans[0].scope_spans.len(), 1);
    assert_eq!(request.resource_spans[0].scope_spans[0].spans.len(), 1);

    FixtureSpan {
        capture,
        weight,
        request,
    }
}

/// The whole fixture, decoded once per test binary.
fn fixture() -> &'static [FixtureSpan] {
    static FIXTURE: OnceLock<Vec<FixtureSpan>> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let bytes = fixture_bytes("classification-fixture.jsonl");
        let text = std::str::from_utf8(&bytes).expect("fixture is utf-8");
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(decode_line)
            .collect()
    })
}

fn lines_of<'a>(capture: &str) -> impl Iterator<Item = &'a FixtureSpan> {
    let capture = capture.to_string();
    fixture().iter().filter(move |line| line.capture == capture)
}

// ---------------------------------------------------------------------------
// integrity — the staleness check
// ---------------------------------------------------------------------------

/// The vendored files must be byte-identical to what trace-capture generated:
/// recomputed sha256s match the manifest, and the manifest's counts match what
/// the loader actually parsed. A hand-edited fixture, a partial re-vendor, or a
/// formatter/line-ending pass over the JSONL all fail here, loudly.
#[test]
fn fixture_matches_the_manifest() {
    let manifest = fixture_json("manifest.json");
    assert_eq!(number(&manifest["format_version"]), 1, "format_version");

    assert_eq!(
        sha256_hex(&fixture_bytes("classification-fixture.jsonl")),
        manifest["fixture"]["sha256"].as_str().expect("sha256"),
        "classification-fixture.jsonl differs from the manifest — re-vendor all \
         three files together (see fixtures/classification/README.md)"
    );
    assert_eq!(
        sha256_hex(&fixture_bytes("expectations.json")),
        manifest["expectations_sha256"]
            .as_str()
            .expect("expectations_sha256"),
        "expectations.json differs from the manifest"
    );

    // The three shas above only check the fixture against itself: a hand-edit that
    // also pastes the new sha into the manifest is self-consistent. `source` is the
    // external anchor a reviewer needs to re-derive the numbers — which
    // trace-capture revision, which seeds, which generator.
    let source = manifest["source"]
        .as_object()
        .expect("manifest.source — re-vendor from a trace-capture that emits it");
    for field in ["commit", "seeds_sha256", "generator_sha256"] {
        let value = source[field].as_str().unwrap_or("");
        assert!(
            value.len() >= 40 && value.chars().all(|c| c.is_ascii_hexdigit()),
            "manifest.source.{field} is {value:?}; the fixture cannot be traced back to \
             a trace-capture revision"
        );
    }
    // `commit` only re-derives the fixture from a CLEAN tree, and this one does:
    // `git checkout <commit> && bun run fixture` in trace-capture reproduces these
    // bytes. That is what makes `source` an anchor rather than a note — the numbers
    // below are checkable against something outside this repo.
    //
    // A re-vendor that brings `dirty: true` back fails here, and that is the point:
    // it means the fixture was generated from an uncommitted trace-capture tree, so
    // `commit` names a revision that cannot produce these bytes and the provenance is
    // decorative. Such a fixture must not ship. Commit the corpus/seed change in
    // trace-capture first, regenerate, then re-vendor — do not relax this assertion.
    assert_eq!(
        source["dirty"],
        serde_json::json!(false),
        "manifest.source.dirty is true: this fixture was generated from an uncommitted \
         trace-capture tree, so `commit` names a revision that cannot re-derive it. \
         Commit in trace-capture, re-run `bun run fixture`, and re-vendor all three \
         files together — do not flip this expectation."
    );

    let lines = fixture();
    assert_eq!(
        lines.len(),
        number(&manifest["fixture"]["lines"]),
        "line count"
    );
    let weighted: usize = lines.iter().map(|line| line.weight).sum();
    assert_eq!(
        weighted,
        number(&manifest["fixture"]["weighted_spans"]),
        "weighted span total"
    );
    assert_eq!(
        weighted,
        number(&manifest["corpus"]["spans_total"]),
        "the fixture's weights must cover the whole corpus"
    );

    // Per-capture: emitted lines and represented spans both match the manifest.
    let per_capture = manifest["per_capture"].as_object().expect("per_capture");
    let mut emitted: BTreeMap<&str, usize> = BTreeMap::new();
    let mut spans: BTreeMap<&str, usize> = BTreeMap::new();
    for line in lines {
        *emitted.entry(&line.capture).or_default() += 1;
        *spans.entry(&line.capture).or_default() += line.weight;
    }
    assert_eq!(per_capture.len(), emitted.len(), "capture set");
    for (capture, entry) in per_capture {
        assert_eq!(
            emitted.get(capture.as_str()).copied().unwrap_or(0),
            number(&entry["emitted"]),
            "{capture}: emitted lines"
        );
        assert_eq!(
            spans.get(capture.as_str()).copied().unwrap_or(0),
            number(&entry["spans"]),
            "{capture}: weighted spans"
        );
    }
}

/// `ai_vendors.rs` source, read for the value-read key check below. Same posture as
/// `slug_set_mirrors_the_typescript_vendors`' `vendors.ts` include: `cfg(test)` strips
/// the item before macro expansion, so a release build never opens the path.
const AI_VENDORS_RS: &str = include_str!("ai_vendors.rs");

/// Every attribute or resource key the rules read **by value** must be part of the
/// fixture's dedup signature, or the weighted false-positive numbers are wrong.
///
/// The fixture collapses negatives onto weighted representatives. Two spans merge only
/// if they agree on every `manifest.dedup.value_sensitive_keys` entry — so a key the
/// rules compare by value that is *missing* from that set can collapse a group whose
/// members would now classify differently, and the representative's verdict is then
/// multiplied by the whole group's weight. `false_positive_ceiling_holds_on_the_negative_sets`
/// and `FIXTURE_VENDOR_HISTOGRAM` are exact-equality, so the result is not a weaker
/// gate: it is a wrong number that a reviewer ratchets a constant to.
///
/// The key set lives in trace-capture (`MAPLE_VALUE_READ_KEYS` and
/// `MAPLE_SESSION_CANDIDATE_KEYS`) and was hand-maintained across the repo boundary with
/// no check on either side. This is the check, and it belongs here because this is where
/// both inputs exist — the rules and the vendored manifest.
///
/// What "read by value" covers, precisely — there are three surfaces, not one:
///
/// * `SpanCtx::attr` and `SpanCtx::resource`, found by scanning the source. The sibling
///   accessors are presence- or prefix-only (`has_attr`, `any_attr_prefix`,
///   `any_resource_prefix`), and `events()` yields keys the candidate scan below covers.
/// * **Session-candidate keys**, which are declared *data* on `SessionCandidateDef`, so
///   they are read straight off the registry instead of parsed out of the source.
///   `candidate_state` branches on the value three ways: `require_non_empty` (every
///   candidate — `""` is state 4, not 5/6), `reject_decoy_values` (litellm's two) and
///   `granularity_of_value` (pydantic_ai's UUIDv7 test — state 5 vs 6). Since the
///   histogram is keyed `slug/session_key_state`, a candidate value that fell outside
///   the dedup signature would move weight between rows of an exact-equality constant.
///   `SessionCandidate::event_key` — the span-EVENT fallback value source — is included:
///   the generator puts event-attribute values for declared keys into the signature too.
/// * `SpanCtx::scope_attr` is a fourth by-value accessor with **zero** readers today,
///   and it is asserted to stay that way below rather than declared.
#[test]
fn value_read_keys_are_all_in_the_fixture_dedup_signature() {
    // The scan reads `ai_vendors.rs` whole, comments included, so a doc comment
    // containing a literal `.attr("x")` would add `x` to the required set. That
    // direction fails safe — a spurious requirement, never a missed one — and no
    // comment does today (the scan collects exactly the real keys).
    fn scan(accessor: &str) -> BTreeSet<&'static str> {
        let mut found: BTreeSet<&'static str> = BTreeSet::new();
        let mut rest = AI_VENDORS_RS;
        while let Some(at) = rest.find(accessor) {
            rest = &rest[at + accessor.len()..];
            if let Some(key) = rest.split('"').next() {
                found.insert(key);
            }
        }
        found
    }

    let mut read_by_value = scan(".attr(\"");
    read_by_value.append(&mut scan(".resource(\""));
    // A parser that stopped seeing the accessors would assert nothing at all.
    assert!(
        read_by_value.len() >= 10,
        "found only {} by-value key reads in ai_vendors.rs — the accessors were \
         renamed and this scan stopped seeing them: {read_by_value:?}",
        read_by_value.len()
    );

    // Session candidates: data, so no parsing. The count guard is the same idea as the
    // one above — a registry that stopped exposing candidates would assert nothing.
    // Counted directly (not as a set-size delta): a candidate key that also appears as
    // an `.attr(...)` read would deflate a delta and fail with a false message.
    let mut candidate_keys = 0usize;
    for vendor in registry().vendors() {
        for candidate in vendor.candidates() {
            candidate_keys += 1 + usize::from(candidate.event_key.is_some());
            read_by_value.insert(candidate.key);
            read_by_value.extend(candidate.event_key);
        }
    }
    assert!(
        candidate_keys >= 15,
        "found only {candidate_keys} session-candidate keys in the registry"
    );

    // `scope_attr` has no readers, and the fixture line schema has no `scope_attrs`
    // field at all (`capture, resource_attrs, scope_name, scope_version,
    // scope_schema_url, span_name, span_attrs, events, links_count, weight`), so a
    // scope key in the dedup signature would protect nothing — declaring one would be
    // the decorative kind of check this test exists to avoid. Assert the zero instead:
    // the first rule that reads a scope attribute fails here and has to make the
    // schema decision deliberately.
    let scope_reads = scan(".scope_attr(\"");
    assert!(
        scope_reads.is_empty(),
        "ai_vendors.rs now reads scope attributes by value ({scope_reads:?}), which the \
         vendored fixture cannot represent — its line schema carries no `scope_attrs` \
         field. Extend trace-capture's line schema and bump `format_version` (see \
         fixtures/classification/README.md) before shipping the rule."
    );

    let manifest = fixture_json("manifest.json");
    let declared: BTreeSet<String> = manifest["dedup"]["value_sensitive_keys"]
        .as_array()
        .expect(
            "manifest.dedup.value_sensitive_keys — re-vendor from a trace-capture that emits it",
        )
        .iter()
        .map(|key| key.as_str().expect("key is a string").to_string())
        .collect();
    let missing: Vec<&str> = read_by_value
        .iter()
        .copied()
        .filter(|key| !declared.contains(*key))
        .collect();
    assert!(
        missing.is_empty(),
        "these keys are compared by value in ai_vendors.rs but are not part of the \
         fixture's dedup signature: {missing:?}\nAdd them to MAPLE_VALUE_READ_KEYS \
         (accessor reads) or MAPLE_SESSION_CANDIDATE_KEYS (session candidates) in \
         trace-capture's scripts/generate-classification-fixture.ts, regenerate and \
         re-vendor. Until then the weighted FP numbers and the session-state rows of \
         FIXTURE_VENDOR_HISTOGRAM may be wrong by a collapsed group's weight — \
         silently, and in either direction."
    );
}

// ---------------------------------------------------------------------------
// per-capture goldens (plan §6.1)
// ---------------------------------------------------------------------------

/// Every hand-reviewed per-capture expectation reproduces through the real
/// classification pipeline. Mirrors the corpus test's identities:
///
/// * vendor span count = `vendor_span_counts[<vendor>] + harness_matched` — the
///   seed separates harness-emitted spans from the framework's own, the registry
///   has no harness concept, so registry-classified spans for the vendor cover
///   both buckets.
/// * `key_state_histogram` is the seed's per-vendor view of EVERY span in the
///   capture regardless of which vendor classified it, reproduced through
///   `evaluate_session_for_vendor`.
/// * `unsessioned_traces` is trace-level; the fixture strips trace ids, so it is
///   not replayable here (the TRACE_CAPTURE_DIR corpus test still asserts it).
///
/// Expectations already speak maple's vendor set (the D2 `langgraph` →
/// `langchain` rename is applied at generation and recorded as `renamed_from`),
/// so no slug mapping happens here.
#[test]
fn fixture_replay_matches_every_expectation() {
    let expectations = fixture_json("expectations.json");
    let per_capture = expectations["per_capture"].as_array().expect("per_capture");
    assert!(per_capture.len() >= 40, "expected the full seed set");

    let registry = registry();
    let mut failures = Vec::new();
    let mut algebra_unverified: BTreeSet<String> = BTreeSet::new();
    println!(
        "{:<34} {:<26} {:>7} {:>7} {:>6}",
        "capture", "vendor", "spans", "golden", "ok"
    );
    for entry in per_capture {
        let capture = entry["capture"].as_str().expect("capture");
        // The marker DECLARES which fields the seed evaluator cannot reproduce
        // (`{fields, why}`); everything else in a marked golden is verified over there
        // like any other. So the set pinned below is per capture+FIELD, not per capture:
        // a marker that grows a field is a golden losing its independent verifier, and
        // that is the change worth catching, not the entry's existence.
        if let Some(marker) = entry["v2_resolved"].as_object() {
            let fields = marker["fields"]
                .as_array()
                .unwrap_or_else(|| panic!("{capture}: v2_resolved must carry fields[]"));
            assert!(
                marker["why"]
                    .as_str()
                    .is_some_and(|why| !why.trim().is_empty()),
                "{capture}: v2_resolved must carry a why string"
            );
            for field in fields {
                let field = field.as_str().expect("v2_resolved field name");
                algebra_unverified.insert(format!("{capture}.{field}"));
            }
        }
        let vendor_slug = entry["vendor"].as_str().expect("vendor");
        let vendor = registry
            .vendor_id(vendor_slug)
            .unwrap_or_else(|| panic!("registry has no vendor {vendor_slug}"));
        let golden_total = number(&entry["total_spans"]);
        let golden_vendor_spans =
            number(&entry["vendor_span_counts"][vendor_slug]) + number(&entry["harness_matched"]);
        let mut golden_histogram: BTreeMap<u8, usize> = BTreeMap::new();
        for (state, count) in entry["key_state_histogram"]
            .as_object()
            .expect("key_state_histogram")
        {
            golden_histogram.insert(state.parse().expect("state"), number(count));
        }

        let mut total = 0usize;
        let mut vendor_spans = 0usize;
        let mut histogram: BTreeMap<u8, usize> = BTreeMap::new();
        for line in lines_of(capture) {
            total += line.weight;
            let classified = line.classify();
            assert_eq!(classified.rules_version, registry.version());
            if classified.vendor_slug() == vendor_slug {
                vendor_spans += line.weight;
            }
            let scope_spans = &line.request.resource_spans[0].scope_spans[0];
            let resource = ResourceContext::new(registry, line.resource_attrs());
            let scope = resource.scope(scope_spans.scope.as_ref(), &scope_spans.schema_url);
            let span = line.span();
            let (state, _) = scope.evaluate_session_for_vendor(
                vendor,
                &span.name,
                &span.attributes,
                &span.events,
            );
            *histogram.entry(state).or_default() += line.weight;
        }

        let mut problems = Vec::new();
        if total != golden_total {
            problems.push(format!("span count {total} != golden {golden_total}"));
        }
        if vendor_spans != golden_vendor_spans {
            problems.push(format!(
                "vendor spans {vendor_spans} != golden {golden_vendor_spans}"
            ));
        }
        if histogram != golden_histogram {
            problems.push(format!(
                "key_state_histogram {histogram:?} != golden {golden_histogram:?}"
            ));
        }
        println!(
            "{:<34} {:<26} {:>7} {:>7} {:>6}",
            capture,
            vendor_slug,
            vendor_spans,
            golden_vendor_spans,
            if problems.is_empty() { "PASS" } else { "FAIL" }
        );
        if !problems.is_empty() {
            failures.push(format!("{capture}: {}", problems.join("; ")));
        }
    }
    assert!(
        failures.is_empty(),
        "expectation mismatches:\n{}",
        failures.join("\n")
    );

    // Six golden FIELDS are marked `v2_resolved` in trace-capture: the shipped rule is
    // outside `verify-seed.ts`'s algebra, so those numbers were predicted by hand.
    // Naming them keeps the tautology visible — a number refreshed by running this very
    // classifier over the capture would make the assertion "the classifier equals
    // itself", recorded nowhere. New entries are legitimate but must be deliberate.
    //
    // "THIS replay is their only check" is true of four of the six, and the exceptions
    // are named here because nothing else names them:
    //   * `pydantic_ai_agents.unsessioned_traces` is trace-level and this fixture strips
    //     trace ids, so only `ai_classifier_corpus_test.rs` asserts it — and that needs
    //     `TRACE_CAPTURE_DIR`, which no CI workflow sets (the corpus lives in the other
    //     repo). Local-only gate.
    //   * `pydantic_ai_agents.key_state_by_candidate` is not emitted into
    //     `expectations.json` at all. It has no automated asserter anywhere.
    // Both sit on the P1 ruling (decided 2026-08-13); if it is ever revisited,
    // start here.
    println!(
        "algebra-unverified golden fields (v2_resolved): {:?}",
        algebra_unverified
    );
    assert_eq!(
        algebra_unverified,
        BTreeSet::from([
            "llamaindex_agents.key_state_histogram".to_string(),
            "llamaindex_user.key_state_histogram".to_string(),
            "pydantic_ai_agents.key_state_by_candidate".to_string(),
            "pydantic_ai_agents.key_state_histogram".to_string(),
            "pydantic_ai_agents.unsessioned_traces".to_string(),
            "spring_ai_agents.vendor_span_counts".to_string(),
        ]),
        "the set of golden FIELDS with no independent verifier changed — a field \
         joining this set is a golden losing its seed-side check"
    );
}

// ---------------------------------------------------------------------------
// whole-fixture vendor histogram (plan §6.1)
// ---------------------------------------------------------------------------

/// The per-capture goldens above assert only the *entry* vendor's span count, so
/// a span moving between two non-entry vendors — or a vendor that is the entry
/// vendor of no capture going completely dead — is invisible to them.
/// `openinference-openai` is exactly that case: it is the synthesized vendor for
/// a shared instrumentor scope, so no seed names it, yet it claims corpus spans
/// inside six captures.
///
/// This is the whole-fixture weighted verdict distribution, exact-equality like
/// the FP ceilings and a ratchet in both directions: any rules change that moves
/// a span between two verdicts fails here and gets reviewed. `None` (non-AI) is
/// the residual and is asserted as its own row (`/0`) so the totals close.
///
/// Rows are keyed `slug/session_key_state`, not `slug` alone. Keyed on the slug, the
/// table gated *detection* for non-entry vendors but not their session authority:
/// setting `openinference-openai`'s authority to `|_| false` moved its 23 spans from
/// three states to two and every assertion here stayed green. The state suffix costs
/// ~15 more rows and closes the class rather than that one instance.
#[test]
fn fixture_vendor_histogram_is_exactly_the_golden_distribution() {
    let mut histogram: BTreeMap<String, usize> = BTreeMap::new();
    for line in fixture() {
        let classified = line.classify();
        let slug = match classified.vendor {
            Some(_) => classified.vendor_slug(),
            None => "",
        };
        *histogram
            .entry(format!("{slug}/{}", classified.session_state))
            .or_default() += line.weight;
    }
    let golden: BTreeMap<String, usize> = FIXTURE_VENDOR_HISTOGRAM
        .iter()
        .map(|(key, count)| ((*key).to_string(), *count))
        .collect();
    if histogram != golden {
        let mut diff = Vec::new();
        let mut vendor_rows_moved = false;
        let slugs: BTreeSet<_> = histogram.keys().chain(golden.keys()).collect();
        for slug in slugs {
            let got = histogram.get(slug.as_str()).copied().unwrap_or(0);
            let want = golden.get(slug.as_str()).copied().unwrap_or(0);
            if got != want {
                diff.push(format!("  {slug:<26} got {got:>6}  golden {want:>6}"));
                // `unknown:*` and the non-AI residue are where the two live captures'
                // growth lands; a named vendor moving is not.
                vendor_rows_moved |= !slug.starts_with('/') && !slug.starts_with("unknown:");
            }
        }
        // The two diagnoses need different actions, and telling a re-vendorer to
        // "review every line" for what is really corpus drift is how a ratchet loses
        // its meaning.
        let diagnosis = if vendor_rows_moved {
            "a VENDOR row moved: this is a rules change. Review every moved line and \
             update FIXTURE_VENDOR_HISTOGRAM in the same PR — including whether the FP \
             ceilings moved with it."
        } else {
            "only unknown-tier / non-AI rows moved: most likely live-capture drift \
             (openrouter and eve_slack are still recording). Re-vendor the fixture and \
             update the constants, noting the new span counts in the commit message. If \
             you did NOT re-vendor, this is a bucketing regression and needs review."
        };
        panic!(
            "the fixture's weighted vendor distribution moved — {diagnosis}\n{}",
            diff.join("\n")
        );
    }
    let total: usize = histogram.values().sum();
    assert_eq!(
        total,
        fixture().iter().map(|line| line.weight).sum::<usize>(),
        "every corpus span has exactly one verdict"
    );
}

/// Weighted verdict counts over the whole vendored fixture. `""` is non-AI.
/// Sums to the corpus total.
///
/// **Two captures are live** — openrouter AND eve_slack — so regenerating legitimately
/// moves `unknown:genai` (openrouter) and the non-AI residue `""` (both). A *vendor* row
/// moving is a rules change and needs the same review as an FP ceiling bump — with one
/// caveat the failure message repeats: eve_slack is an AI-SDK application, so its growth
/// CAN land in `vercel_ai_sdk`. If a pure re-vendor moves that row and nothing else,
/// that is drift wearing a rules change's clothes; the fix is freezing the negative sets
/// (standing owner decision), not ratcheting on faith.
///
/// The two licensed rows carry 82% of the fixture's weight (`unknown:genai/1` 4,021 +
/// the non-AI residue `/0` 4,153, of 9,945), which is more slack than a ratchet should
/// have: a ~200-span bucketing regression landing in the same PR as a re-vendor reads as
/// drift. The FP test pins what this table cannot — openrouter's unknown-bucket *set* is
/// exactly `{unknown:genai}`, an assertion immune to live growth.
///
/// Re-measured 2026-08-13 against the reverted corpus (9,945 spans; the two live captures
/// were rolled back to their committed state and the ingest URL moved at the origin, so
/// they stop growing) and the S11 narrowing of `vercel_ai_sdk`. Both moves are visible in
/// this table: the corpus revert took `unknown:genai/1` 5,153 → 3,968 and `/0` 4,170 →
/// 4,153, and the narrowing then moved 53 spans `vercel_ai_sdk/1` 280 → 227 into
/// `unknown:genai/1` 3,968 → 4,021.
const FIXTURE_VENDOR_HISTOGRAM: &[(&str, usize)] = &[
    ("/0", 4153),
    ("agno/2", 26),
    ("agno/6", 11),
    ("claude_agent_sdk/6", 61),
    ("crewai/3", 21),
    ("dspy/3", 160),
    ("effect_ai/1", 61),
    ("flue/5", 38),
    ("flue/6", 10),
    ("google_adk/2", 40),
    ("google_adk/6", 91),
    ("haystack/1", 80),
    ("langchain/3", 20),
    ("langchain/6", 42),
    ("litellm/2", 17),
    ("litellm/4", 20),
    ("llamaindex/5", 154),
    ("mastra/5", 58),
    ("mastra/6", 66),
    ("microsoft_agent_framework/2", 40),
    ("microsoft_agent_framework/3", 13),
    ("openai_agents_sdk/3", 76),
    // The synthesized vendor for the shared `openinference.instrumentation.openai`
    // scope: the entry vendor of no capture, so this row is the only replay gate
    // that notices if its detect goes dead — or, with the `/state` suffix, if its
    // session authority does.
    ("openinference-openai/3", 23),
    ("pydantic_ai/5", 20),
    ("pydantic_ai/6", 19),
    ("semantic_kernel/1", 75),
    ("smolagents/6", 130),
    ("spring_ai/2", 81),
    ("spring_ai/3", 5),
    ("spring_ai/6", 8),
    ("strands/3", 1),
    ("strands/6", 57),
    ("unknown:genai/1", 4021),
    ("unknown:openinference/1", 2),
    ("unknown:other/1", 18),
    ("vercel_ai_sdk/1", 227),
];

// ---------------------------------------------------------------------------
// false-positive ceiling (plan §6.2)
// ---------------------------------------------------------------------------

/// Over the vendor-negative populations, weighted so the numbers speak for the
/// full corpus. "Claimed" means a *specific* vendor — the `unknown:*` buckets
/// are the correct verdict for most of openrouter's traffic, not a false
/// positive.
#[test]
fn false_positive_ceiling_holds_on_the_negative_sets() {
    let expectations = fixture_json("expectations.json");
    let mut visited: BTreeSet<&str> = BTreeSet::new();
    for entry in expectations["negative_sets"]
        .as_array()
        .expect("negative_sets")
    {
        if entry["fp_negative_set"] != serde_json::Value::Bool(true) {
            continue;
        }
        let capture = entry["capture"].as_str().expect("capture");
        visited.insert(capture);
        let mut claimed: BTreeMap<&'static str, usize> = BTreeMap::new();
        let mut unknown_buckets: BTreeSet<&'static str> = BTreeSet::new();
        let mut eve_turn = 0usize;
        let mut eve_turn_unknown_other = 0usize;
        for line in lines_of(capture) {
            let classified = line.classify();
            let is_eve_turn = line.span().name == "ai.eve.turn";
            let Some(vendor) = classified.vendor else {
                continue;
            };
            if vendor.is_unknown_bucket() {
                unknown_buckets.insert(classified.vendor_slug());
                if is_eve_turn && classified.vendor_slug() == "unknown:other" {
                    eve_turn_unknown_other += line.weight;
                }
                continue;
            }
            *claimed.entry(classified.vendor_slug()).or_default() += line.weight;
            if is_eve_turn {
                eve_turn += line.weight;
            }
        }
        println!(
            "{capture}: vendor-claimed {claimed:?} \
             (ai.eve.turn claimed: {eve_turn}, ai.eve.turn unknown:other: \
             {eve_turn_unknown_other})"
        );
        // The whole-fixture histogram cannot pin openrouter's bucketing: its
        // `unknown:genai` row is 46% of the fixture's weight and licensed to move with
        // the live capture, so a few hundred spans landing in the wrong unknown bucket
        // read as drift. The SET is immune to growth, needs no maintenance when the
        // capture grows, and is exactly the claim the ratchet cannot make.
        if capture == "openrouter" {
            assert_eq!(
                unknown_buckets,
                BTreeSet::from(["unknown:genai"]),
                "openrouter's unknown-tier bucketing moved. Every one of its spans \
                 carries gen_ai.* and belongs in unknown:genai; a second bucket \
                 appearing (or this one vanishing) is a bucketing regression, not \
                 corpus drift — the capture growing cannot change this set"
            );
        }
        expected_claims(capture, &claimed, eve_turn, eve_turn_unknown_other);
    }
    // The loop is driven entirely by fixture data, so without this the test
    // passes while asserting nothing — a regeneration that drops a capture or
    // stops marking it `fp_negative_set` would silently delete the gate.
    // openrouter in particular is the corpus' canonical vendor-negative trap.
    assert_eq!(
        visited,
        BTreeSet::from(["eve_slack", "eve_slack_no_messages", "openrouter"]),
        "the FP negative sets are a fixed set — a capture appearing or \
         disappearing here is a deliberate change, not a regeneration artifact"
    );
}

/// The exact per-capture ceilings. Exact equality, not `<= N`: a rules change
/// that *reduces* a number below its constant is a ratchet — move the constant
/// down in the same PR — and one that raises it is a regression.
fn expected_claims(
    capture: &str,
    claimed: &BTreeMap<&'static str, usize>,
    eve_turn: usize,
    eve_turn_unknown_other: usize,
) {
    match capture {
        // openrouter is the canonical vendor-negative trap: 3,968 spans of
        // legitimately unknown-tier AI traffic, the overwhelming majority of
        // which carry the bare `span.type` key (values `span`/`generation`) that
        // claude_agent_sdk's dialect clause reads — kept out structurally since
        // phase-2 C2 (the clause is conjunctive with
        // `service.name=claude-code`, on zero of these spans), not just by value
        // disjointness. Phase 2 also aimed semantic_kernel's `FinishReason.`
        // fallback and spring_ai's `gen_ai.system == "openai"` conjunct straight
        // at this population; both stay out. No span may resolve to a specific
        // vendor.
        "openrouter" => {
            assert_eq!(
                *claimed,
                BTreeMap::new(),
                "openrouter must never classify as a specific vendor"
            );
        }
        // eve_slack genuinely contains Vercel AI SDK traffic (eve is built on
        // it). Phase 2 replaced the unconditional `ai.` evidence with a
        // scope-gated form, which eliminated 9 FALSE positives here: eve's own
        // `ai.eve.turn` orchestration spans (scope `eve`, not an AI-SDK scope)
        // were claimed by `vercel_ai_sdk` on the bare `ai.` prefix and now land
        // `unknown:other`, asserted below so a regression in either direction
        // (re-claiming them, or losing the unknown-tier reachability the X3 rule
        // restored) is loud.
        //
        // The same phase-2 pass also briefly ADDED a `scope == "gen_ai"` clause
        // that recovered 30 true positives here (92 -> 122). The owner removed it
        // on 2026-08-13 (S11): the clause's only conjunct was a key OTel semconv
        // requires on every GenAI span, so it reduced to "a tracer named `gen_ai`
        // claims everything inside it" over customer-chosen data, and the corpus
        // cannot witness that failure mode. The 30 spans are back in
        // `unknown:genai` and this constant is back to 92 — narrow by choice. See
        // `detect_vercel_ai_sdk`.
        "eve_slack" => {
            assert_eq!(eve_turn, EVE_TURN_FALSE_POSITIVES, "ai.eve.turn FPs");
            assert_eq!(
                eve_turn_unknown_other, EVE_TURN_UNKNOWN_OTHER,
                "ai.eve.turn spans must reach unknown:other (X3)"
            );
            assert_eq!(
                *claimed,
                BTreeMap::from([("vercel_ai_sdk", 92)]),
                "the scope-gated `ai.` clause and the two AI-SDK-invented markers; \
                 the 30 default-config `chat` spans are unknown:genai by decision"
            );
        }
        // Same service re-recorded without message payloads: the same 9-strong
        // `ai.eve.turn` false-positive population eliminated by the same predicate
        // change, and the same 23 default-config `chat` spans given up with S11
        // (83 -> 60).
        "eve_slack_no_messages" => {
            assert_eq!(eve_turn, EVE_TURN_FALSE_POSITIVES, "ai.eve.turn FPs");
            assert_eq!(
                eve_turn_unknown_other, EVE_TURN_UNKNOWN_OTHER,
                "ai.eve.turn spans must reach unknown:other (X3)"
            );
            assert_eq!(
                *claimed,
                BTreeMap::from([("vercel_ai_sdk", 60)]),
                "same rule as eve_slack; the 23 default-config `chat` spans are \
                 unknown:genai by decision"
            );
        }
        other => panic!("unexpected fp_negative_set capture {other} — add its ceiling here"),
    }
}

/// `ai.eve.turn` spans per eve capture misclassified as `vercel_ai_sdk`. Was 9
/// in v1 (the bare `ai.` prefix); phase 2's scope gate ratcheted it to zero.
/// This is a floor as much as a ceiling — raising it needs a rule change and a
/// deliberate decision, not a constant bump.
const EVE_TURN_FALSE_POSITIVES: usize = 0;

/// Where those 9 spans go instead: the `unknown:other` catch-all. Asserted
/// explicitly (vercel spec X3) because "no longer a false positive" has two very
/// different endings — correctly bucketed, or silently dropped out of the
/// unknown tier entirely. The unit-test half of X3 lives in `ai_classifier.rs`
/// (`an_unclaimed_ai_prefixed_span_reaches_unknown_other`).
const EVE_TURN_UNKNOWN_OTHER: usize = 9;

// ---------------------------------------------------------------------------
// indexed vs direct differential (plan §6.3)
// ---------------------------------------------------------------------------

/// The prefilter/candidate fast path agrees with naive evaluate-every-vendor
/// over every span in the fixture — the internal differential that catches an
/// optimization silently changing semantics, over real data. The direct path
/// reads the **raw, unprefiltered** attribute lists (session state included),
/// so this is also the net for declared-hint drift: a predicate or authority
/// function consulting a key its vendor did not declare diverges here.
#[test]
fn indexed_dispatch_agrees_with_direct_evaluation_over_the_fixture() {
    let mut checked = 0usize;
    for line in fixture() {
        let scope_spans = &line.request.resource_spans[0].scope_spans[0];
        let resource = ResourceContext::new(registry(), line.resource_attrs());
        let scope = resource.scope(scope_spans.scope.as_ref(), &scope_spans.schema_url);
        let span = line.span();

        let indexed = scope.classify_span_full(&span.name, &span.attributes, &span.events);
        let direct = scope.classify_span_unindexed(&span.name, &span.attributes, &span.events);
        assert_eq!(
            indexed.vendor, direct,
            "{}: indexed vs direct disagree on {}",
            line.capture, span.name
        );
        let direct_state = match direct {
            Some(vendor) => {
                scope.evaluate_session_for_vendor_unindexed(
                    vendor,
                    &span.name,
                    &span.attributes,
                    &span.events,
                )
            }
            None => session_state::NOT_EXAMINED,
        };
        assert_eq!(
            indexed.session_state, direct_state,
            "{}: session state diverged on {}",
            line.capture, span.name
        );
        checked += 1;
    }
    println!("{checked} fixture spans checked indexed vs direct");
    assert_eq!(checked, fixture().len());
}

// ---------------------------------------------------------------------------
// at most one vendor matches any span (plan v2 §1)
// ---------------------------------------------------------------------------

/// The resolution rule's supporting invariant: at most one vendor's `detect`
/// fires on any span, so the [`crate::ai_vendors::VENDORS`] slice order is not
/// load-bearing on real wire data. Measured over the entire vendored fixture —
/// today the overlap count is exactly **zero**, so there is no allowlist: the
/// first fixture span two vendors both claim fails this test, and a human
/// decides the ordering deliberately (or fixes the rules) rather than shipping
/// an accidental winner. The `TRACE_CAPTURE_DIR` corpus test asserts the same
/// over the full corpus.
///
/// The adversarial fixture (`ai_adversarial_fixtures.rs`) is
/// deliberately NOT under this invariant: its `cross_vendor/*` and
/// `oversized/spilled_registry_keys` spans construct multi-vendor evidence to
/// pin the resolution order itself.
#[test]
fn at_most_one_vendor_matches_any_fixture_span() {
    let mut overlaps = Vec::new();
    for line in fixture() {
        let scope_spans = &line.request.resource_spans[0].scope_spans[0];
        let resource = ResourceContext::new(registry(), line.resource_attrs());
        let scope = resource.scope(scope_spans.scope.as_ref(), &scope_spans.schema_url);
        let span = line.span();
        let firing = scope.firing_vendors(&span.name, &span.attributes, &span.events);
        if firing.len() > 1 {
            overlaps.push(format!(
                "{}: span {:?} fires {firing:?}",
                line.capture, span.name
            ));
        }
    }
    assert!(
        overlaps.is_empty(),
        "vendor detects overlap on fixture spans — decide the resolution order \
         deliberately (see VENDORS' doc comment) instead of shipping an accidental \
         winner:\n{}",
        overlaps.join("\n")
    );
}
