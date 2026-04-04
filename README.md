# SOMA Lite

**660 lines that give any LLM infinite autonomous horizon.**

SOMA Lite is a minimal, zero-dependency implementation of the Sovereign Operating Memory Architecture. It provides persistent memory, terminal state, and tool execution for any LLM via JSON tool calls.

## 📚 Academic Paper

This is the reference implementation for **SOMA (Sovereign Operative Memory Architecture)**:

- **Paper:** [DOI: 10.5281/zenodo.19354872](https://doi.org/10.5281/zenodo.19354872)
- **npm Package:** [soma-lite](https://www.npmjs.com/package/soma-lite)

If you use soma-lite in research, please cite the paper.

## Quick Start

```bash
# Install
npm install soma-lite

# Create a .env file in the project root
# Example:
# GOOGLE_API_KEY=your_key_here

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

## Environment Variables

Create a `.env` file in the repository root and add the API keys you need:

```bash
GOOGLE_API_KEY=your_google_key
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
OPENROUTER_API_KEY=your_openrouter_key
```

Both `run-agent-lite.js` and `run_agent_lite.py` load `.env` automatically from the project root.

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
