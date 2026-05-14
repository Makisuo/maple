#!/usr/bin/env python3
"""Render the ingest load benchmark comment posted on PRs.

Inputs (env):
- HEAD_LOAD_JSON   comma-separated paths to per-iteration LoadSummary JSON files
                   for the PR. Multiple paths => median + min/max.
- BASE_LOAD_JSON   same shape, for the base branch. Empty/missing => no
                   baseline available (rendered as absolute-only table).
- TEST_OUTPUT      path to a cargo test log (tail is embedded).
- CRITERION_OUTPUT optional path to `cargo bench --output-format=bencher` output.
- COMMENT_OUTPUT   path to write the rendered markdown.
- GITHUB_SHA       optional commit SHA shown in the header.

The first line of the output is a stable HTML marker so the workflow can find
and update the existing PR comment instead of appending new ones.
"""
import json
import os
import re
from pathlib import Path
from statistics import median
from typing import Optional

MARKER = "<!-- ingest-bench-comment -->"
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def parse_paths(raw: Optional[str]) -> list[Path]:
    if not raw:
        return []
    return [Path(piece.strip()) for piece in raw.split(",") if piece.strip()]


def load_runs(raw: Optional[str]) -> list[dict]:
    out = []
    for path in parse_paths(raw):
        if not path.exists():
            continue
        try:
            out.append(json.loads(path.read_text()))
        except json.JSONDecodeError:
            continue
    return out


def numeric(runs: list[dict], key: str) -> list[float]:
    values: list[float] = []
    for run in runs:
        value = run.get(key)
        if isinstance(value, (int, float)):
            values.append(float(value))
    return values


def aggregate(runs: list[dict], key: str) -> Optional[float]:
    values = numeric(runs, key)
    if not values:
        return None
    return median(values)


def value_range(runs: list[dict], key: str) -> Optional[tuple[float, float]]:
    values = numeric(runs, key)
    if not values:
        return None
    return min(values), max(values)


def fmt(value: Optional[float], suffix: str = "", precision: int = 2) -> str:
    if value is None:
        return "n/a"
    if float(value).is_integer() and not suffix.endswith("ms") and suffix not in (" MiB", "%"):
        return f"{int(value)}{suffix}"
    return f"{value:.{precision}f}{suffix}"


def fmt_range(span: Optional[tuple[float, float]], suffix: str, precision: int) -> str:
    if span is None:
        return ""
    lo, hi = span
    return f" (min {lo:.{precision}f}, max {hi:.{precision}f}{suffix})"


def delta(current: Optional[float], base: Optional[float], lower_is_better: bool) -> str:
    if current is None or base is None:
        return "n/a"
    if base == 0:
        if current == 0:
            return "same"
        return "baseline 0"
    if abs(base) < 0.01:
        absolute = current - base
        good = absolute <= 0 if lower_is_better else absolute >= 0
        return f"{absolute:+.2f} {'better' if good else 'worse'}"
    pct = (current - base) / base * 100.0
    good = pct <= 0 if lower_is_better else pct >= 0
    sign = "+" if pct >= 0 else ""
    return f"{sign}{pct:.1f}% {'better' if good else 'worse'}"


def tail(path: Optional[str], lines: int) -> str:
    if not path or not Path(path).exists():
        return "output unavailable"
    content = Path(path).read_text(errors="replace")
    content = ANSI_RE.sub("", content).rstrip("\n")
    return "\n".join(content.splitlines()[-lines:])


METRICS = [
    ("Requests/sec", "request_rps", "", 2, False),
    ("Rows/sec", "row_rps", "", 2, False),
    ("p50 latency", "p50_ms", " ms", 2, True),
    ("p95 latency", "p95_ms", " ms", 2, True),
    ("p99 latency", "p99_ms", " ms", 2, True),
    ("Export catch-up", "export_catchup_seconds", " s", 3, True),
    ("Max RSS", "max_rss_mb", " MiB", 2, True),
    ("Failures", "failures", "", 0, True),
]


