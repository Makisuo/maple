---
title: "Updating & uninstalling"
description: "Keep the binary current with brew upgrade or maple update, and remove it cleanly when you're done."
group: "Operations"
order: 3
---

Update with the same tool you installed with.

## Homebrew

```bash
brew upgrade maple
brew uninstall maple
```

Homebrew installs are managed by Homebrew: the wrapper disables Maple's startup update check, and `maple update` exits with a reminder to use `brew upgrade maple`.

## Curl-installer builds

Manual-installer builds keep themselves current:

- **Startup notice.** On any command, `maple` checks GitHub Releases for a newer version — at most **once per 24h** (cached in `~/.maple/config.json`, so every other run stays instant and offline). When a newer release exists it prints a one-line `update available` notice to stderr; it never changes behavior mid-run. The check is skipped for non-interactive shells (CI/pipes) and the `--version`/`--help`/`update` paths. Opt out entirely with `MAPLE_NO_UPDATE_CHECK=1`.
- **`maple update`** downloads the latest release bundle, verifies its SHA-256, and installs it in place with an atomic rename — safe even while the old binary is running (restart any running `maple start` afterward).

```bash
maple update             # install the latest release
maple update --check     # report current vs. latest without installing
maple update --tag v0.6.0  # install (or downgrade to) a specific release
```

`maple update` and re-running `curl … | sh` fetch the same artifact, so they're interchangeable.

### Uninstall

```bash
curl -fsSL https://maple.dev/cli/uninstall | sh
```

The uninstaller removes the `maple` symlink and the `~/.maple/bin` bundle. Your data dir (`~/.maple/data`) is kept unless you confirm its removal when prompted. It honors the same `MAPLE_INSTALL_DIR` / `MAPLE_BIN_DIR` overrides as the installer.

### Migrating to Homebrew

If you switch from the curl installer to Homebrew, run the uninstaller first (or remove the old PATH symlink) so your shell resolves Homebrew's `maple`.
