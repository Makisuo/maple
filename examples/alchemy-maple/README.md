# alchemy-maple example

Declares Maple resources (a Slack alert destination, two alert rules, a dashboard, a scoped API key, and the org ingest keys) as infrastructure-as-code via [`@maple-dev/alchemy`](../../lib/alchemy-maple).

```bash
# one-time: build the provider package
bun run --cwd ../../lib/alchemy-maple build

# deploy (needs an org-admin maple_ak_… key; MAPLE_API_URL to target non-prod)
MAPLE_API_KEY=maple_ak_… SLACK_WEBHOOK_URL=https://hooks.slack.com/… bun alchemy deploy

# tear down
MAPLE_API_KEY=maple_ak_… bun alchemy destroy
```
