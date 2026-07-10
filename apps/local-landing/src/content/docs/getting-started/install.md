---
title: "Install"
description: "Install the maple binary with Homebrew or the curl installer — two files, one command, on macOS and Linux."
group: "Getting Started"
order: 1
---

Maple Local ships as a relocatable **2-file bundle**: the `maple` binary (CLI + OTLP ingest + query server + embedded dashboard) and `libchdb` (the embedded ClickHouse engine, ~320 MB). Both installers fetch it from the latest [GitHub release](https://github.com/Makisuo/maple/releases) and verify its checksum.

Supported platforms: **macOS (Apple Silicon)** and **Linux (x86_64 & arm64)**. On Windows, use WSL2 and follow the Linux path.

## Homebrew (recommended)

```bash
brew install Makisuo/tap/maple
```

Homebrew downloads the matching release bundle, verifies its checksum, installs `maple` and `libchdb.so` together in the Homebrew Cellar, and links `maple` onto your PATH. If Homebrew asks you to trust the third-party tap, run `brew trust Makisuo/tap` once and retry the install.

## Curl installer

```bash
curl -fsSL https://maple.dev/cli/install | sh
```

The installer detects your OS/arch, downloads the matching bundle from the latest GitHub release, verifies its checksum, installs the two files into `~/.maple/bin`, clears the macOS Gatekeeper quarantine, and symlinks `maple` onto your PATH.

> Prefer to read before piping to a shell? The script is [`scripts/install.sh`](https://github.com/Makisuo/maple/blob/main/scripts/install.sh) in the repo, and you can always download a release bundle by hand from [GitHub Releases](https://github.com/Makisuo/maple/releases).

Environment overrides for the installer:

| Variable | Effect |
| --- | --- |
| `MAPLE_VERSION` | Pin a release tag instead of latest |
| `MAPLE_INSTALL_DIR` | Bundle location (default `~/.maple/bin`) |
| `MAPLE_BIN_DIR` | Where the PATH symlink goes |
| `MAPLE_SKIP_CHECKSUM=1` | Skip SHA-256 verification (air-gapped mirrors only; not recommended) |

## Verify

```bash
maple --version
maple start
```

`maple start` prints a banner with the OTLP endpoint (`:4318`) and the dashboard URL. Continue with the [Quickstart](/docs/getting-started/quickstart).

## Manual download

Every release on [GitHub Releases](https://github.com/Makisuo/maple/releases) contains per-platform bundles with a `.sha256` beside each. Keep `maple` and `libchdb` **in the same directory** — at runtime `maple` loads the sibling `libchdb` relative to its own path, so no `LD_LIBRARY_PATH` tricks are needed.
