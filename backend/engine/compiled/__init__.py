"""Optional compiled accelerators for backend/engine.

This directory is on `sys.path` in tests/benchmarks (they typically insert
`backend/engine`), so the `compiled` package can be imported as:

    from compiled import _distance_ext

All compiled pieces must be optional and have pure-Python fallbacks so that
the engine remains usable without a compiler toolchain.
"""

