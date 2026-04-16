---
name: clickhousectl-local-dev
description: Use when a user wants to build an application with ClickHouse, set up a local ClickHouse development environment, install ClickHouse, create a local server, create tables, or start developing with ClickHouse. Covers the full flow from zero to a working local ClickHouse setup.
license: Apache-2.0
metadata:
  author: ClickHouse Inc
  version: "0.1.0"
---

# Local ClickHouse Development Setup

This skill walks through setting up a complete local ClickHouse development environment using `clickhousectl`. Follow these steps in order.

## When to Apply

Use this skill when the user wants to:
- Build an application that needs an analytical database or ClickHouse specifically
- Set up a local ClickHouse instance for development
- Install ClickHouse on their machine
- Create tables and start querying ClickHouse locally
- Prototype or experiment with ClickHouse

---

## Step 1: Install clickhousectl

Check if `clickhousectl` is already available:

```bash
which clickhousectl
```

If not found, install it:

```bash
curl -fsSL https://clickhouse.com/cli | sh
```

This installs `clickhousectl` to `~/.local/bin/clickhousectl` and creates a `chctl` alias.

**If the command is still not found after install:** The user may need to add `~/.local/bin` to their PATH or open a new terminal session. Suggest:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

---

## Step 2: Install ClickHouse

Install the latest stable ClickHouse version:

```bash
clickhousectl local install stable
```

This downloads the ClickHouse binary to `~/.clickhouse/versions/`. The binary is shared across projects so it only needs to be downloaded once.

**Alternative version specifiers** (use if the user has a specific need):
- `lts` — latest long-term support release
- `25.12` — latest patch of a specific minor version
- `25.12.5.44` — exact version

Set the installed version as the default:

```bash
clickhousectl local use stable
```

---

## Step 3: Initialize the project

From the user's project root directory:

```bash
clickhousectl local init
```

This creates a standard folder structure:

```
clickhouse/
  tables/                 # CREATE TABLE statements
  materialized_views/     # Materialized view definitions
  queries/                # Saved queries
  seed/                   # Seed data / INSERT statements
```

**Note:** This step is optional. If the user already has their own folder structure for SQL files, skip this and adapt the later steps to use their paths.

---

## Step 4: Start a local server

```bash
clickhousectl local server start --name <name>
```

This starts a ClickHouse server in the background. Server data is stored in `.clickhouse/servers/<anem>/data/` within the project directory.

**To check running servers and see their exposed ports:**

```bash
clickhousectl local server list
```

---

## Step 5: Create the schema

Based on the user's application requirements, write CREATE TABLE SQL files.

**Write each table definition to its own file** in `clickhouse/tables/`:

```bash
# Example: clickhouse/tables/events.sql
```

```sql
CREATE TABLE IF NOT EXISTS events (
    timestamp DateTime,
    user_id UInt32,
    event_type LowCardinality(String),
    properties String
)
ENGINE = MergeTree()
ORDER BY (event_type, timestamp)
```

When designing schemas, if the `clickhouse-best-practices` skill is available, consult it for guidance on ORDER BY column selection, data types, and partitioning.

**Apply the schema to the running server:**

```bash
clickhousectl local client --name <name> --queries-file clickhouse/tables/events.sql
```

---

## Step 6: Seed data (optional)

If the user needs sample data for development, write INSERT statements to `clickhouse/seed/`:

```bash
# Example: clickhouse/seed/events.sql
```

```sql
INSERT INTO events (timestamp, user_id, event_type, properties) VALUES
    ('2024-01-01 00:00:00', 1, 'page_view', '{"page": "/home"}'),
    ('2024-01-01 00:01:00', 2, 'click', '{"button": "signup"}');
```

**Apply seed data:**

```bash
clickhousectl local client --name <name> --queries-file clickhouse/seed/events.sql
```

---

## Step 7: Verify the setup

Confirm tables were created:

```bash
clickhousectl local client --name <name> --query "SHOW TABLES"
```

Run a test query:

```bash
clickhousectl local client --name <name> --query "SELECT count() FROM events"
```

---

If the user wants to use a managed ClickHouse service, use the `clickhousectl-cloud-deploy` skill to help the user deploy to ClickHouse Cloud.
