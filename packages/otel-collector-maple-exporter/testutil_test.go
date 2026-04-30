package mapleexporter

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// updateGolden controls whether the golden-file assertions overwrite the
// expected fixtures. Run `go test -update` to regenerate after a deliberate
// schema/encoder change. Without the flag, mismatches fail loudly.
var updateGolden = flag.Bool("update", false, "rewrite testdata/golden/* with the test outputs")

// assertGoldenJSONEachRow compares one or more produced JSON-each-row rows
// against `testdata/golden/<name>.jsonl`. Each row is normalized (parsed and
// re-serialized with sorted keys) so map-iteration order or marshaller
// quirks don't trigger false negatives — what we care about is the exact
// set of fields and values per row, not the byte-for-byte layout.
func assertGoldenJSONEachRow(t *testing.T, name string, got [][]byte) {
	t.Helper()

	gotBytes := normalizeRows(t, got)
	path := filepath.Join("testdata", "golden", name+".jsonl")

	if *updateGolden {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir golden dir: %v", err)
		}
		if err := os.WriteFile(path, gotBytes, 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("golden updated: %s", path)
		return
	}

	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden %q (run with -update to create): %v", path, err)
	}

	if !bytes.Equal(gotBytes, want) {
		t.Errorf("golden mismatch for %s\n--- got ---\n%s\n--- want ---\n%s", name, gotBytes, want)
	}
}

// normalizeRows parses each row as JSON and re-marshals with sorted keys so
// golden comparison is independent of map-iteration order. Trailing newline
// is included so the file ends in \n (UNIX convention).
func normalizeRows(t *testing.T, rows [][]byte) []byte {
	t.Helper()
	var out bytes.Buffer
	for i, row := range rows {
		var v any
		if err := json.Unmarshal(row, &v); err != nil {
			t.Fatalf("row %d: invalid json: %v\n%s", i, err, row)
		}
		v = sortRecursively(v)
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("row %d: re-marshal: %v", i, err)
		}
		out.Write(b)
		out.WriteByte('\n')
	}
	return out.Bytes()
}

// sortRecursively walks a json.Unmarshal'd value and replaces every map with
// a wrapper that marshals its keys in sorted order. Necessary because Go's
// `encoding/json` already sorts map keys alphabetically, but `any` containers
// need explicit normalization.
func sortRecursively(v any) any {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		ordered := make(orderedMap, 0, len(keys))
		for _, k := range keys {
			ordered = append(ordered, kv{k, sortRecursively(t[k])})
		}
		return ordered
	case []any:
		for i := range t {
			t[i] = sortRecursively(t[i])
		}
		return t
	default:
		return v
	}
}

type kv struct {
	K string
	V any
}

// orderedMap marshals keys in the order they were inserted.
type orderedMap []kv

func (m orderedMap) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, p := range m {
		if i > 0 {
			buf.WriteByte(',')
		}
		k, err := json.Marshal(p.K)
		if err != nil {
			return nil, err
		}
		buf.Write(k)
		buf.WriteByte(':')
		v, err := json.Marshal(p.V)
		if err != nil {
			return nil, err
		}
		buf.Write(v)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}
