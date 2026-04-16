# Defining Datasources

## Basic Datasource Definition

```python
from tinybird_sdk import define_datasource, t, engine

page_views = define_datasource(
    "page_views",
    {
        "description": "Page view tracking data",
        "schema": {
            "timestamp": t.date_time(),
            "pathname": t.string(),
            "session_id": t.string(),
            "country": t.string().low_cardinality().nullable(),
        },
        "engine": engine.merge_tree(
            {
                "sorting_key": ["pathname", "timestamp"],
            }
        ),
    },
)
```

## Schema Types

The `t` object provides type definitions:

### String Types
- `t.string()` - Variable-length string
- `t.fixed_string(n)` - Fixed-length string
- `t.uuid()` - UUID type

### Numeric Types
- `t.int32()`, `t.int64()` - Signed integers
- `t.uint32()`, `t.uint64()` - Unsigned integers
- `t.float32()`, `t.float64()` - Floating point
- `t.decimal(precision, scale)` - Decimal type

### Date/Time Types
- `t.date_time()` - DateTime type
- `t.date_time64(precision)` - DateTime64 with precision (0-9)
- `t.date()` - Date type

### Other Types
- `t.bool()` - Boolean type (stored as UInt8)
- `t.array(inner_type)` - Array of any type
- `t.map(key_type, value_type)` - Map/dictionary type

### Aggregate Types
- `t.simple_aggregate_function(func, inner_type)` - For summing merge tree
- `t.aggregate_function(func, inner_type)` - For aggregating merge tree

## Type Modifiers

Chain modifiers on types:

- `.nullable()` - Make column nullable
- `.low_cardinality()` - Use LowCardinality encoding for low-unique strings
- `.default(value)` - Set default value

Example:
```python
schema = {
    "tags": t.array(t.string()),
    "country": t.string().low_cardinality().nullable(),
    "score": t.float64().nullable(),
    "status": t.string().default("pending"),
}
```

## Engine Configuration

### MergeTree
```python
engine.merge_tree(
    {
        "sorting_key": ["column1", "column2"],
        "partition_key": "toYYYYMM(timestamp)",  # optional
        "ttl": "timestamp + INTERVAL 90 DAY",   # optional
    }
)
```

### ReplacingMergeTree
```python
engine.replacing_merge_tree(
    {
        "sorting_key": ["id"],
        "ver": "updated_at",
    }
)
```

### SummingMergeTree
```python
engine.summing_merge_tree(
    {
        "sorting_key": ["date", "category"],
        "columns": ["count", "total"],
    }
)
```

### AggregatingMergeTree
```python
engine.aggregating_merge_tree(
    {
        "sorting_key": ["date", "dimension"],
    }
)
```

## Schema Inference

Use the `infer` module to extract schemas:

```python
from tinybird_sdk.infer import infer_row_schema

row_schema = infer_row_schema(page_views)
# Returns dict with column names and types
```
