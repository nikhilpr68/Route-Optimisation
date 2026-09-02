import io
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

import main  # noqa: E402


def test_load_problem_resolves_testcase_relative_to_engine_dir(monkeypatch):
    class DummyStdin(io.StringIO):
        def isatty(self):
            return True

    monkeypatch.chdir(REPO_ROOT)
    monkeypatch.setattr(sys, "stdin", DummyStdin(""))

    args = SimpleNamespace(testcase="testcase1")
    problem, stdin_mode = main.load_problem(args)

    assert stdin_mode is False
    assert len(problem.employees) >= 1
    assert len(problem.vehicles) >= 1
    assert len(problem.baseline) >= 1

