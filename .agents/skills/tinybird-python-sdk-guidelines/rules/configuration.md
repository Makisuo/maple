# SDK Configuration

## Configuration File

Create a configuration file in your project root. Supported formats (in priority order):

1. `tinybird.config.py` - Python config with dynamic logic
2. `tinybird_config.py` - Python config alias
3. `tinybird.config.json` - Standard JSON (default)
4. `tinybird.json` - Legacy format

## JSON Configuration

```json
{
  "include": [
    "lib/*.py",
    "tinybird/**/*.datasource",
    "tinybird/**/*.pipe",
    "tinybird/**/*.connection"
  ],
  "token": "${TINYBIRD_TOKEN}",
  "base_url": "https://api.tinybird.co",
  "dev_mode": "branch"
}
```

## Python Configuration

```python
# tinybird.config.py
config = {
    "include": ["lib/*.py"],
    "token": "${TINYBIRD_TOKEN}",
    "base_url": "https://api.tinybird.co",
    "dev_mode": "branch",
}
```

For Python configs, export one of:
- `config` dict
- `CONFIG` dict
- `default` dict
- `get_config()` returning a dict

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `include` | `list[str]` | *required* | File paths or glob patterns for Python and raw datafiles |
| `token` | `str` | *required* | API token; supports `${ENV_VAR}` interpolation |
| `base_url` | `str` | `"https://api.tinybird.co"` | Tinybird API URL |
| `dev_mode` | `"branch"` \| `"local"` | `"branch"` | Development mode |

## Token Resolution

If `token` is omitted, SDK resolves from:
1. `TINYBIRD_TOKEN` environment variable
2. `.tinyb` file

## Base URL Resolution

If `base_url` is omitted, SDK resolves from:
1. `TINYBIRD_URL` environment variable
2. `TINYBIRD_HOST` environment variable
3. `.tinyb` file (`host` field)
4. Default: `https://api.tinybird.co`

## Mixed Formats

Combine Python files with legacy `.datasource`, `.pipe`, and `.connection` files:

```json
{
  "include": [
    "lib/datasources.py",
    "lib/pipes.py",
    "legacy/events.datasource",
    "legacy/analytics.pipe"
  ]
}
```

## Local Development Mode

Use a local Tinybird container:

1. Start the container:
   ```bash
   docker run -d -p 7181:7181 --name tinybird-local tinybirdco/tinybird-local:latest
   ```

2. Configure your project:
   ```json
   {
     "dev_mode": "local"
   }
   ```

   Or use CLI flag:
   ```bash
   tinybird dev --local
   ```
