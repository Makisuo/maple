---
name: clickhousectl-cloud-deploy
description: Use when a user wants to deploy ClickHouse to the cloud, go to production, use ClickHouse Cloud, host a managed ClickHouse service, or migrate from a local ClickHouse setup to ClickHouse Cloud.
license: Apache-2.0
metadata:
  author: ClickHouse Inc
  version: "0.1.0"
---

# Deploy to ClickHouse Cloud

This skill walks through deploying to ClickHouse Cloud using `clickhousectl`. It covers account setup, CLI authentication, service creation, schema migration, and connecting your application. Follow these steps in order.

## When to Apply

Use this skill when the user wants to:
- Deploy their ClickHouse application to production
- Host ClickHouse as a managed cloud service
- Migrate from a local ClickHouse setup to ClickHouse Cloud
- Create a ClickHouse Cloud service
- Set up ClickHouse Cloud for the first time

---

## Step 1: Sign up for ClickHouse Cloud

Before using any cloud commands, the user needs a ClickHouse Cloud account.

**Ask the user:** "Do you already have a ClickHouse Cloud account?"

**If they do not have an account**, explain:

> ClickHouse Cloud is a fully managed service that runs ClickHouse for you — no infrastructure to maintain, automatic scaling, backups, and upgrades included. There's a free trial so you can get started without a credit card.
>
> To create an account, go to: **https://clickhouse.cloud**
>
> Sign up with your email, Google, or GitHub account. Once you're in the console, let me know and we'll continue with the next step.

**Wait for the user to confirm** they have signed up or already have an account before proceeding.

---

## Step 2: Authenticate the CLI

First, ensure `clickhousectl` is installed. Check with:

```bash
which clickhousectl
```

If not found, install it:

```bash
curl -fsSL https://clickhouse.com/cli | sh
```

Now authenticate. There are two options — choose based on the situation:

> **Important: OAuth login is read-only.** Browser login (Option A) grants read-only access — you can list organizations, services, and query existing services, but you **cannot** create, modify, or delete services. Any destructive or mutating cloud operation (service creation, deletion, scaling, etc.) **requires API key authentication** (Option B). If this workflow involves creating or changing cloud resources, you must use Option B.

### Option A: Browser login (read-only access)

Use this when a human is available to open a browser and you only need to inspect existing cloud resources (list orgs, list services, query data). It uses OAuth device flow — no API keys needed.

Instruct the user to run:

```bash
clickhousectl cloud login
```

This prints a URL and a code. The user opens the URL in their browser, confirms the code, and logs in with their ClickHouse Cloud account. The CLI automatically receives credentials once the browser flow completes.

This is sufficient for steps that only read data (e.g., `cloud org list`, `cloud service get`, `cloud service client`). For any step that creates or modifies resources, switch to API key auth.

### Option B: API key auth (required for destructive actions)

**Use this option when creating, modifying, or deleting cloud resources** (e.g., `cloud service create`, `cloud service delete`). Also use this for headless/CI environments where no browser is available. Both `--api-key` and `--api-secret` are **required** — if the user provides one without the other, tell them both are needed.

```bash
clickhousectl cloud login --api-key <key> --api-secret <secret>
```

If the user doesn't have API keys yet, guide them to create one:

> In the ClickHouse Cloud console:
> 1. Click the **gear icon** (Settings) in the left sidebar
> 2. Go to **API Keys**
> 3. Click **Create API Key**
> 4. Give it a name (e.g., "cli") and select the **Admin** role
> 5. Click **Generate API Key**
> 6. **Copy both the Key ID and the Key Secret** — the secret is only shown once

---

**To verify authentication works:**

```bash
clickhousectl cloud org list
```

This should return the user's organization.

---

## Step 3: Create a cloud service

> **Requires API key auth.** Service creation is a mutating operation. If you authenticated with browser login (Option A) in Step 2, you must re-authenticate with API key auth (Option B) before proceeding.

Create a new ClickHouse Cloud service:

```bash
clickhousectl cloud service create --name <service-name>
```

**The output includes the service ID and default user password** — note it for subsequent commands.

**Wait for the service to be ready.** After creation, the service takes a moment to provision. Check its status:

```bash
clickhousectl cloud service get <service-id>
```
You can grep the "state" field to see if it is "running".

---

## Step 4: Migrate schemas

If the user has local table definitions (e.g., from using the `clickhousectl-local-dev` skill), migrate them to the cloud service.

Use `cloud service client` to run queries against the cloud service — it looks up the endpoint, port, and TLS settings automatically. You just need the service name (or `--id`) and the password from step 3.

**Read the local schema files** from `clickhouse/tables/` and apply each one to the cloud service:

```bash
clickhousectl cloud service client --name <service-name> \
  --queries-file clickhouse/tables/<table>.sql
```

Apply them in dependency order — tables referenced by materialized views should be created first.

**Also apply materialized views** if they exist:

```bash
clickhousectl cloud service client --name <service-name> \
  --queries-file clickhouse/materialized_views/<view>.sql
```

The `--user` flag defaults to `default`. If the user has a different database user, pass `--user <username>`.

---

## Step 5: Verify the deployment

Connect to the cloud service and confirm tables exist:

```bash
clickhousectl cloud service client --name <service-name> --query "SHOW TABLES"
```

Run a test query to confirm the schema is correct:

```bash
clickhousectl cloud service client --name <service-name> --query "DESCRIBE TABLE <table-name>"
```

---

## Step 6: Update application config

Retrieve the service endpoint for the user's application config:

```bash
clickhousectl cloud service get <service-id>
```

Provide the user with the connection details:

- **Host:** from the service `get` output
- **Port:** `8443` for HTTPS / `9440` for native TLS
- **User:** `default`
- **Password:** the password from step 3 (service creation)
- **SSL/TLS:** required (always enabled on Cloud)

**Example connection strings** (adapt to the user's language/framework):

**Python (clickhouse-connect):**
```python
import clickhouse_connect

client = clickhouse_connect.get_client(
    host='<cloud-host>',
    port=8443,
    username='default',
    password='<password>',
    secure=True
)
```

**Node.js (@clickhouse/client):**
```javascript
import { createClient } from '@clickhouse/client'

const client = createClient({
  url: 'https://<cloud-host>:8443',
  username: 'default',
  password: '<password>',
})
```

**Go (clickhouse-go):**
```go
conn, err := clickhouse.Open(&clickhouse.Options{
    Addr: []string{"<cloud-host>:9440"},
    Auth: clickhouse.Auth{
        Username: "default",
        Password: "<password>",
    },
    TLS: &tls.Config{},
})
```

Suggest the user store the password in an environment variable or secrets manager rather than hardcoding it.

Suggest the user should not use the default user in production. A user should be created just for their app.