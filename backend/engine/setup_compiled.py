from __future__ import annotations

from setuptools import Extension, setup


setup(
    name="engine-compiled-accelerators",
    version="0.0.0",
    ext_modules=[
        Extension(
            "compiled._distance_ext",
            sources=["compiled/_distance_ext.c"],
            extra_compile_args=[],
        )
    ],
)

