const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const { SOMALite } = require('../soma-lite');

function makeWorkspace(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function normalizeText(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function runPythonScenario(workspace) {
  const script = `
import json
from pathlib import Path
from soma_lite import SOMALite

ws = Path(${JSON.stringify(workspace)})
s = SOMALite(str(ws))
results = {}
results["execute"] = s.invoke_tool("execute_command", {"command": "echo hello"})[0]
s.invoke_tool("execute_command", {"command": "cd subdir"})
s.invoke_tool("execute_command", {"command": "export FOO=bar"})
s.invoke_tool("write_file", {"path": "alpha.txt", "content": "line1\\nline2"})
results["read"] = s.invoke_tool("read_file", {"path": "alpha.txt", "start": 1, "end": 2})[0]
results["write"] = s.invoke_tool("write_file", {"path": "beta.txt", "content": "beta"})[0]
results["finish"] = s.invoke_tool("finish_task", {"status": "success", "summary": "done", "feedback": "ok"})[0]
s.invoke_tool("add_note", {"title": "Note", "content": "Body"})
s.invoke_tool("checkpoint", {"description": "checkpoint test"})
results["cwd"] = str(s.terminal.cwd)
results["env"] = s.terminal.env_vars.get("FOO")
results["prompt"] = s.build_prompt()
results["action_log_len"] = len(s.action_log)
results["changelog"] = (ws / ".soma" / "CHANGELOG.md").read_text(encoding="utf-8")
print(json.dumps(results))
`;

  const pythonExe = process.env.PYTHON_EXE || 'C:\\Python314\\python.exe';
  const out = execFileSync(pythonExe, ['-c', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  return JSON.parse(out);
}

function runJsScenario(workspace) {
  const s = new SOMALite(workspace);
  const results = {};
  results.execute = s.invokeTool('execute_command', { command: 'echo hello' }).result;
  s.invokeTool('execute_command', { command: 'cd subdir' });
  s.invokeTool('execute_command', { command: 'export FOO=bar' });
  s.invokeTool('write_file', { path: 'alpha.txt', content: 'line1\nline2' });
  results.read = s.invokeTool('read_file', { path: 'alpha.txt', start: 1, end: 2 }).result;
  results.write = s.invokeTool('write_file', { path: 'beta.txt', content: 'beta' }).result;
  results.finish = s.invokeTool('finish_task', { status: 'success', summary: 'done', feedback: 'ok' }).result;
  s.invokeTool('add_note', { title: 'Note', content: 'Body' });
  s.invokeTool('checkpoint', { description: 'checkpoint test' });
  results.cwd = String(s.terminal.cwd);
  results.env = s.terminal.envVars.FOO;
  results.prompt = s.buildPrompt();
  results.action_log_len = s.actionLog.length;
  results.changelog = fs.readFileSync(path.join(workspace, '.soma', 'L3', 'CHANGELOG.md'), 'utf8');
  return results;
}

function main() {
  const wsJs = makeWorkspace('soma-lite-js-');
  const wsPy = makeWorkspace('soma-lite-py-');
  fs.mkdirSync(path.join(wsJs, 'subdir'), { recursive: true });
  fs.mkdirSync(path.join(wsPy, 'subdir'), { recursive: true });

  const js = runJsScenario(wsJs);
  const py = runPythonScenario(wsPy);

  assert.equal(normalizeText(js.execute), normalizeText(py.execute), 'execute_command should match');
  assert.equal(normalizeText(js.read), normalizeText(py.read), 'read_file should match');
  assert.equal(normalizeText(js.write), normalizeText(py.write), 'write_file should match');
  assert.equal(normalizeText(js.finish), normalizeText(py.finish), 'finish_task should match');
  assert.equal(path.basename(js.cwd), path.basename(py.cwd), 'cwd basename should match');
  assert.equal(js.env, py.env, 'exported env should match');
  assert.equal(js.action_log_len, py.action_log_len, 'checkpoint should leave matching action log state');
  assert.ok(js.prompt.includes('<dashboard>'), 'JS prompt should include dashboard');
  assert.ok(py.prompt.includes('<dashboard>'), 'Python prompt should include dashboard');
  assert.ok(js.changelog.includes('checkpoint test'), 'JS changelog should contain checkpoint entry');
  assert.ok(py.changelog.includes('checkpoint test'), 'Python changelog should contain checkpoint entry');

  console.log('Parity tests passed.');
}

main();
