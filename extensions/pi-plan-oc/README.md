# 🧭 pi-plan-oc — OpenCode-style Plan Mode for Pi

[![npm](https://img.shields.io/npm/v/@skylandzero/pi-plan-oc)](https://www.npmjs.com/package/@skylandzero/pi-plan-oc) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@skylandzero/pi-plan-oc` adds an OpenCode-style `/plan` collaboration mode to Pi. Plan mode is for read-only exploration, subagent-assisted codebase reconnaissance, clarifying questions, and writing an implementation plan to a `.md` file — without mutating any project files.

## Features

- Adds `/plan` to enter Plan mode, `/plan tools` to configure allowed tools
- Adds `--plan` to start a session in Plan mode
- **Plan file output**: writes the final plan to `~/.pi/plans/<session-name>.md`
- **5-phase OpenCode workflow**: Understand → Design → Review → Write Plan → Done
- **pi-subagents integration**: auto-detects the `subagent` tool and enables it in Plan mode for parallel codebase exploration with `scout` agents and design with `planner` agents
- **Structured questioning**: `plan_mode_question` tool for asking the user 1-3 concise questions with options
- **Tool safety**: blocks mutating built-in tools (`edit`, `write`) and filters bash commands for read-only safety
- **Plan file review**: `/plan` with an existing plan file lets you re-read the plan before implementing
- **No `<proposed_plan>` XML tags**: plans are written to real files, not embedded in conversation

## Install

```bash
# Install plan mode
pi install npm:@skylandzero/pi-plan-oc

# Recommended: also install subagents for parallel exploration
pi install npm:@skylandzero/pi-subagents
```

Try without installing:

```bash
pi -e ./extensions/pi-plan-oc -e ./extensions/pi-subagents
```

## Usage

```
/plan              — Enter Plan mode
/plan <prompt>     — Enter Plan mode with a prompt
/plan tools        — Configure which tools are active in Plan mode
/plan exit         — Exit Plan mode and discard plan
```

When Plan mode is active, the agent follows a 5-phase workflow:

1. **Understand** — Read files, use `scout` subagents to explore in parallel
2. **Design** — Design the approach, optionally using `planner` subagents
3. **Review** — Verify alignment, ask remaining questions
4. **Write Plan** — Write the final plan to the plan file
5. **Done** — Manually exit Plan mode with `/plan exit`, read the plan file, then implement

The plan file is written to `~/.pi/plans/<session-name>.md`. Exit Plan mode manually when ready to implement.

## Requirements

- Pi 0.80+
- Optional but recommended: `@skylandzero/pi-subagents` for subagent-based exploration

## License

MIT.
