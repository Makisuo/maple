//! CityHash64 as ClickHouse computes it — **CityHash v1.0.2**, not upstream HEAD.
//!
//! `AiSessionKeyHash` is `city_hash64(value)` over the resolved session-key value.
//! This in-crate port is kept **deliberately**, for three reasons:
//!
//! * **Read-path ClickHouse-computability.** ClickHouse vendors
//!   `contrib/cityhash102` — Google's 1.0.2 release, frozen in 2011 — so
//!   `city_hash64(x)` == `SELECT cityHash64(x)` for every byte string. The
//!   plaintext session key stays in `SpanAttributes` on the same row, so
//!   `WHERE AiSessionKeyHash = cityHash64({sessionId})` finds a known session's
//!   spans via the indexed column instead of a map probe, and the column is
//!   verifiable/repairable from `SpanAttributes` in SQL.
//! * **Zero dependencies, zero maintenance.** The algorithm froze in 2011; this
//!   transcription is pinned by ground-truth vectors read out of a live
//!   ClickHouse (26.7.2.59).
//! * **crates.io is the riskier option.** Published CityHash crates track
//!   upstream 1.1+, which changed `CityHash64` (different mixing for len ≤ 32,
//!   different seeding/loop for len > 64). A dependency whose semver can move
//!   under a hash that must never change is a worse fit than a frozen copy.
//!
//! **Stability contract: this hash must never change.** It feeds the
//! `uniqCombined(12)` sketches in the 400-day-TTL `service_ai_vendors_hourly`
//! rollup, so any change — an algorithm swap, a "fix", a crate upgrade — is a
//! silent `SessionsApprox` discontinuity across every org's history, not an
//! error anyone sees.
//!
//! Landmine, kept from the v1 docs: ClickHouse's multi-argument
//! `cityHash64(a, b)` is **not** the hash of a concatenation — it folds
//! per-argument hashes. Only the single-argument form equals this function.

const K0: u64 = 0xc3a5_c85c_97cb_3127;
const K1: u64 = 0xb492_b66f_be98_f273;
const K2: u64 = 0x9ae1_6a3b_2f90_404f;
const K3: u64 = 0xc949_d7c7_509e_6557;

#[inline]
fn fetch64(bytes: &[u8], at: usize) -> u64 {
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(buf)
}

#[inline]
fn fetch32(bytes: &[u8], at: usize) -> u32 {
    let mut buf = [0u8; 4];
    buf.copy_from_slice(&bytes[at..at + 4]);
    u32::from_le_bytes(buf)
}

#[inline]
fn rotate(value: u64, shift: u32) -> u64 {
    if shift == 0 {
        value
    } else {
        value.rotate_right(shift)
    }
}

/// `Rotate` with a shift the caller guarantees is non-zero. 1.0.2 keeps this as a
/// separate function because the branchless form is only valid for shift ≥ 1.
#[inline]
fn rotate_by_at_least_1(value: u64, shift: u32) -> u64 {
    value.rotate_right(shift)
}

#[inline]
fn shift_mix(value: u64) -> u64 {
    value ^ (value >> 47)
}

/// `Hash128to64` — the 128→64 fold shared by every length branch.
#[inline]
fn hash_len16(u: u64, v: u64) -> u64 {
    const MUL: u64 = 0x9ddf_ea08_eb38_2d69;
    let mut a = (u ^ v).wrapping_mul(MUL);
    a ^= a >> 47;
    let mut b = (v ^ a).wrapping_mul(MUL);
    b ^= b >> 47;
    b.wrapping_mul(MUL)
}

fn hash_len0to16(bytes: &[u8]) -> u64 {
    let len = bytes.len();
    if len > 8 {
        let a = fetch64(bytes, 0);
        let b = fetch64(bytes, len - 8);
        return hash_len16(
            a,
            rotate_by_at_least_1(b.wrapping_add(len as u64), len as u32),
        ) ^ b;
    }
    if len >= 4 {
        let a = fetch32(bytes, 0) as u64;
        return hash_len16(
            (len as u64).wrapping_add(a << 3),
            fetch32(bytes, len - 4) as u64,
        );
    }
    if len > 0 {
        let a = bytes[0] as u32;
        let b = bytes[len >> 1] as u32;
        let c = bytes[len - 1] as u32;
        let y = a.wrapping_add(b << 8) as u64;
        let z = (len as u32).wrapping_add(c << 2) as u64;
        return shift_mix(y.wrapping_mul(K2) ^ z.wrapping_mul(K3)).wrapping_mul(K2);
    }
    K2
}

