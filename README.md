# SOMA Lite

**660 lines that give any LLM infinite autonomous horizon.**

SOMA Lite is a minimal, zero-dependency implementation of the Sovereign Operating Memory Architecture. It provides persistent memory, terminal state, and tool execution for any LLM via JSON tool calls.

## Quick Start

```bash
# Install
npm install soma-lite

# Run
npx soma-lite --task "Create a hello.js that prints Hello World"
```

## Features

- **Memory Architecture (L1/L2/L3)**: Persistent context across turns
- **Stateful Terminal**: `cd`, `export`, and variables persist between commands
- **Pressure Memory (Pm)**: Automatic context management with checkpointing
- **Zero Dependencies**: Pure Node.js, ~700 lines of code

## Architecture

```
soma-lite.js      → Kernel: memory, tools, terminal, prompt builder
run-agent-lite.js → Agent loop: LLM calls, JSON parsing, tool execution
```

## Usage

```bash
node run-agent-lite.js --task "Your task here" --max-turns 10
```

Options:
- `--task`        : Task description
- `--max-turns`   : Max turns (default: 5)
- `--provider`    : `google`, `openrouter`, `anthropic`, `openai`
- `--model`       : Model name
- `--workspace`   : Working directory
- `--debug`       : Show L1 memory content
- `--rpm`         : Requests per minute limit

## LLM Communication Protocol

SOMA Lite uses simple JSON tool calls:

```json
{"tool": "execute_command", "args": {"command": "ls -la", "reason": "List files"}}
{"tool": "write_file", "args": {"path": "test.js", "content": "console.log(1)"}}
{"tool": "checkpoint", "args": {"description": "Core features done"}}
{"tool": "finish_task", "args": {"status": "success", "summary": "Task complete"}}
```

## Memory Layers

- **L1**: Current context (identity + dashboard + action log)
- **L2**: Episodic memory (session_log.jsonl + turn folders)
- **L3**: Persistent knowledge (identity.md, task.md, CHANGELOG.md)

## License

MIT

## Author

Mario Raúl Carbonell Martínez
