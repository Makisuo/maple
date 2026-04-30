package internal

import (
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
)

func TestFormatTimestampNano(t *testing.T) {
	cases := []struct {
		name     string
		nanos    uint64
		expected string
	}{
		{"zero", 0, "1970-01-01 00:00:00.000000000"},
		{"epoch_one_ns", 1, "1970-01-01 00:00:00.000000001"},
		{"epoch_one_sec", 1_000_000_000, "1970-01-01 00:00:01.000000000"},
		{"specific_moment", 1_704_067_200_123_456_789, "2024-01-01 00:00:00.123456789"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := FormatTimestampNano(tc.nanos)
			if got != tc.expected {
				t.Fatalf("FormatTimestampNano(%d) = %q, want %q", tc.nanos, got, tc.expected)
			}
		})
	}
}

func TestFormatDateTime(t *testing.T) {
	// FormatDateTime drops sub-second precision — Maple's `Timestamp DateTime`
	// columns are second-resolution. Verify nanoseconds get truncated, not
	// rounded.
	cases := []struct {
		name     string
		nanos    uint64
		expected string
	}{
		{"zero", 0, "1970-01-01 00:00:00"},
		{"end_of_year", 1_704_067_199_999_999_999, "2023-12-31 23:59:59"},
		{"start_of_year", 1_704_067_200_000_000_000, "2024-01-01 00:00:00"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := FormatDateTime(tc.nanos)
			if got != tc.expected {
				t.Fatalf("FormatDateTime(%d) = %q, want %q", tc.nanos, got, tc.expected)
			}
		})
	}
}

func TestSpanKindString(t *testing.T) {
	cases := []struct {
		kind     int32
		expected string
	}{
		{0, "Unspecified"},
		{1, "Internal"},
		{2, "Server"},
		{3, "Client"},
		{4, "Producer"},
		{5, "Consumer"},
		{99, "Unspecified"}, // unknown falls back
	}
	for _, tc := range cases {
		got := SpanKindString(tc.kind)
		if got != tc.expected {
			t.Errorf("SpanKindString(%d) = %q, want %q", tc.kind, got, tc.expected)
		}
	}
}

func TestStatusCodeString(t *testing.T) {
	cases := []struct {
		code     int32
		expected string
	}{
		{0, "Unset"},
		{1, "Ok"},
		{2, "Error"},
		{42, "Unset"}, // unknown falls back
	}
	for _, tc := range cases {
		got := StatusCodeString(tc.code)
		if got != tc.expected {
			t.Errorf("StatusCodeString(%d) = %q, want %q", tc.code, got, tc.expected)
		}
	}
}

func TestSeverityNumberToText(t *testing.T) {
	// OTel severity bands per the spec: 1-4=TRACE, 5-8=DEBUG, 9-12=INFO,
	// 13-16=WARN, 17-20=ERROR, 21-24=FATAL.
	cases := []struct {
		n        int32
		expected string
	}{
		{1, "TRACE"},
		{4, "TRACE"},
		{5, "DEBUG"},
		{8, "DEBUG"},
		{9, "INFO"},
		{12, "INFO"},
		{13, "WARN"},
		{16, "WARN"},
		{17, "ERROR"},
		{20, "ERROR"},
		{21, "FATAL"},
		{24, "FATAL"},
		{0, "0"}, // out-of-band → numeric form
		{25, "25"},
	}
	for _, tc := range cases {
		got := SeverityNumberToText(tc.n)
		if got != tc.expected {
			t.Errorf("SeverityNumberToText(%d) = %q, want %q", tc.n, got, tc.expected)
		}
	}
}

