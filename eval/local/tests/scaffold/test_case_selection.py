import json
import os
import re
import subprocess
import sys
from pathlib import Path
import pytest
from scaffold.python.case_selection import read_case_selection, select_case_params


def selection():
    return {"sourceRunId": "original", "cases": [{"task": "failed", "treatment": "DYNAMIC_SKILL", "repetition": 2, "caseHash": "fixed", "validatorHash": "fixed"}]}


def test_only_failed_combinations_preserve_original_repetitions():
    assert select_case_params([("passed", "DYNAMIC_SKILL"), ("failed", "DYNAMIC_SKILL")], 1, selection()) == [("failed", "DYNAMIC_SKILL", 2)]
    assert len(select_case_params([("passed", "DYNAMIC_SKILL"), ("failed", "DYNAMIC_SKILL")], 2, None)) == 4


def test_missing_combinations_fail_before_execution():
    with pytest.raises(ValueError, match="不可用"):
        select_case_params([("passed", "DYNAMIC_SKILL")], 1, selection())


def test_requires_managed_context_and_rejects_duplicate_identities():
    env = {"COMET_EVAL_CASE_SELECTION": json.dumps(selection())}
    assert read_case_selection(env) is None
    env["COMET_EVAL_MANAGED"] = "1"
    with pytest.raises(ValueError, match="上下文"):
        read_case_selection(env)
    env["COMET_EVAL_CONTEXT"] = "{}"
    assert read_case_selection(env)["sourceRunId"] == "original"
    duplicate = selection()
    duplicate["cases"] *= 2
    env["COMET_EVAL_CASE_SELECTION"] = json.dumps(duplicate)
    with pytest.raises(ValueError, match="重复"):
        read_case_selection(env)


def test_real_collection_omits_passed_cases_and_keeps_repetition_two(tmp_path):
    from scaffold.python.eval_context import resolve_eval_context
    skill = tmp_path / "skill"
    (skill / "comet").mkdir(parents=True)
    (skill / "SKILL.md").write_text("# Test Skill", encoding="utf-8")
    manifest = skill / "comet/eval.yaml"
    manifest.write_text("apiVersion: comet.eval/v1alpha1\nkind: SkillEvalManifest\nmetadata:\n  name: writer\nskill:\n  name: writer\n  source: ..\nevaluation:\n  tasks:\n    - name: passed\n      prompt: Pass\n      expect:\n        files: [PASS.md]\n    - name: failed\n      prompt: Fail\n      expect:\n        files: [FAIL.md]\n", encoding="utf-8")
    context = resolve_eval_context(manifest_path=manifest, project_root=tmp_path)
    environment = {key: value for key, value in os.environ.items() if not re.search(r"API_KEY|AUTH_TOKEN|PASSWORD|SECRET|CREDENTIAL", key, re.I)}
    selection_file = context.artifact_root / "runs/selected-collection/case-selection.json"
    selection_file.parent.mkdir(parents=True)
    selection_file.write_text(json.dumps(selection()), encoding="utf-8")
    environment.update({"HOME": str(tmp_path), "USERPROFILE": str(tmp_path), "COMET_EVAL_CONTEXT": json.dumps(context.to_payload()), "COMET_EVAL_MANAGED": "1", "COMET_EVAL_CASE_SELECTION": "@" + str(selection_file), "COMET_EVAL_EXPERIMENT_ID": "selected-collection", "PYTHONDONTWRITEBYTECODE": "1"})
    environment.pop("COMET_APPLICATION_EVAL_CONTEXT", None)
    root = Path(__file__).resolve().parents[3]
    result = subprocess.run([sys.executable, "-m", "pytest", "local/tests/tasks/test_tasks.py", "--collect-only", "--eval-manifest", str(manifest), "--project-root", str(tmp_path), "--agent", "codex", "--model", "fixture", "-q", "-p", "no:cacheprovider"], cwd=root, env=environment, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "failed-DYNAMIC_SKILL-r2" in result.stdout
    assert "passed-DYNAMIC_SKILL" not in result.stdout
    matrix = json.loads((context.artifact_root / "runs/selected-collection/expected-case-matrix.json").read_text())
    assert len(matrix["cases"]) == 1
    assert matrix["cases"][0]["rep"] == 2