fn hash_len17to32(bytes: &[u8]) -> u64 {
    let len = bytes.len();
    let a = fetch64(bytes, 0).wrapping_mul(K1);
    let b = fetch64(bytes, 8);
    let c = fetch64(bytes, len - 8).wrapping_mul(K2);
    let d = fetch64(bytes, len - 16).wrapping_mul(K0);
    hash_len16(
        rotate(a.wrapping_sub(b), 43)
            .wrapping_add(rotate(c, 30))
            .wrapping_add(d),
        a.wrapping_add(rotate(b ^ K3, 20))
            .wrapping_sub(c)
            .wrapping_add(len as u64),
    )
}

/// Returns a 16-byte hash for 48 bytes: `(a + z, b + c)`.
#[inline]
fn weak_hash_len32_with_seeds_raw(w: u64, x: u64, y: u64, z: u64, a: u64, b: u64) -> (u64, u64) {
    let mut a = a.wrapping_add(w);
    let mut b = rotate(b.wrapping_add(a).wrapping_add(z), 21);
    let c = a;
    a = a.wrapping_add(x);
    a = a.wrapping_add(y);
    b = b.wrapping_add(rotate(a, 44));
    (a.wrapping_add(z), b.wrapping_add(c))
}

#[inline]
fn weak_hash_len32_with_seeds(bytes: &[u8], at: usize, a: u64, b: u64) -> (u64, u64) {
    weak_hash_len32_with_seeds_raw(
        fetch64(bytes, at),
        fetch64(bytes, at + 8),
        fetch64(bytes, at + 16),
        fetch64(bytes, at + 24),
        a,
        b,
    )
}

fn hash_len33to64(bytes: &[u8]) -> u64 {
    let len = bytes.len();
    let mut z = fetch64(bytes, 24);
    let mut a = fetch64(bytes, 0).wrapping_add(
        (len as u64)
            .wrapping_add(fetch64(bytes, len - 16))
            .wrapping_mul(K0),
    );
    let mut b = rotate(a.wrapping_add(z), 52);
    let mut c = rotate(a, 37);
    a = a.wrapping_add(fetch64(bytes, 8));
    c = c.wrapping_add(rotate(a, 7));
    a = a.wrapping_add(fetch64(bytes, 16));
    let vf = a.wrapping_add(z);
    let vs = b.wrapping_add(rotate(a, 31)).wrapping_add(c);

    a = fetch64(bytes, 16).wrapping_add(fetch64(bytes, len - 32));
    z = fetch64(bytes, len - 8);
    b = rotate(a.wrapping_add(z), 52);
    c = rotate(a, 37);
    a = a.wrapping_add(fetch64(bytes, len - 24));
    c = c.wrapping_add(rotate(a, 7));
    a = a.wrapping_add(fetch64(bytes, len - 16));
    let wf = a.wrapping_add(z);
    let ws = b.wrapping_add(rotate(a, 31)).wrapping_add(c);

    let r = shift_mix(
        vf.wrapping_add(ws)
            .wrapping_mul(K2)
            .wrapping_add(wf.wrapping_add(vs).wrapping_mul(K0)),
    );
    shift_mix(r.wrapping_mul(K0).wrapping_add(vs)).wrapping_mul(K2)
}