func TestBytesHex(t *testing.T) {
	cases := []struct {
		name     string
		input    []byte
		expected string
	}{
		{"empty", nil, ""},
		{"empty_slice", []byte{}, ""},
		{"all_zero_8_bytes", []byte{0, 0, 0, 0, 0, 0, 0, 0}, ""},
		{"all_zero_16_bytes", make([]byte, 16), ""},
		{"single_byte_low", []byte{0x0a}, "0a"},
		{"single_byte_high", []byte{0xff}, "ff"},
		{"multi_byte", []byte{0xde, 0xad, 0xbe, 0xef}, "deadbeef"},
		{"trace_id_16", []byte{0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}, "0123456789abcdef0123456789abcdef"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := BytesHex(tc.input)
			if got != tc.expected {
				t.Fatalf("BytesHex(%x) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestAttrMap(t *testing.T) {
	// All pcommon.Value types should stringify; the map keeps insertion
	// semantics but Go json.Marshal sorts keys alphabetically anyway, so
	// downstream output is stable.
	m := pcommon.NewMap()
	m.PutStr("string_key", "hello")
	m.PutInt("int_key", 42)
	m.PutDouble("double_key", 3.14)
	m.PutBool("bool_key", true)
	m.PutEmpty("null_key")

	out := AttrMap(m)
	expected := map[string]string{
		"string_key": "hello",
		"int_key":    "42",
		"double_key": "3.14",
		"bool_key":   "true",
		"null_key":   "",
	}
	if len(out) != len(expected) {
		t.Fatalf("got %d entries, want %d", len(out), len(expected))
	}
	for k, want := range expected {
		if got, ok := out[k]; !ok {
			t.Errorf("key %q missing", k)
		} else if got != want {
			t.Errorf("key %q = %q, want %q", k, got, want)
		}
	}
}

func TestResolveOrgID(t *testing.T) {
	t.Run("default_mode_config_wins_even_if_resource_set", func(t *testing.T) {
		// In default mode (resourceAttribute == ""), config wins even if the
		// resource has the legacy attribute set. This is the new behavior:
		// no per-record stamping unless explicitly opted-in.
		r := pcommon.NewMap()
		r.PutStr(MapleOrgIDAttribute, "org_resource")
		got := ResolveOrgID(r, "org_config", "")
		if got != "org_config" {
			t.Fatalf("got %q, want org_config (config-wins default)", got)
		}
	})
	t.Run("default_mode_no_resource", func(t *testing.T) {
		r := pcommon.NewMap()
		got := ResolveOrgID(r, "org_config", "")
		if got != "org_config" {
			t.Fatalf("got %q, want org_config", got)
		}
	})
	t.Run("opt_in_mode_resource_wins", func(t *testing.T) {
		r := pcommon.NewMap()
		r.PutStr(MapleOrgIDAttribute, "org_resource")
		got := ResolveOrgID(r, "org_config", MapleOrgIDAttribute)
		if got != "org_resource" {
			t.Fatalf("got %q, want org_resource", got)
		}
	})
	t.Run("opt_in_mode_missing_attr_falls_back", func(t *testing.T) {
		r := pcommon.NewMap()
		got := ResolveOrgID(r, "org_config", MapleOrgIDAttribute)
		if got != "org_config" {
			t.Fatalf("got %q, want org_config", got)
		}
	})
	t.Run("opt_in_mode_empty_attr_falls_back", func(t *testing.T) {
		r := pcommon.NewMap()
		r.PutStr(MapleOrgIDAttribute, "")
		got := ResolveOrgID(r, "org_config", MapleOrgIDAttribute)
		if got != "org_config" {
			t.Fatalf("got %q, want org_config", got)
		}
	})
	t.Run("opt_in_mode_custom_attribute_name", func(t *testing.T) {
		// Customers can use any attribute name they want, not just the
		// historical `maple_org_id`.
		r := pcommon.NewMap()
		r.PutStr("tenant.id", "tenant_42")
		got := ResolveOrgID(r, "org_config", "tenant.id")
		if got != "tenant_42" {
			t.Fatalf("got %q, want tenant_42", got)
		}
	})
}

func TestServiceName(t *testing.T) {
	t.Run("present", func(t *testing.T) {
		r := pcommon.NewMap()
		r.PutStr("service.name", "checkout-api")
		if got := ServiceName(r); got != "checkout-api" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("missing", func(t *testing.T) {
		r := pcommon.NewMap()
		if got := ServiceName(r); got != "" {
			t.Fatalf("got %q, want empty", got)
		}
	})
}
