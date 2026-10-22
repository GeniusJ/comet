import json
import subprocess
import sys
import time

from scaffold.python.eval_context import resolve_eval_context
from scaffold.python import progress as progress_module
from scaffold.python.progress import (
    observe_eval_container,
    observe_eval_event,
    publish_eval_progress,
)


def progress_context(tmp_path, monkeypatch):
    skill = tmp_path / "skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Fixture", encoding="utf-8")
    context = resolve_eval_context(skill_path=skill, project_root=tmp_path)
    monkeypatch.setenv("COMET_EVAL_CONTEXT", json.dumps(context.to_payload()))
    monkeypatch.setenv("COMET_EVAL_EXPERIMENT_ID", "test-run")
    monkeypatch.setenv("COMET_EVAL_PROGRESS_ENABLED", "1")
    return context.artifact_root / "runs" / "test-run" / "progress.json"


def event(number, event_type="assistant", **payload):
    return {
        "type": event_type,
        "_comet_eval": {
            "schema": "comet.eval.stream-event.v1",
            "invocation_id": "fixture-turn",
            "sequence": number,
            "observed_at": f"2026-10-11T07:00:{number:02d}+00:00",
            "role": "subject",
        },
        **payload,
    }


def test_progress_is_bound_to_the_cli_owned_context(tmp_path, monkeypatch):
    skill = tmp_path / "skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Fixture", encoding="utf-8")
    context = resolve_eval_context(skill_path=skill, project_root=tmp_path)
    monkeypatch.setenv("COMET_EVAL_CONTEXT", json.dumps(context.to_payload()))
    monkeypatch.setenv("COMET_EVAL_EXPERIMENT_ID", "test-run")
    monkeypatch.setenv("COMET_EVAL_PROGRESS_ENABLED", "1")
    publish_eval_progress("judging")
    progress = json.loads(
        (context.artifact_root / "runs" / "test-run" / "progress.json").read_text(encoding="utf-8")
    )
    assert progress["runId"] == "test-run"
    assert progress["phase"] == "judging"


def test_progress_cannot_publish_outside_the_run_identity(tmp_path, monkeypatch):
    monkeypatch.setenv("COMET_EVAL_PROGRESS_ENABLED", "1")
    monkeypatch.setenv("COMET_EVAL_EXPERIMENT_ID", "../outside")
    monkeypatch.delenv("COMET_EVAL_CONTEXT", raising=False)
    publish_eval_progress("judging")
    assert not (tmp_path / "outside").exists()


def test_events_publish_bounded_activity_without_thinking_or_arguments(tmp_path, monkeypatch):
    file = progress_context(tmp_path, monkeypatch)
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "private-key-for-progress-test")
    publish_eval_progress("preparing", task="case-a", treatment="DYNAMIC_SKILL", repetition=2)
    observe_eval_event(event(1, "comet.eval.invocation.started"))
    for index, name in enumerate(["Read", "Edit", "Bash", "Task"], start=2):
        observe_eval_event(
            event(
                index,
                message={
                    "content": [
                        {"type": "thinking", "thinking": "private reasoning"},
                        {
                            "type": "tool_use",
                            "name": name,
                            "input": {"token": "private-key-for-progress-test"},
                        },
                    ]
                },
            )
        )
    data = json.loads(file.read_text(encoding="utf-8"))
    assert data["phase"] == "running"
    assert data["currentCase"] == {"task": "case-a", "treatment": "DYNAMIC_SKILL", "repetition": 2}
    assert [item["message"] for item in data["activities"]] == [
        "修改工作区文件",
        "执行命令",
        "调用子 Agent",
    ]
    assert "private reasoning" not in file.read_text(encoding="utf-8")
    assert "private-key-for-progress-test" not in file.read_text(encoding="utf-8")
    publish_eval_progress("finalizing")
    final = json.loads(file.read_text(encoding="utf-8"))
    assert final["currentCase"]["task"] == "case-a"
    assert final["phase"] == "finalizing"


def test_generation_phase_and_old_receipts_do_not_become_case_progress(tmp_path, monkeypatch):
    file = progress_context(tmp_path, monkeypatch)
    publish_eval_progress("generating")
    observe_eval_event(event(5, "comet.eval.invocation.started"))
    observe_eval_event(event(6, message={"content": [{"type": "tool_use", "name": "Read"}]}))
    snapshot = json.loads(file.read_text(encoding="utf-8"))
    observe_eval_event(event(1, message={"content": [{"type": "tool_use", "name": "Write"}]}))
    assert json.loads(file.read_text(encoding="utf-8")) == snapshot
    assert snapshot["phase"] == "generating"


def test_container_reader_streams_before_exit_and_stops_only_its_log_client(tmp_path, monkeypatch):
    file = progress_context(tmp_path, monkeypatch)
    script = tmp_path / "docker.py"
    script.write_text(
        "import json,time\nprint("
        + repr(json.dumps(event(1, "comet.eval.invocation.started")))
        + ",flush=True)\ntime.sleep(30)\n",
        encoding="utf-8",
    )
    original = subprocess.Popen
    clients = []
    calls = []

    def start(command, **kwargs):
        calls.append(command)
        child = original([sys.executable, str(script)], **kwargs)
        clients.append(child)
        return child

    monkeypatch.setattr(progress_module.subprocess, "Popen", start)
    with observe_eval_container("comet-eval-turn-" + "a" * 32):
        deadline = time.monotonic() + 5
        while not file.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert (
            json.loads(file.read_text(encoding="utf-8"))["activities"][-1]["message"]
            == "模型开始处理"
        )
        assert clients[0].poll() is None
    assert clients[0].poll() is not None
    assert calls[0][:3] == ["docker", "logs", "--follow"]
    assert not any("rm" in command or "stop" in command for command in calls)
