# chdb DataStore

Agent skill for using chdb's pandas-compatible DataStore API — a drop-in pandas replacement backed by ClickHouse.

## Installation

```bash
npx skills add clickhouse/agent-skills
```

## What's Included

| File | Purpose |
|------|---------|
| `SKILL.md` | Skill definition and quick-start guide |
| `references/api-reference.md` | Full DataStore method signatures |
| `references/connectors.md` | All 16+ data source connection methods |
| `examples/examples.md` | 11 runnable examples with expected output |
| `scripts/verify_install.py` | Environment verification script |

## Trigger Phrases

This skill activates when you:
- "Analyze this file with pandas"
- "Speed up my pandas code"
- "Query this MySQL/PostgreSQL/S3 table as a DataFrame"
- "Join data from different sources"
- "Use DataStore to..."
- "Import datastore as pd"

## Related

- **chdb-sql** — For raw ClickHouse SQL queries, use the `chdb-sql` skill instead
- **clickhouse-best-practices** — For ClickHouse schema/query optimization

## Documentation

- [chdb docs](https://clickhouse.com/docs/chdb)
- [chdb GitHub](https://github.com/chdb-io/chdb)
