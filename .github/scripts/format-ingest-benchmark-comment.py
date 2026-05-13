#!/usr/bin/env python3
import json
import os
from pathlib import Path
from typing import Optional


def load_json(path: Optional[str]):
    if not path:
        return None
    p = Path(path)
    if not p.exists():
        return None
    raw = p.read_text()
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    return json.loads(raw[start : end + 1])


def tail(path: Optional[str], lines: int) -> str:
    if not path or not Path(path).exists():
        return "output unavailable"
    content = Path(path).read_text(errors="replace").splitlines()
    return "\n".join(content[-lines:])


def fmt(value, suffix="", precision=2):
    if value is None:
        return "n/a"
    if isinstance(value, int):
        return f"{value}{suffix}"
    return f"{value:.{precision}f}{suffix}"


def delta(current, base, lower_is_better=False):
    if current is None or base is None:
        return "n/a"
    if base == 0:
        return "same" if current == 0 else "baseline was 0"
    if abs(base) < 0.01:
        absolute = current - base
        good = absolute <= 0 if lower_is_better else absolute >= 0
        marker = "better" if good else "worse"
        return f"{absolute:+.2f} absolute {marker}"
    pct = (current - base) / base * 100.0
    good = pct <= 0 if lower_is_better else pct >= 0
    marker = "better" if good else "worse"
    sign = "+" if pct >= 0 else ""
    return f"{sign}{pct:.1f}% {marker}"


def metric_row(label, key, base, current, suffix="", lower_is_better=False):
    return (
        f"| {label} | {fmt(base.get(key) if base else None, suffix)} "
        f"| {fmt(current.get(key) if current else None, suffix)} "
        f"| {delta(current.get(key) if current else None, base.get(key) if base else None, lower_is_better)} |"
    )


def main():
    base = load_json(os.environ.get("BASE_LOAD_JSON"))
    current = load_json(os.environ.get("HEAD_LOAD_JSON"))
    test_output = os.environ.get("TEST_OUTPUT")
    out = Path(os.environ["COMMENT_OUTPUT"])

    rows = [
        metric_row("Requests/sec", "request_rps", base, current),
        metric_row("Rows/sec", "row_rps", base, current),
        metric_row("p50 latency", "p50_ms", base, current, " ms", True),
        metric_row("p95 latency", "p95_ms", base, current, " ms", True),
        metric_row("p99 latency", "p99_ms", base, current, " ms", True),
        metric_row("Export catch-up", "export_catchup_seconds", base, current, " s", True),
        metric_row("Max RSS", "max_rss_mb", base, current, " MiB", True),
        metric_row("Max CPU", "max_cpu_percent", base, current, "%", True),
        metric_row("Avg CPU", "avg_cpu_percent", base, current, "%", True),
        metric_row("Failures", "failures", base, current, "", True),
    ]

    body = [
        "## Ingest Rust Test + Benchmark Results",
        "",
        f"**Commit:** `{os.environ.get('GITHUB_SHA', 'unknown')}`",
        "",
        "### Load Benchmark Compared To `main`",
        "",
        "| Metric | main | PR | Delta vs main |",
        "| --- | ---: | ---: | ---: |",
        *rows,
        "",
        "Benchmark setup: the same OTLP protobuf log workload is sent to both binaries. `main` runs the collector-forwarding path against a fake collector endpoint; the PR runs native Tinybird mode against a fake Tinybird endpoint. Both runs sample the ingest process RSS and CPU via `ps`.",
        "",
        "<details><summary>PR load benchmark JSON</summary>",
        "",
        "```json",
        json.dumps(current, indent=2) if current else "current benchmark output unavailable",
        "```",
        "",
        "</details>",
        "",
        "<details><summary>main load benchmark JSON</summary>",
        "",
        "```json",
        json.dumps(base, indent=2) if base else "main benchmark output unavailable",
        "```",
        "",
        "</details>",
        "",
        "### cargo test",
        "",
        "```text",
        tail(test_output, 80),
        "```",
    ]
    out.write_text("\n".join(body) + "\n")


if __name__ == "__main__":
    main()
