#!/usr/bin/env python3
"""Verify chdb SQL installation and basic functionality."""

import sys

PASS = "OK"
FAIL = "FAIL"
results = []


def check(name, fn):
    try:
        fn()
        results.append((name, PASS, ""))
        print(f"  [{PASS}] {name}")
    except Exception as e:
        results.append((name, FAIL, str(e)))
        print(f"  [{FAIL}] {name}: {e}")


def check_python_version():
    if sys.version_info < (3, 9):
        raise RuntimeError(f"Python 3.9+ required, got {sys.version}")


def check_chdb_import():
    import chdb
    if not hasattr(chdb, "__version__"):
        raise RuntimeError("chdb imported but missing __version__")
    print(f"         chdb version: {chdb.__version__}")


def check_basic_query():
    import chdb
    result = chdb.query("SELECT 1 + 1 AS answer")
    data = result.data()
    if "2" not in data:
        raise RuntimeError(f"Expected '2' in output, got: {data!r}")


def check_dataframe_output():
    import chdb
    df = chdb.query("SELECT number FROM numbers(5)", "DataFrame")
    if len(df) != 5:
        raise RuntimeError(f"Expected 5 rows, got {len(df)}")
    if "number" not in df.columns:
        raise RuntimeError(f"Expected 'number' column, got {list(df.columns)}")


def check_session():
    from chdb import session as chs
    sess = chs.Session()
    try:
        sess.query("CREATE TABLE _verify_test (id UInt64) ENGINE = Memory")
        sess.query("INSERT INTO _verify_test VALUES (1), (2), (3)")
        result = sess.query("SELECT count() AS cnt FROM _verify_test")
        data = result.data()
        if "3" not in data:
            raise RuntimeError(f"Expected '3' in output, got: {data!r}")
    finally:
        sess.close()


def check_parametrized():
    import chdb
    result = chdb.query(
        "SELECT {x:UInt64} + {y:UInt64} AS sum",
        params={"x": 10, "y": 20})
    data = result.data()
    if "30" not in data:
        raise RuntimeError(f"Expected '30' in output, got: {data!r}")


if __name__ == "__main__":
    print("chdb SQL Installation Verification")
    print("=" * 40)

    check("Python version >= 3.9", check_python_version)
    check("import chdb", check_chdb_import)
    check("Basic query (SELECT 1+1)", check_basic_query)
    check("DataFrame output format", check_dataframe_output)
    check("Session create + query", check_session)
    check("Parametrized query", check_parametrized)

    print()
    print("=" * 40)
    passed = sum(1 for _, s, _ in results if s == PASS)
    total = len(results)
    print(f"Results: {passed}/{total} passed")

    if passed < total:
        print("\nFailed checks:")
        for name, status, err in results:
            if status == FAIL:
                print(f"  - {name}: {err}")
        sys.exit(1)
    else:
        print("All checks passed!")
