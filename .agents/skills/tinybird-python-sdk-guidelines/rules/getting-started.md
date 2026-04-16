# Tinybird Python SDK Overview

## What is it

The `tinybird-sdk` is a Python package that enables developers to define Tinybird resources in Python. You can author datasources, pipes, connections, and queries in Python, then synchronize them directly to Tinybird.

## Requirements

- Python: Version 3.11 or higher
- Server-side only; web browsers are not supported to protect API credentials

## Installation

```bash
pip install tinybird-sdk
```

## Project Initialization

```bash
tinybird init
tinybird init --force          # Overwrite existing files
tinybird init --skip-login     # Skip browser authentication
```

This generates:
- `tinybird.config.json` - Configuration file
- `lib/datasources.py` - Data source definitions
- `lib/pipes.py` - Pipe/endpoint definitions
- `lib/client.py` - Tinybird client module

## Environment Setup

Create `.env.local`:
```
TINYBIRD_TOKEN=p.your_token_here
```

## Key Features

- Define datasources, pipes, and endpoints in Python
- Data ingestion with automatic schema validation
- Query endpoints with typed results
- Mixed formats: combine Python with legacy `.datasource`/`.pipe` files
- Branch safety: dev mode blocks deployment to main branch
- Connections: Kafka, S3, GCS integrations
- Materialized views for real-time aggregations
- Copy pipes and sink pipes for data workflows
