# SDK CLI Commands

The SDK installs `tinybird` as a runtime dependency. Some commands are handled by the SDK; others delegate to the Tinybird CLI.

## CLI 4.0 Build/Deploy Model

- Configure your default development target once in `tinybird.config.*` (`dev_mode`).
- Run `tinybird build` without environment flags for normal workflows.
- Run `tinybird deploy` to publish to Tinybird Cloud main.
- Use `--local`/`--branch` only as explicit overrides.

## tinybird init

Initialize a new Tinybird project:

```bash
tinybird init
tinybird init --force          # Overwrite existing files
tinybird init --skip-login     # Skip browser authentication
```

Creates `lib/datasources.py`, `lib/pipes.py`, `lib/client.py`, and `tinybird.config.json`.

## tinybird migrate

Migrate legacy datafiles to Python definitions:

```bash
tinybird migrate "tinybird/**/*.datasource" "tinybird/**/*.pipe" "tinybird/**/*.connection"
tinybird migrate tinybird/legacy --out ./tinybird.migration.py
tinybird migrate tinybird --dry-run
```

Converts `.datasource`, `.pipe`, and `.connection` files into a Python definitions file.

## tinybird dev

Watch schema files and auto-sync to Tinybird:

```bash
tinybird dev                   # Watch and sync using configured dev_mode
tinybird dev --local           # Sync with local container
tinybird dev --branch          # Force branch mode for this run
```

**Important**: In branch mode, feature branches are expected; main/master are blocked to prevent accidental production changes.

## tinybird build

Build and validate resources using your configured development target:

```bash
tinybird build                 # Build to dev_mode target (branch or local)
tinybird build --dry-run       # Preview build operations
tinybird build --local         # Build to local container
tinybird build --branch        # Build to branch for this run
```

Use `tinybird build` for iterative development; it does not publish to production.

## tinybird deploy

Deploy resources to the main workspace (production):

```bash
tinybird deploy                # Deploy to main/production
tinybird deploy --dry-run      # Preview without deploying
tinybird deploy --check        # Validate without deploying
tinybird deploy --wait         # Wait for deployment completion
tinybird deploy --allow-destructive-operations  # Allow breaking changes
```

This is the only way to deploy to main.

## tinybird preview

Create or refresh a CI preview environment for the current branch:

```bash
tinybird preview
```

Use this in pull request workflows so preview apps query isolated Tinybird preview branches.

## tinybird pull

Pull resources from remote workspace:

```bash
tinybird pull                  # Pull to default location
tinybird pull --output-dir ./tinybird-datafiles
tinybird pull --force          # Overwrite existing files
```

## tinybird login

Authenticate via browser:

```bash
tinybird login
```

Useful for existing projects or token refresh.

## tinybird branch

Manage branches:

```bash
tinybird branch list           # List all branches
tinybird branch status         # Show current branch status
tinybird branch delete <name>  # Delete a branch
```

## tinybird info

Display workspace, local, and project configuration:

```bash
tinybird info                  # Show configuration
tinybird info --json           # Output as JSON
```

## Development Workflow

1. `tinybird init` - Initialize project
2. Define datasources and pipes in Python
3. `tinybird build` or `tinybird dev` - Iterate against configured dev target
4. `tinybird preview` in CI - Create preview branch environment per PR
5. `tinybird deploy` - Deploy to production after merge

## Migration Workflow

1. `tinybird migrate "path/to/*.datasource" "path/to/*.pipe"` - Convert legacy files
2. Review generated Python file
3. Move definitions to `lib/datasources.py` and `lib/pipes.py`
4. Update `tinybird.config.json` to include Python files
5. `tinybird dev` - Verify sync works

## Important Notes

- The CLI auto-generates datafiles from Python definitions before `build`, `deploy`, and `preview`
- Use `--check`/`--dry-run` before production deploys when in doubt
- The CLI automatically loads `.env.local` and `.env` files
