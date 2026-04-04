import json
import os
import subprocess
import sys
import shutil
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from soma_lite import SOMALite


ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("NODE_EXE", "node")


def normalize(text: str) -> str:
    return str(text).replace("\r\n", "\n").replace("\r", "\n").strip()


def run_js(workspace: Path) -> dict:
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "subdir").mkdir(parents=True, exist_ok=True)
    script = f"""
const fs = require('fs');
const path = require('path');
const {{ SOMALite }} = require({json.dumps(str(ROOT / "soma-lite"))});

const ws = {json.dumps(str(workspace))};
const s = new SOMALite(ws);
const results = {{}};
s.invokeTool('execute_command', {{ command: 'cd subdir' }});
s.invokeTool('execute_command', {{ command: 'export FOO=bar' }});
results.blocked = s.invokeTool('execute_command', {{ command: 'python' }}).result;
s.invokeTool('write_file', {{ path: 'alpha.txt', content: 'line1\\nline2' }});
results.read = s.invokeTool('read_file', {{ path: 'alpha.txt', start: 1, end: 2 }}).result;
results.write = s.invokeTool('write_file', {{ path: 'beta.txt', content: 'beta' }}).result;
results.finish = s.invokeTool('finish_task', {{ status: 'success', summary: 'done', feedback: 'ok' }}).result;
s.invokeTool('add_note', {{ title: 'Note', content: 'Body' }});
results.cwd = String(s.terminal.cwd);
results.env = s.terminal.envVars.FOO;
results.prompt = s.buildPrompt();
results.action_log_len = s.actionLog.length;
console.log(JSON.stringify(results));
"""
    out = subprocess.check_output([NODE, "-e", script], cwd=ROOT, text=True, encoding="utf-8", errors="replace")
    return json.loads(out)


def run_py(workspace: Path) -> dict:
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "subdir").mkdir(parents=True, exist_ok=True)
    s = SOMALite(str(workspace))
    results = {}
    s.invoke_tool("execute_command", {"command": "cd subdir"})
    s.invoke_tool("execute_command", {"command": "export FOO=bar"})
    results["blocked"] = s.invoke_tool("execute_command", {"command": "python"})[0]
    s.invoke_tool("write_file", {"path": "alpha.txt", "content": "line1\nline2"})
    results["read"] = s.invoke_tool("read_file", {"path": "alpha.txt", "start": 1, "end": 2})[0]
    results["write"] = s.invoke_tool("write_file", {"path": "beta.txt", "content": "beta"})[0]
    results["finish"] = s.invoke_tool("finish_task", {"status": "success", "summary": "done", "feedback": "ok"})[0]
    s.invoke_tool("add_note", {"title": "Note", "content": "Body"})
    results["cwd"] = str(s.terminal.cwd)
    results["env"] = s.terminal.env_vars.get("FOO")
    results["prompt"] = s.build_prompt()
    results["action_log_len"] = len(s.action_log)
    return results


def main():
    base = ROOT / ".tmp_parity"
    if base.exists():
        shutil.rmtree(base, ignore_errors=True)
    js_ws = base / "js"
    py_ws = base / "py"

    try:
        js = run_js(js_ws)
        py = run_py(py_ws)

        assert normalize(js["read"]) == normalize(py["read"])
        assert normalize(js["write"]) == normalize(py["write"])
        assert normalize(js["finish"]) == normalize(py["finish"])
        assert "COMANDO BLOQUEADO" in js["blocked"]
        assert "COMANDO BLOQUEADO" in py["blocked"]
        assert Path(js["cwd"]).name == Path(py["cwd"]).name
        assert js["env"] == py["env"]
        assert js["action_log_len"] == py["action_log_len"]
        assert "<dashboard>" in js["prompt"]
        assert "<dashboard>" in py["prompt"]

        print("Parity tests passed.")
    finally:
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    main()
