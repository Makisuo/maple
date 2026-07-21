# Setting up the GitHub App for the GitHub integration

Maple's GitHub integration is powered by a **GitHub App** that you create and own. When self-hosting Maple, you must register your own GitHub App, give Maple its credentials, and point its webhook and post-installation URLs back at your Maple deployment. Once that's done, your users get the self-serve "Connect GitHub" flow: they install your app on their account or organization, pick repositories, and Maple backfills and live-syncs their commit history.

This guide is exhaustive and prescriptive — follow every step in order.

---

## What you will end up with

- A GitHub App registered under your GitHub account or organization.
- Five values copied into your Maple API environment:
    - `GITHUB_APP_ID`
    - `GITHUB_APP_SLUG`
    - `GITHUB_APP_PRIVATE_KEY`
    - `GITHUB_APP_WEBHOOK_SECRET`
    - (optionally) `GITHUB_API_BASE_URL` for GitHub Enterprise Server
- A working "Connect GitHub" button in **Integrations → GitHub** in your Maple dashboard.

---

## Before you begin: know your public Maple URL

You need the **public base URL where your Maple API is reachable** — the same origin that serves the `/api/...` routes and the dashboard. Throughout this guide it is written as:

```
https://YOUR_MAPLE_DOMAIN
```

Replace **every** occurrence of `https://YOUR_MAPLE_DOMAIN` with your real URL, for example `https://app.example.com`.

Two URLs derive from it, and you will paste both into GitHub later. Note them now:

| Purpose                                                     | URL to use                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| Webhook delivery                                            | `https://YOUR_MAPLE_DOMAIN/api/integrations/github/webhook`  |
| User authorization / post-install redirect ("Callback URL") | `https://YOUR_MAPLE_DOMAIN/api/integrations/github/callback` |

> These paths are fixed in Maple's code. Do not change them — Maple receives webhooks at `/api/integrations/github/webhook` and completes the install flow at `/api/integrations/github/callback`.

---

## Step 1 — Create a new GitHub App

1. Decide who owns the app:
    - **Personal account:** open <https://github.com/settings/apps>
    - **Organization:** open `https://github.com/organizations/YOUR_ORG/settings/apps` (replace `YOUR_ORG`)