def comparison_table(base: list[dict], head: list[dict]) -> list[str]:
    rows = [
        "| Metric | main (median) | PR (median) | Delta |",
        "| --- | ---: | ---: | ---: |",
    ]
    for label, key, suffix, precision, lower in METRICS:
        b = aggregate(base, key)
        h = aggregate(head, key)
        rows.append(
            f"| {label} "
            f"| {fmt(b, suffix, precision)} "
            f"| {fmt(h, suffix, precision)} "
            f"| {delta(h, b, lower)} |"
        )
    return rows


def absolute_table(head: list[dict]) -> list[str]:
    rows = [
        "| Metric | PR (median) | Spread |",
        "| --- | ---: | ---: |",
    ]
    for label, key, suffix, precision, _lower in METRICS:
        h = aggregate(head, key)
        spread = value_range(head, key)
        rows.append(
            f"| {label} "
            f"| {fmt(h, suffix, precision)} "
            f"| {fmt_range(spread, suffix, precision).strip() or '—'} |"
        )
    return rows


def render_runs_json(runs: list[dict]) -> str:
    if not runs:
        return "no runs captured"
    return json.dumps(runs, indent=2)


def main() -> None:
    head_runs = load_runs(os.environ.get("HEAD_LOAD_JSON"))
    base_runs = load_runs(os.environ.get("BASE_LOAD_JSON"))
    test_output = os.environ.get("TEST_OUTPUT")
    criterion_output = os.environ.get("CRITERION_OUTPUT")
    out = Path(os.environ["COMMENT_OUTPUT"])

    head_mode = head_runs[0].get("ingest_mode", "tinybird") if head_runs else "tinybird"
    base_mode = base_runs[0].get("ingest_mode") if base_runs else None
    same_mode = bool(base_runs) and base_mode == head_mode

    body: list[str] = [MARKER, "## Ingest Rust Test + Benchmark Results", ""]
    body.append(f"**Commit:** `{os.environ.get('GITHUB_SHA', 'unknown')}`")
    body.append("")

    if same_mode:
        body += [
            f"### Load Benchmark — `{head_mode}` mode, median of {len(head_runs)} run(s) vs main",
            "",
            *comparison_table(base_runs, head_runs),
            "",
            "Same code path on both sides (same `LOAD_TEST_INGEST_MODE`), so the delta column is meaningful. Numbers come from `ubuntu-latest`, which is noisy — treat single-digit-percent deltas as noise.",
            "",
        ]
    else:
        head_label = f"`{head_mode}`"
        if base_runs and not same_mode:
            note = (
                f"Baseline ran in `{base_mode}` mode while PR ran in {head_label} mode — "
                "cross-mode comparison is misleading, so only absolute PR numbers are shown."
            )
        else:
            note = (
                f"No baseline benchmark on main yet (this PR introduces {head_label} mode). "
                "Once it lands, future PRs will get a real PR-vs-main delta automatically."
            )
        body += [
            f"### Load Benchmark — `{head_mode}` mode, {len(head_runs)} run(s)",
            "",
            *absolute_table(head_runs),
            "",
            note,
            "",
        ]

    body += [
        "<details><summary>PR load benchmark JSON (per-iteration)</summary>",
        "",
        "```json",
        render_runs_json(head_runs),
        "```",
        "",
        "</details>",
        "",
    ]
    if base_runs:
        body += [
            "<details><summary>main load benchmark JSON (per-iteration)</summary>",
            "",
            "```json",
            render_runs_json(base_runs),
            "```",
            "",
            "</details>",
            "",
        ]

    if criterion_output and Path(criterion_output).exists():
        body += [
            "### WAL-acked microbench (`cargo bench --bench ingest_bench`)",
            "",
            "```text",
            tail(criterion_output, 60),
            "```",
            "",
        ]

    body += [
        "### cargo test",
        "",
        "```text",
        tail(test_output, 80),
        "```",
    ]

    out.write_text("\n".join(body) + "\n")


if __name__ == "__main__":
    main()
