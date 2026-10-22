"""失败重跑只选择原记录中的执行组合，不改变完整评估结论。"""
from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Mapping
from pathlib import Path


def read_case_selection(environment: Mapping[str, str] | None = None) -> dict | None:
    source = os.environ if environment is None else environment
    raw = source.get("COMET_EVAL_CASE_SELECTION")
    if not raw or source.get("COMET_EVAL_MANAGED") != "1":
        return None
    if not source.get("COMET_EVAL_CONTEXT"):
        raise ValueError("失败重跑缺少受管评估上下文")
    if raw.startswith("@"):
        from scaffold.python.eval_context import context_from_environment, resolve_managed_path
        context = context_from_environment()
        if context is None:
            raise ValueError("失败重跑缺少受管评估上下文")
        expected = resolve_managed_path(context, "runs", source.get("COMET_EVAL_EXPERIMENT_ID", ""), "case-selection.json")
        if Path(raw[1:]).resolve() != expected.resolve() or expected.stat().st_size > 4 * 1024 * 1024:
            raise ValueError("失败重跑清单越过当前运行或超过读取限制")
        value = json.loads(expected.read_text(encoding="utf-8"))
    else:
        value = json.loads(raw)
    if not isinstance(value, dict) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", str(value.get("sourceRunId", ""))):
        raise ValueError("失败重跑的原记录身份无效")
    cases = value.get("cases")
    if not isinstance(cases, list) or not 1 <= len(cases) <= 2000:
        raise ValueError("失败重跑需要非空执行组合")
    seen = set()
    for case in cases:
        if not isinstance(case, dict) or any(not isinstance(case.get(key), str) or not case[key] for key in ("task", "treatment", "caseHash", "validatorHash")):
            raise ValueError("失败重跑缺少固定用例身份")
        rep = case.get("repetition")
        if isinstance(rep, bool) or not isinstance(rep, int) or not 1 <= rep <= 1000:
            raise ValueError("失败重跑的重复次数无效")
        identity = (case["task"], case["treatment"], rep)
        if identity in seen:
            raise ValueError("失败重跑存在重复执行组合")
        seen.add(identity)
    return value


def select_case_params(base_params: list[tuple[str, str]], count: int, selection: dict | None) -> list[tuple[str, str, int]]:
    if selection is None:
        return [(task, treatment, rep + 1) for rep in range(count) for task, treatment in base_params]
    available = set(base_params)
    if any((case["task"], case["treatment"]) not in available for case in selection["cases"]):
        raise ValueError("原执行组合已不可用，请恢复固定用例或进行完整评估")
    return [(case["task"], case["treatment"], case["repetition"]) for case in selection["cases"]]


def assert_selected_case_identity(task: str, treatment: str, manifest: dict) -> None:
    selection = read_case_selection()
    if selection is None:
        return
    expected = [case for case in selection["cases"] if case["task"] == task and case["treatment"] == treatment]
    if not expected or any(case["validatorHash"] != manifest.get("validator_hash") for case in expected):
        raise ValueError("原评分规则已变化，请进行完整评估")
    if not manifest.get("authored_hashes"):
        parts = [manifest.get(key) for key in ("task_hash", "instruction_hash", "environment_hash", "data_hash")]
        digest = hashlib.sha256(json.dumps(parts, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        if any(case["caseHash"] != digest for case in expected):
            raise ValueError("原用例输入或环境已变化，请进行完整评估")