/// `CityHash64` (v1.0.2). Byte-identical to ClickHouse's single-argument
/// `cityHash64(String)`.
pub fn city_hash64(bytes: &[u8]) -> u64 {
    let total = bytes.len();
    if total <= 32 {
        return if total <= 16 {
            hash_len0to16(bytes)
        } else {
            hash_len17to32(bytes)
        };
    }
    if total <= 64 {
        return hash_len33to64(bytes);
    }

    // For strings over 64 bytes: hash the tail first, then loop over 64-byte
    // chunks keeping 56 bytes of state (v, w, x, y, z).
    let mut x = fetch64(bytes, 0);
    let mut y = fetch64(bytes, total - 16) ^ K1;
    let mut z = fetch64(bytes, total - 56) ^ K0;
    let mut v = weak_hash_len32_with_seeds(bytes, total - 64, total as u64, y);
    let mut w = weak_hash_len32_with_seeds(bytes, total - 32, (total as u64).wrapping_mul(K1), K0);
    z = z.wrapping_add(shift_mix(v.1).wrapping_mul(K1));
    x = rotate(z.wrapping_add(x), 39).wrapping_mul(K1);
    y = rotate(y, 33).wrapping_mul(K1);

    let mut at = 0usize;
    let mut left = (total - 1) & !63usize;
    loop {
        x = rotate(
            x.wrapping_add(y)
                .wrapping_add(v.0)
                .wrapping_add(fetch64(bytes, at + 16)),
            37,
        )
        .wrapping_mul(K1);
        y = rotate(
            y.wrapping_add(v.1).wrapping_add(fetch64(bytes, at + 48)),
            42,
        )
        .wrapping_mul(K1);
        x ^= w.1;
        y ^= v.0;
        z = rotate(z ^ w.0, 33);
        v = weak_hash_len32_with_seeds(bytes, at, v.1.wrapping_mul(K1), x.wrapping_add(w.0));
        w = weak_hash_len32_with_seeds(bytes, at + 32, z.wrapping_add(w.1), y);
        std::mem::swap(&mut z, &mut x);
        at += 64;
        left -= 64;
        if left == 0 {
            break;
        }
    }

    hash_len16(
        hash_len16(v.0, w.0)
            .wrapping_add(shift_mix(y).wrapping_mul(K1))
            .wrapping_add(z),
        hash_len16(v.1, w.1).wrapping_add(x),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ground truth, read out of a live ClickHouse 26.7.2.59 (the repo's
    /// `bun ch:up` container) with
    /// `SELECT toString(cityHash64(unhex('<hex>')))`. One representative pin per
    /// length class of the algorithm — 0, 1..3, 4..8, 9..16, 17..32, 33..64,
    /// and over-64 (an exact 64-byte loop multiple) — so a variant mismatch
    /// (1.1 vs 1.0.2 changed the ≤32 and over-64 branches) or a transcription
    /// regression in any branch trips at least one pin.
    const VECTORS: &[(&str, u64)] = &[
        // empty
        ("", 11160318154034397263u64),
        // 1 byte (the len 1..=3 sub-branch)
        ("62", 4947675599669400333u64),
        // 4 bytes (the len 4..=8 sub-branch)
        ("656c737a", 6980601109885121812u64),
        // 9 bytes (the len 9..=16 sub-branch)
        ("6a7178656c737a676e", 15781391667595025456u64),
        // 17 bytes (hash_len17to32)
        ("7279666d7461686f76636a7178656c737a", 14462083576506790518u64),
        // 33 bytes (hash_len33to64)
        ("686f76636a7178656c737a676e7562697077646b7279666d7461686f76636a7178", 16474122761118675582u64),
        // 128 bytes (the >64 loop, at an exact 64-byte multiple)
        (
            "79666d7461686f76636a7178656c737a676e7562697077646b7279666d7461686f76636a7178656c737a676e7562697077646b7279666d7461686f76636a7178656c737a676e7562697077646b7279666d7461686f76636a7178656c737a676e7562697077646b7279666d7461686f76636a7178656c737a676e756269707764",
            10493324097790847553u64,
        ),
    ];

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
            .collect()
    }

    #[test]
    fn matches_clickhouse_ground_truth() {
        for (hex, expected) in VECTORS {
            let input = unhex(hex);
            assert_eq!(
                city_hash64(&input),
                *expected,
                "cityHash64 mismatch for {} bytes (hex {hex})",
                input.len()
            );
        }
    }

    /// A stable, published CityHash 1.0.2 fact rather than a captured vector:
    /// the empty string hashes to k2, and ClickHouse agrees.
    #[test]
    fn empty_string_is_k2() {
        assert_eq!(city_hash64(b""), K2);
        assert_eq!(K2, 11160318154034397263);
    }

    #[test]
    fn long_inputs_do_not_panic_on_boundaries() {
        for len in 0..600 {
            let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let _ = city_hash64(&data);
        }
    }
}