2. Click **New GitHub App**. (Direct link for a personal account: <https://github.com/settings/apps/new>.)
3. You are now on the **Register new GitHub App** form. Leave it open and continue with the steps below — they map field-by-field to that form.

---

## Step 2 — Fill in the basic details

| Field               | What to enter                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **GitHub App name** | A unique, human-readable name, e.g. `Maple` or `Maple — example.com`. GitHub requires global uniqueness; if the name is taken, add a suffix. This name also determines your app **slug** (used later). |
| **Homepage URL**    | `https://YOUR_MAPLE_DOMAIN`                                                                                                                                                                            |

---

## Step 3 — Configure user authorization (Callback URL)

This is what closes the loop after a user installs your app, so Maple can record the installation **and prove the installer actually owns it**.

1. Find the **Identifying and authorizing users** section.
2. In **Callback URL**, enter exactly:
    ```
    https://YOUR_MAPLE_DOMAIN/api/integrations/github/callback
    ```
3. Check **Request user authorization (OAuth) during installation**. **Do not skip this — it is a security control, not a convenience.** See the box below.
4. Leave **Expire user authorization tokens** at its default (checked).

> **Why this is required (confused-deputy guard).** `installation_id` values are small, **enumerable** integers and aren't tied to the connect `state`. Without OAuth, anyone who starts a connect flow could submit _someone else's_ `installation_id` and bind another org's private repos to their own Maple org. With OAuth on, GitHub also returns a `code`; Maple exchanges it and calls `GET /user/installations` to confirm the user actually administers that installation before binding it. GitHub delivers `code`, `installation_id`, and `state` to the Callback URL above — there is no separate Setup URL.

---

## Step 4 — Configure the webhook

1. Find the **Webhook** section.
2. Check **Active**.
3. In **Webhook URL**, enter exactly:
    ```
    https://YOUR_MAPLE_DOMAIN/api/integrations/github/webhook
    ```
4. Generate a strong random **Webhook secret** and paste it into the **Secret** field. Generate one with:
    ```bash
    openssl rand -hex 32
    ```
    **Save this value** — you will set it as `GITHUB_APP_WEBHOOK_SECRET` in Step 9. Maple verifies every webhook with an HMAC-SHA256 signature (`X-Hub-Signature-256`) computed from this secret and **rejects deliveries that don't match**, so the value in GitHub and in Maple's environment must be identical.

---

## Step 5 — Set permissions

Maple only **reads** commit, branch, and source-file data. It never writes to your repositories. Read-only source access lets Maple's investigation agent correlate observed failures with the exact deployed revision when telemetry includes repository and commit attributes.

1. Find **Permissions → Repository permissions**.
2. Set the following, leaving every other permission at **No access**:

| Repository permission | Access level                                                |
| --------------------- | ----------------------------------------------------------- |
| **Contents**          | **Read-only**                                               |
| **Pull requests**     | **Read-only** (for the upcoming pull request feature)       |
| **Metadata**          | **Read-only** (GitHub pre-selects this and it is mandatory) |

3. Leave **Organization permissions** and **Account permissions** entirely at **No access**.

---

## Step 6 — Subscribe to webhook events

1. Find the **Subscribe to events** section (directly below permissions). The events listed here depend on the permissions you set in Step 5; if an event is missing, re-check that **Contents** is **Read-only**.
2. Check exactly these events:

| Event to check          | Why Maple needs it                                                            |
| ----------------------- | ----------------------------------------------------------------------------- |
| **Create**              | Branch or tag created — detect newly created branches.                        |
| **Delete**              | Branch or tag deleted — detect deleted branches.                              |
| **Push**                | Live-sync new commits on tracked branches; reconcile force-pushes.            |
| **Pull request**        | Sync pull requests (upcoming pull request feature).                           |
| **Release**             | Sync releases.                                                                |
| **Repository**          | Track repositories being created, renamed, deleted, or changing visibility.   |
| **Meta**                | Notify Maple when the GitHub App itself is deleted.                           |
| **Installation target** | Notify Maple when an installation's target account is renamed or transferred. |

> You do **not** need to (and cannot) subscribe to `installation` or `installation_repositories` here — GitHub always delivers those lifecycle events automatically once the app is installed, and Maple handles them. The `ping` event GitHub sends on setup is accepted as a harmless no-op.

---

## Step 7 — Choose where the app can be installed

Under **Where can this GitHub App be installed?**:

- For a self-serve, multi-tenant Maple deployment where any of your users connect their own GitHub, select **Any account**.
- If Maple is only for your own organization, **Only on this account** is sufficient.

Then click **Create GitHub App** at the bottom of the form.

---

## Step 8 — Collect the App ID, slug, and private key

You are now on your new app's settings page (`https://github.com/settings/apps/<your-slug>`).

### 8a. App ID

Near the top of the **General** tab, find **App ID** (a number, e.g. `123456`). This is your `GITHUB_APP_ID`.

### 8b. App slug

Look at the page URL: `https://github.com/settings/apps/<your-slug>`. The final path segment is your **slug** (a lowercase, hyphenated version of the app name, e.g. `maple-example-com`). This is your `GITHUB_APP_SLUG`.

> Maple builds the install link from this slug: `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`. If the slug is wrong, the "Connect GitHub" button will 404 on GitHub.

### 8c. Client ID and client secret

These are required for the user-authorization (OAuth) confused-deputy guard you enabled in Step 3.

1. On the **General** tab, find **Client ID** (a string like `Iv1.abc123...` or `Iv23li...`). This is your `GITHUB_APP_CLIENT_ID`.
2. Just below it, under **Client secrets**, click **Generate a new client secret**. Copy the generated value immediately — **GitHub shows it only once**. This is your `GITHUB_APP_CLIENT_SECRET`.

### 8d. Private key

1. Scroll to the bottom of the **General** tab to **Private keys**.
2. Click **Generate a private key**. GitHub downloads a `*.pem` file — **this is the only time you can get it**, so store it securely.
3. The file contents (including the `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` lines) are your `GITHUB_APP_PRIVATE_KEY`.

---

## Step 9 — Set the environment variables on your Maple API

Set these on the **Maple API** service (`apps/api`). For local development, put them in your root `.env` file; for a deployed environment, use your secrets manager / platform environment configuration.

```bash
# Required
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=maple-example-com
GITHUB_APP_WEBHOOK_SECRET=<the secret you generated in Step 4>

# Required for the confused-deputy OAuth guard (Step 3 + Step 8c)
GITHUB_APP_CLIENT_ID=Iv23liAbC123...
GITHUB_APP_CLIENT_SECRET=<the client secret you generated in Step 8c>

# Required — the full PEM contents from Step 8d, newlines preserved
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
...rest of the key...
-----END RSA PRIVATE KEY-----"
```

> These are **mandatory**, not optional. The connect flow **fails closed**: when a user connects an installation that isn't already linked to their org, Maple requires the OAuth `code` to prove they administer it. If `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` are missing, or **Request user authorization (OAuth) during installation** (Step 3) is unchecked, GitHub sends no `code`, the ownership check can't run, and the connect is **rejected** — no installation is linked. (A same-org _reconnect_ of an already-linked installation still works without a fresh `code`.)

Notes on the private key:

- **Preserve the line breaks.** The value must be the literal multi-line PEM. In a `.env` file, wrap it in double quotes as shown so the newlines are kept.
- If your secrets platform cannot store multi-line values, paste the PEM with literal `\n` escapes on a single line and ensure your platform un-escapes them — but multi-line is preferred.

### Optional variables

| Variable              | When to set it                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_API_BASE_URL` | Only for **GitHub Enterprise Server**. Set to `https://YOUR_GHE_HOST/api/v3`. Defaults to `https://api.github.com`. |

> Using GitHub Enterprise Server? In addition to `GITHUB_API_BASE_URL`, create the app under your GHE instance (`https://YOUR_GHE_HOST/settings/apps/new`) instead of github.com, and use your GHE host in the homepage/Setup/webhook URLs where appropriate.

After setting the variables, **restart the Maple API** so they take effect. Maple validates `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` lazily — if either is missing, the integration returns a "GitHub App is not configured" error rather than crashing the server.

---

## Step 10 — Verify the setup

1. **Confirm the dashboard sees the app.** Open **Integrations → GitHub** in your Maple dashboard. The **Connect GitHub** button should be active. (If you get "GitHub App is not configured (set `GITHUB_APP_SLUG`)", the slug env var is missing or the API wasn't restarted.)
2. **Run the connect flow.** Click **Connect GitHub**. A popup should open `https://github.com/apps/<your-slug>/installations/new`. Install the app on a test account and pick at least one repository.
3. **Confirm the callback completes.** After installing — and authorizing when GitHub prompts — the popup should close and the card should flip to **Connected**, then move repositories from **Queued → Syncing → Synced**. If it doesn't, your **Callback URL** (Step 3) is the first thing to recheck.
4. **Confirm webhooks are signed correctly.** In your app's settings, open the **Advanced** tab → **Recent Deliveries**. The initial `ping` and the install events should show a **`200`** response. A non-`200` here means the webhook URL is wrong or the **webhook secret in GitHub doesn't match `GITHUB_APP_WEBHOOK_SECRET`**.
5. **Confirm live sync.** Push a commit to a tracked branch in the test repository, then check **Recent Deliveries** for a `push` event returning `200`, and confirm the commit appears in Maple.

---

## Reference

### Environment variables

| Variable                    | Required | Default                  | Description                                                                        |
| --------------------------- | -------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`             | Yes      | —                        | Numeric App ID from the app's General settings.                                    |
| `GITHUB_APP_SLUG`           | Yes      | —                        | URL slug of the app; used to build the install link.                               |
| `GITHUB_APP_PRIVATE_KEY`    | Yes      | —                        | Full PEM private key; used to mint app JWTs (RS256) and installation tokens.       |
| `GITHUB_APP_WEBHOOK_SECRET` | Yes      | —                        | Shared secret for HMAC-SHA256 verification of incoming webhooks.                   |
| `GITHUB_APP_CLIENT_ID`      | Yes      | —                        | OAuth client ID; used by the confused-deputy guard to exchange the install `code`. |
| `GITHUB_APP_CLIENT_SECRET`  | Yes      | —                        | OAuth client secret; paired with the client ID for the `code` exchange.            |
| `GITHUB_API_BASE_URL`       | No       | `https://api.github.com` | Override for GitHub Enterprise Server (`https://HOST/api/v3`).                     |

### Fixed URLs (set these in GitHub)

| GitHub App field                                       | Value                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| Webhook URL                                            | `https://YOUR_MAPLE_DOMAIN/api/integrations/github/webhook`  |
| Callback URL                                           | `https://YOUR_MAPLE_DOMAIN/api/integrations/github/callback` |
| Request user authorization (OAuth) during installation | **Enabled** (confused-deputy guard)                          |

### Permissions

| Permission                 | Access                |
| -------------------------- | --------------------- |
| Repository → Contents      | Read-only             |
| Repository → Pull requests | Read-only             |
| Repository → Metadata      | Read-only (mandatory) |

### Subscribed webhook events

`Create`, `Delete`, `Push`, `Pull request`, `Release`, `Repository`, `Meta`, `Installation target`. (`installation` and `installation_repositories` are delivered automatically and need no subscription.)

---

## Troubleshooting

- **"GitHub App is not configured" in the dashboard.** A required env var (`GITHUB_APP_SLUG`, `GITHUB_APP_ID`, or `GITHUB_APP_PRIVATE_KEY`) is missing, or the API wasn't restarted after setting it.
- **Install succeeds on GitHub but never connects in Maple.** The **Callback URL** is missing/incorrect, or **Request user authorization (OAuth) during installation** is unchecked (or `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` are unset). The flow fails closed: with no OAuth `code`, Maple rejects a new installation binding with "Could not verify you own this GitHub installation." Fix Step 3 / Step 8c and reinstall.
- **Webhook deliveries return `401`/signature errors.** The webhook secret in GitHub does not match `GITHUB_APP_WEBHOOK_SECRET`. Regenerate, paste it into both places, and restart the API.
- **Webhook deliveries return `404`.** The Webhook URL is wrong, or your Maple API isn't publicly reachable at `https://YOUR_MAPLE_DOMAIN`.
- **`Connect GitHub` opens a GitHub 404.** `GITHUB_APP_SLUG` does not match the app's real slug (the last path segment of `https://github.com/settings/apps/<slug>`).
- **Private key errors when minting tokens.** The PEM was truncated or had its newlines stripped. Re-paste the full key, including the BEGIN/END lines, preserving line breaks.

For the end-user-facing description of what the integration does once configured, see [the GitHub integration doc](../apps/landing/src/content/docs/integrations/github.md).
