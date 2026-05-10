//! Shared body construction for destination writers.
//!
//! Both ClickHouse (`?query=INSERT...FORMAT JSONEachRow`) and Tinybird
//! (`/v0/events?name=...`) accept gzip-compressed newline-delimited JSON with
//! the exact same per-row shape — only the URL and auth headers differ. So
//! the body builder lives here and is shared by every `Writer` impl.

use std::io::Write;

use flate2::write::GzEncoder;
use flate2::Compression;

/// gzip(rows[0] + "\n" + rows[1] + ... + rows[N-1]).
///
/// No trailing newline. Empty input returns an `Err` (callers MUST short-
/// circuit before calling — both CH and Tinybird treat an empty body as a
/// client error and we don't want to send those round-trips).
pub fn encode_gzip_ndjson(rows: &[Vec<u8>]) -> std::io::Result<Vec<u8>> {
    debug_assert!(!rows.is_empty(), "encode_gzip_ndjson called with no rows");
    let raw_estimate: usize = rows.iter().map(|r| r.len()).sum::<usize>() + rows.len();
    let mut buf = Vec::with_capacity(raw_estimate);
    let mut gz = GzEncoder::new(&mut buf, Compression::default());
    for (i, row) in rows.iter().enumerate() {
        if i > 0 {
            gz.write_all(b"\n")?;
        }
        gz.write_all(row)?;
    }
    gz.finish()?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;

    fn gunzip(b: &[u8]) -> String {
        let mut out = String::new();
        GzDecoder::new(b).read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn round_trips_multiple_rows() {
        let rows = vec![b"{\"a\":1}".to_vec(), b"{\"b\":2}".to_vec()];
        let got = encode_gzip_ndjson(&rows).unwrap();
        assert_eq!(gunzip(&got), "{\"a\":1}\n{\"b\":2}");
    }

    #[test]
    fn no_trailing_newline_for_single_row() {
        let rows = vec![b"{\"a\":1}".to_vec()];
        let got = encode_gzip_ndjson(&rows).unwrap();
        assert_eq!(gunzip(&got), "{\"a\":1}");
    }
}
