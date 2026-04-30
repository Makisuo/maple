package internal

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
)

// MapleOrgIDAttribute is the resource-attribute key Maple's pipeline uses to
// route records to the correct organization. Set by the upstream
// `resource/maple_org` processor.
const MapleOrgIDAttribute = "maple_org_id"

// AttrMap converts a pdata attribute Map into a flat string→string map
// suitable for ClickHouse `Map(LowCardinality(String), String)` columns. Non-
// string values are stringified using OTel's standard convention (numbers as
// decimal strings, bools as "true"/"false", JSON for slices/maps).
func AttrMap(m pcommon.Map) map[string]string {
	out := make(map[string]string, m.Len())
	m.Range(func(k string, v pcommon.Value) bool {
		out[k] = v.AsString()
		return true
	})
	return out
}

// ResolveOrgID returns the org id for a record. Resource attribute wins over
// the static fallback so multi-tenant agents (or cluster-collector
// re-routing) keep working.
func ResolveOrgID(resource pcommon.Map, fallback string) string {
	if v, ok := resource.Get(MapleOrgIDAttribute); ok {
		s := v.AsString()
		if s != "" {
			return s
		}
	}
	return fallback
}

// ServiceName extracts `service.name` from a resource (Maple's `ServiceName`
// column). Empty string when missing — Maple's `LowCardinality(String)`
// column accepts empty.
func ServiceName(resource pcommon.Map) string {
	if v, ok := resource.Get("service.name"); ok {
		return v.AsString()
	}
	return ""
}

// FormatTimestampNano formats a UnixNano integer as the
// "YYYY-MM-DD HH:MM:SS.nnnnnnnnn" string ClickHouse expects for DateTime64(9)
// columns when fed via JSONEachRow with `date_time_input_format=best_effort`.
//
// We emit explicit nanosecond precision and a trailing "Z"-like UTC zone via
// the layout — but ClickHouse parses the no-zone form and stores at the
// configured precision, so we omit the zone to match its native rendering.
func FormatTimestampNano(unixNano uint64) string {
	if unixNano == 0 {
		return "1970-01-01 00:00:00.000000000"
	}
	t := time.Unix(0, int64(unixNano)).UTC()
	return t.Format("2006-01-02 15:04:05.000000000")
}

// FormatDateTime formats a UnixNano integer as the second-precision DateTime
// form used by Maple's `Timestamp DateTime` and `Hour DateTime` columns.
func FormatDateTime(unixNano uint64) string {
	if unixNano == 0 {
		return "1970-01-01 00:00:00"
	}
	return time.Unix(0, int64(unixNano)).UTC().Format("2006-01-02 15:04:05")
}

// SpanKindString returns Maple's expected canonical SpanKind label
// ("Server", "Client", "Producer", "Consumer", "Internal", "Unspecified").
// The pdata SpanKind String() method returns "SPAN_KIND_*"; we strip and
// title-case to match Maple's `LowCardinality(String)` values.
func SpanKindString(kind int32) string {
	switch kind {
	case 1:
		return "Internal"
	case 2:
		return "Server"
	case 3:
		return "Client"
	case 4:
		return "Producer"
	case 5:
		return "Consumer"
	default:
		return "Unspecified"
	}
}

// StatusCodeString returns Maple's "Ok" / "Error" / "Unset" labels. pdata
// uses 0 = Unset, 1 = Ok, 2 = Error.
func StatusCodeString(code int32) string {
	switch code {
	case 1:
		return "Ok"
	case 2:
		return "Error"
	default:
		return "Unset"
	}
}

// SeverityNumberToText returns the canonical OTel severity text for a
// numeric severity (1-24). Falls back to the numeric form for unknown
// values.
func SeverityNumberToText(n int32) string {
	switch {
	case n >= 1 && n <= 4:
		return "TRACE"
	case n >= 5 && n <= 8:
		return "DEBUG"
	case n >= 9 && n <= 12:
		return "INFO"
	case n >= 13 && n <= 16:
		return "WARN"
	case n >= 17 && n <= 20:
		return "ERROR"
	case n >= 21 && n <= 24:
		return "FATAL"
	default:
		return strconv.Itoa(int(n))
	}
}

// BytesHex returns a lowercase hex string for a byte slice. Used for
// TraceId, SpanId, ParentSpanId — Maple stores these as String columns
// containing the hex form (matching otel-collector-contrib's CH exporter
// convention).
//
// IMPORTANT: returns the empty string for nil/empty input AND for all-zero
// input. The all-zero case matters because OTel SDKs emit root spans with
// an all-zero ParentSpanID, and Maple's `trace_list_mv` MV filters
// `WHERE ParentSpanId = ''` — emitting "0000000000000000" would make every
// root span invisible to the UI's trace list. Same convention as
// otel-collector-contrib's CH exporter.
func BytesHex(b []byte) string {
	if len(b) == 0 || isAllZero(b) {
		return ""
	}
	const hex = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, v := range b {
		out[i*2] = hex[v>>4]
		out[i*2+1] = hex[v&0x0f]
	}
	return string(out)
}

func isAllZero(b []byte) bool {
	for _, v := range b {
		if v != 0 {
			return false
		}
	}
	return true
}

// MarshalRow JSON-encodes a row map, returning a single-line JSON document
// with no trailing newline. Wraps the encode error to point at the offending
// table for fast diagnosis.
func MarshalRow(table string, row any) ([]byte, error) {
	b, err := json.Marshal(row)
	if err != nil {
		return nil, fmt.Errorf("marshal %s row: %w", table, err)
	}
	return b, nil
}
