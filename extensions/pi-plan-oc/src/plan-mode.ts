import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	createPlanFile,
	planFileHasContent,
	readPlanFromFile,
	type PlanFileInfo,
} from "./plan-file.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const STATE_ENTRY_TYPE = "plan-oc-state";
const STATUS_KEY = "plan-oc";
const PLAN_WIDGET_KEY = "plan-oc-widget";
const PLAN_MODE_QUESTION_TOOL_NAME = "plan_mode_question";
const SUBAGENT_TOOL_NAME = "subagent";

const SAFE_BUILTIN_PLAN_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const TOOL_SELECTOR_PAGE_SIZE = 10;
const PLAN_MODE_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "plan-oc.json");

const MUTATING_BASH_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|version)\b/i,
	/\byarn\s+(add|remove|install|publish|upgrade)\b/i,
	/\bpnpm\s+(add|remove|install|publish|update)\b/i,
	/\bbun\s+(add|remove|install|update|publish)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\buv\s+(add|remove|sync|lock|pip\s+install)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_BASH_PATTERNS = [
	/^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|jq|awk|rg|fd|bat|eza)\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|grep)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*(node|python|python3|npm|tsc|biome|ruff|ty)\s+--version\b/i,
];

// ─── Types ──────────────────────────────────────────────────────────────────

interface PlanModeState {
	enabled: boolean;
	planFileInfo?: PlanFileInfo;
	selectedToolNames?: string[];
	selectedToolKeys?: string[];
}

interface PlanModeConfig {
	selectedToolNames?: string[];
	showToggleNotification?: boolean;
}

export interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

interface PlanModeQuestion {
	id: string;
	header: string;
	question: string;
	options: PlanModeQuestionOption[];
}

interface PlanModeQuestionOption {
	label: string;
	description?: string;
}

type PlanModeQuestionReason =
	| "cancelled"
	| "ui_unavailable"
	| "plan_mode_inactive"
	| "invalid_input";

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: Partial<PlanModeState>;
};

// ─── Default export ─────────────────────────────────────────────────────────

export default function planModeOC(pi: ExtensionAPI) {
	let state: PlanModeState = { enabled: false };
	let previousTools: string[] | undefined;
	let config: PlanModeConfig = {};

	// ── Flag ──────────────────────────────────────────────────────────────
	pi.registerFlag("plan", {
		description: "Start in OpenCode-style Plan mode",
		type: "boolean",
		default: false,
	});

	// ── Plan Mode Question Tool ───────────────────────────────────────────
	const QUESTION_PARAMS = {
		type: "object",
		additionalProperties: false,
		required: ["questions"],
		properties: {
			questions: {
				type: "array",
				minItems: 1,
				maxItems: 3,
				description: "Questions to show the user. Prefer 1 and do not exceed 3.",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["id", "header", "question", "options"],
					properties: {
						id: { type: "string", description: "Stable identifier (snake_case)." },
						header: { type: "string", description: "Short header label (12 or fewer chars)." },
						question: { type: "string", description: "Single-sentence prompt." },
						options: {
							type: "array",
							minItems: 2,
							maxItems: 4,
							description: "2-4 mutually exclusive choices.",
							items: {
								type: "object",
								additionalProperties: false,
								required: ["label", "description"],
								properties: {
									label: { type: "string", description: "User-facing label (1-5 words)." },
									description: {
										type: "string",
										description: "One short sentence explaining impact.",
									},
								},
							},
						},
					},
				},
			},
		},
	} as const;

	pi.registerTool({
		name: PLAN_MODE_QUESTION_TOOL_NAME,
		label: "Plan question",
		description:
			"Ask the user one to three Plan-mode clarification questions with meaningful options, then wait for the answer. Only available while Plan mode is active.",
		promptSnippet: "Ask user decision questions while Plan mode is active",
		promptGuidelines: [
			"In Plan mode, use plan_mode_question for important preferences, tradeoffs, or assumptions that cannot be discovered from read-only exploration.",
		],
		parameters: QUESTION_PARAMS,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return questionCancelled(
					[],
					"plan_mode_inactive",
					"plan_mode_question is only available while Plan mode is active.",
				);
			}

			const parsed = normalizeQuestions(params);
			if (!parsed.ok) {
				return questionCancelled([], "invalid_input", `Error: ${parsed.error}`);
			}

			if (!ctx.hasUI) {
				return questionCancelled(
					parsed.questions,
					"ui_unavailable",
					"Interactive UI is not available.",
				);
			}

			const answers = await askQuestions(parsed.questions, ctx);
			if (!answers) {
				return questionCancelled(parsed.questions, "cancelled", "User cancelled.");
			}

			return questionAnswered(parsed.questions, answers);
		},
	});

	// ── Shortcut: Alt+Q ──────────────────────────────────────────────────
	pi.registerShortcut(Key.alt("q"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			if (state.enabled) {
				exitPlanMode(ctx);
				notifyToggle(ctx, "Plan mode disabled.");
			} else {
				enterPlanMode(ctx);
				notifyToggle(ctx, "Plan mode enabled. Read-only exploration + subagents.");
			}
		},
	});

	// ── Command: /plan ───────────────────────────────────────────────────
	const PLAN_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
		{ value: "exit", label: "exit", description: "Leave Plan mode" },
		{ value: "off", label: "off", description: "Leave Plan mode" },
		{ value: "tools", label: "tools", description: "Select tools allowed in Plan mode" },
		{ value: "plan", label: "plan", description: "Show current plan file" },
	];

	pi.registerCommand("plan", {
		description: "Enter or manage OpenCode-style Plan mode",
		getArgumentCompletions: (prefix: string) => completePlanArgs(prefix, PLAN_COMMAND_COMPLETIONS),
		handler: async (args, ctx) => {
			const prompt = args.trim();
			const cmd = prompt.toLowerCase();

			if (cmd === "exit" || cmd === "off") {
				exitPlanMode(ctx);
				const fi = state.planFileInfo;
				if (fi && planFileHasContent(fi.filePath)) {
					notifyToggle(ctx, `Plan mode disabled. Plan saved at ${fi.relativePath}`);
				} else {
					notifyToggle(ctx, "Plan mode disabled.");
				}
				return;
			}

			if (cmd === "tools") {
				if (!state.enabled) enterPlanMode(ctx);
				await showToolSelector(ctx);
				return;
			}

			if (cmd === "plan") {
				if (!state.planFileInfo) {
					ctx.ui.notify("No plan file.", "info");
					return;
				}
				const content = readPlanFromFile(state.planFileInfo.filePath);
				ctx.ui.notify(
					content
						? `Plan: ${state.planFileInfo.relativePath}\n\n${content.slice(0, 2000)}`
						: "Plan file is empty.",
					"info",
				);
				return;
			}

			if (prompt) {
				enterPlanMode(ctx);
				if (ctx.isIdle()) pi.sendUserMessage(prompt);
				else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				return;
			}

			if (!state.enabled) {
				enterPlanMode(ctx);
				notifyToggle(ctx, "Plan mode enabled. Read-only exploration + subagents.");
				return;
			}

			await showPlanMenu(ctx);
		},
	});

	// ── Events ───────────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig();
		restoreState(ctx);

		if (state.selectedToolNames === undefined && state.selectedToolKeys === undefined) {
			if (config.selectedToolNames) {
				state.selectedToolNames = config.selectedToolNames;
			}
		}

		if (pi.getFlag("plan") === true) {
			state.enabled = true;
			enterPlanMode(ctx);
		} else if (state.enabled) {
			activatePlanModeTools(ctx);
		} else {
			deactivateQuestionTool();
		}

		updateUi(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		persistState();
		clearUi(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!state.enabled) return;

		// Allow write/edit ONLY for the plan file
		if (
			(event.toolName === "write" || event.toolName === "edit") &&
			isBuiltinToolByName(event.toolName, pi)
		) {
			const input = event.input as { path?: string } | undefined;
			const targetPath = input?.path;
			if (targetPath !== state.planFileInfo?.filePath) {
				return {
					block: true,
					reason: `Plan mode only allows writing to the plan file at ${state.planFileInfo?.filePath ?? "(not set)"}. Use this exact path with the Write tool to build your plan.`,
				};
			}
			return;
		}

		if (isBlockedBuiltinName(event.toolName, pi)) {
			return {
				block: true,
				reason: `Plan mode blocks built-in tool '${event.toolName}'.`,
			};
		}

		if (event.toolName === "bash") {
			const command = readCommand(event.input);
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode blocks mutating or non-allowlisted bash commands.\nCommand: ${command}`,
				};
			}
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!state.enabled) return;

		if (!state.planFileInfo) {
			const sessionName = getSessionName(ctx);
			state.planFileInfo = createPlanFile(sessionName);
		}

		applyPlanModeTools(ctx);
		persistState();
		updateUi(ctx);

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt(state, pi)}`,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!state.enabled) return;
		persistState();
		updateUi(ctx);
	});

	// ── Internal functions ───────────────────────────────────────────────

	function notifyToggle(ctx: ExtensionContext, message: string) {
		if (config.showToggleNotification === false) return;
		ctx.ui.notify(message, "info");
	}

	function enterPlanMode(ctx: ExtensionContext) {
		if (!state.enabled) {
			previousTools = withoutQuestionTool(getActiveToolsSafe(pi));
		}
		state = { ...state, enabled: true };

		const sessionName = getSessionName(ctx);
		state.planFileInfo = createPlanFile(sessionName);

		activatePlanModeTools(ctx);
		persistState();
		updateUi(ctx);
	}

	function exitPlanMode(ctx: ExtensionContext) {
		const wasEnabled = state.enabled;
		state = { ...state, enabled: false };
		if (wasEnabled) restoreTools();
		persistState();
		updateUi(ctx);
	}

	function activatePlanModeTools(ctx: ExtensionContext) {
		previousTools ??= withoutQuestionTool(getActiveToolsSafe(pi));
		applyPlanModeTools(ctx);
	}

	function applyPlanModeTools(ctx: ExtensionContext) {
		pi.setActiveTools(planModeToolNames(state, pi));
	}

	function restoreTools() {
		const restored = previousTools && previousTools.length > 0 ? previousTools : DEFAULT_TOOLS;
		pi.setActiveTools(withoutQuestionTool(restored));
		previousTools = undefined;
	}

	function deactivateQuestionTool() {
		const active = getActiveToolsSafe(pi);
		const filtered = withoutQuestionTool(active);
		if (filtered.length !== active.length) {
			pi.setActiveTools(filtered);
		}
	}

	function persistState() {
		pi.appendEntry<PlanModeState>(STATE_ENTRY_TYPE, state);
	}

	function restoreState(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getEntries() as SessionEntry[];
		const entry = entries
			.filter((c) => c.type === "custom" && c.customType === STATE_ENTRY_TYPE)
			.pop();
		if (!entry?.data) return;
		const enabled = entry.data.enabled ?? false;
		state = {
			enabled,
			planFileInfo: enabled ? entry.data.planFileInfo : undefined,
			selectedToolNames: entry.data.selectedToolNames,
			selectedToolKeys: entry.data.selectedToolKeys,
		};
	}

	function updateUi(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, formatStatus(state));

		if (state.enabled && state.planFileInfo && planFileHasContent(state.planFileInfo.filePath)) {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, [
				`Plan ready: ${state.planFileInfo.relativePath}`,
				"/plan exit to leave, then implement.",
			]);
		} else {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
		}
	}

	function clearUi(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
	}

	function getSessionName(ctx: ExtensionContext): string | undefined {
		try {
			const file = ctx.sessionManager.getSessionFile();
			if (file) return path.basename(file, path.extname(file));
		} catch {
			// ignore
		}
		return undefined;
	}

	// ── Tool Selector ────────────────────────────────────────────────────

	async function showToolSelector(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(formatToolSummary(state, pi), "info");
			return;
		}

		let pageIndex = 0;
		while (true) {
			const tools = selectableTools(pi);
			const pageCount = Math.max(1, Math.ceil(tools.length / TOOL_SELECTOR_PAGE_SIZE));
			pageIndex = Math.min(pageIndex, pageCount - 1);
			const pageStart = pageIndex * TOOL_SELECTOR_PAGE_SIZE;
			const pageTools = tools.slice(pageStart, pageStart + TOOL_SELECTOR_PAGE_SIZE);
			const selected = planModeSelectedNames(state, tools, pi);
			const choices = pageTools.map((t, i) =>
				formatToolChoice(t, selected.has(t.name), pageStart + i),
			);
			const nav: string[] = [];
			if (pageIndex > 0) nav.push("← Previous page");
			if (pageIndex < pageCount - 1) nav.push("→ Next page");
			nav.push("✓ Done");

			const choice = await ctx.ui.select(`Plan-mode tools (${pageIndex + 1}/${pageCount})`, [
				...choices,
				...nav,
			]);
			if (!choice || choice === "✓ Done") break;
			if (choice === "← Previous page") {
				pageIndex--;
				continue;
			}
			if (choice === "→ Next page") {
				pageIndex++;
				continue;
			}

			const idx = choices.indexOf(choice);
			const tool = pageTools[idx];
			if (!tool || !canSelectToolInPlanMode(tool)) {
				if (tool) ctx.ui.notify(`${tool.name} is blocked in Plan mode.`, "warning");
				continue;
			}

			const next = planModeSelectedNames(state, tools, pi);
			if (next.has(tool.name)) next.delete(tool.name);
			else next.add(tool.name);

			state = {
				...state,
				selectedToolNames: filterAvailableNames(Array.from(next), tools),
			};
			pi.setActiveTools(planModeToolNames(state, pi));
			persistState();
			saveConfig(state);
			updateUi(ctx);
		}

		pi.setActiveTools(planModeToolNames(state, pi));
		persistState();
		saveConfig(state);
		updateUi(ctx);
	}

	// ── Plan Menu ────────────────────────────────────────────────────────

	async function showPlanMenu(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify("Plan mode active.", "info");
			return;
		}

		const choices: string[] = [];
		if (state.planFileInfo && planFileHasContent(state.planFileInfo.filePath)) {
			choices.push("Re-read plan file");
		}
		choices.push("Configure Plan-mode tools", "Exit Plan mode");

		const choice = await ctx.ui.select("Plan mode menu:", choices);
		if (!choice) return;

		if (choice === "Exit Plan mode") {
			exitPlanMode(ctx);
			notifyToggle(ctx, "Plan mode disabled.");
			return;
		}
		if (choice === "Configure Plan-mode tools") {
			await showToolSelector(ctx);
			return;
		}
		if (choice === "Re-read plan file" && state.planFileInfo) {
			const content = readPlanFromFile(state.planFileInfo.filePath);
			ctx.ui.notify(
				content
					? `${state.planFileInfo.relativePath}\n\n${content.slice(0, 2000)}`
					: "Plan file is empty.",
				"info",
			);
			return;
		}
		updateUi(ctx);
	}
}

// ─── Config ─────────────────────────────────────────────────────────────────

function loadConfig(): PlanModeConfig {
	try {
		const raw = fs.readFileSync(PLAN_MODE_CONFIG_PATH, "utf-8");
		const data = JSON.parse(raw);
		return {
			selectedToolNames: Array.isArray(data.selectedToolNames)
				? data.selectedToolNames.filter((n: unknown) => typeof n === "string")
				: undefined,
			showToggleNotification:
				typeof data.showToggleNotification === "boolean"
					? data.showToggleNotification
					: undefined,
		};
	} catch {
		// ignore
	}
	return {};
}

function saveConfig(state: PlanModeState) {
	if (!state.selectedToolNames) return;
	try {
		const dir = path.dirname(PLAN_MODE_CONFIG_PATH);
		fs.mkdirSync(dir, { recursive: true });
		const existing = loadConfig();
		fs.writeFileSync(
			PLAN_MODE_CONFIG_PATH,
			JSON.stringify(
				{
					selectedToolNames: state.selectedToolNames,
					showToggleNotification: existing.showToggleNotification,
				},
				null,
				2,
			),
			"utf-8",
		);
	} catch (error) {
		console.error("Failed to save plan-oc config:", error);
	}
}

// ─── Plan mode state (module-level for exported helpers) ────────────────────
// This must be kept in sync with the factory's local state.
// Exported pure functions receive state as a parameter when they need it.

// ─── Exported helpers (pure, testable) ──────────────────────────────────────

export function completePlanArgs(
	prefix: string,
	completions: readonly CommandArgumentCompletion[],
): CommandArgumentCompletion[] | null {
	const trimmed = prefix.trimStart().toLowerCase();
	if (trimmed === "") return [...completions];
	if (/\s/.test(trimmed)) return null;
	const matches = completions.filter((c) => c.value.startsWith(trimmed));
	return matches.length > 0 ? [...matches] : null;
}

export function canSelectToolInPlanMode(tool: ToolInfo): boolean {
	if (isBuiltinTool(tool)) return SAFE_BUILTIN_PLAN_TOOLS.has(tool.name);
	return true;
}

export function isSafeCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (MUTATING_BASH_PATTERNS.some((p) => p.test(trimmed))) return false;
	return SAFE_BASH_PATTERNS.some((p) => p.test(trimmed));
}

export function withoutQuestionTool(names: string[]): string[] {
	return names.filter((n) => n !== PLAN_MODE_QUESTION_TOOL_NAME);
}

export function readCommand(input: unknown): string {
	const cmd = input as { command?: unknown } | undefined;
	return typeof cmd?.command === "string" ? cmd.command : "";
}

export function planModeToolNames(state: PlanModeState, pi: ExtensionAPI): string[] {
	const tools = getAllToolsSafe(pi);
	if (tools.length === 0) return ["read", "bash", PLAN_MODE_QUESTION_TOOL_NAME];

	const selected = planModeSelectedNames(state, tools, pi);
	const base = tools
		.filter((t) => selected.has(t.name) && canSelectToolInPlanMode(t))
		.map((t) => t.name);

	const required = [PLAN_MODE_QUESTION_TOOL_NAME];
	const hasSubagent = tools.some((t) => t.name === SUBAGENT_TOOL_NAME);
	if (hasSubagent && !selected.has(SUBAGENT_TOOL_NAME)) {
		required.push(SUBAGENT_TOOL_NAME);
	}

	return unique([...base, ...required]);
}

export function planModeSelectedNames(
	state: PlanModeState,
	tools: ToolInfo[],
	pi: ExtensionAPI,
): Set<string> {
	const selected = state.selectedToolNames ?? migrateSelectedKeys(state, tools);
	if (selected === undefined) return defaultPlanModeNames(tools);

	const available = new Set(tools.filter(canSelectToolInPlanMode).map((t) => t.name));
	return new Set(Array.isArray(selected) ? selected.filter((n) => available.has(n)) : []);
}

function defaultPlanModeNames(tools: ToolInfo[]): Set<string> {
	return new Set(
		tools
			.filter(
				(t) =>
					(isBuiltinTool(t) && SAFE_BUILTIN_PLAN_TOOLS.has(t.name)) ||
					t.name === PLAN_MODE_QUESTION_TOOL_NAME ||
					t.name === SUBAGENT_TOOL_NAME,
			)
			.map((t) => t.name),
	);
}

function migrateSelectedKeys(state: PlanModeState, tools: ToolInfo[]): string[] | undefined {
	if (state.selectedToolKeys === undefined) return undefined;
	return state.selectedToolKeys
		.map((key) => {
			const direct = tools.find((t) => t.name === key);
			if (direct) return direct.name;
			const [name] = key.split("\u001f");
			return tools.find((t) => t.name === name) ? name : undefined;
		})
		.filter((n): n is string => n !== undefined);
}

export function filterAvailableNames(names: string[], tools: ToolInfo[]): string[] {
	const available = new Set(tools.filter(canSelectToolInPlanMode).map((t) => t.name));
	return unique(names.filter((n) => available.has(n)));
}

export function formatStatus(state: PlanModeState): string | undefined {
	if (!state.enabled) return undefined;
	if (state.planFileInfo && planFileHasContent(state.planFileInfo.filePath)) return "plan ready";
	return "plan active";
}

export function formatToolSummary(state: PlanModeState, pi: ExtensionAPI): string {
	const names = planModeToolNames(state, pi);
	return `Tools: ${names.length > 0 ? names.join(", ") : "none"}`;
}

export function buildSystemPrompt(state: PlanModeState, pi: ExtensionAPI): string {
	const planPath = state.planFileInfo?.filePath ?? "(not set)";
	const tools = getAllToolsSafe(pi);
	const hasSubagent = tools.some((t) => t.name === SUBAGENT_TOOL_NAME);

	return `# Plan Mode (OpenCode-style)

Plan mode is active. You are in READ-ONLY planning mode.

You MUST NOT make any edits outside the plan file. You MUST NOT run non-readonly tools.
You MUST NOT modify project files, install dependencies, create files outside the plan file,
or make any changes to the system.

## Plan File

The plan file is at: \`${planPath}\`

**This is the ONLY file you are allowed to edit.** Use the Write tool to create and update it.
Write your plan incrementally. The plan file should contain your final recommended approach,
not all alternatives considered. Keep it comprehensive yet concise.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading code.

1. Read relevant files to understand the codebase
${
	hasSubagent
		? `2. **Launch up to 3 scout subagents IN PARALLEL** using the subagent tool to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files
   - Use multiple agents when: scope is uncertain, multiple areas are involved
   - Provide each agent with a specific search focus`
		: "2. Use read/grep/find/ls to explore the codebase"
}
3. After exploring, ask clarifying questions using plan_mode_question if needed

### Phase 2: Design
Goal: Design an implementation approach.

${
	hasSubagent
		? `Launch a planner subagent to design the implementation based on your exploration results.
- Provide comprehensive background context from Phase 1
- Request a detailed implementation plan`
		: "Design the approach based on your exploration."
}

### Phase 3: Review
Goal: Review the design and ensure alignment with the user's intentions.
1. Read critical files identified during exploration
2. Use plan_mode_question to clarify remaining questions
3. Do NOT make large assumptions about user intent

### Phase 4: Final Plan
Goal: Write your final plan to the plan file at \`${planPath}\`.
- Include: recommended approach, key files to modify, test/verification plan
- Be concise enough to scan quickly, but detailed enough to execute
- Include a verification section describing how to test changes

### Phase 5: Done
Once the plan file is complete, summarize what you've planned.
The user will read the plan file and exit Plan mode manually to begin implementation.

**Important:** Use plan_mode_question to clarify requirements. Do NOT ask "Is this plan okay?".
If you need more clarification, ask. If the plan is ready, just finish writing it.`;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function isBuiltinTool(tool: ToolInfo): boolean {
	return tool.sourceInfo.source === "builtin";
}

function isBuiltinToolByName(name: string, pi: ExtensionAPI): boolean {
	return getAllToolsSafe(pi).some((t) => t.name === name && isBuiltinTool(t));
}

function isBlockedBuiltinName(name: string, pi: ExtensionAPI): boolean {
	if (!BLOCKED_BUILTIN_TOOLS.has(name)) return false;
	const t = getAllToolsSafe(pi).find((c) => c.name === name);
	return t ? isBuiltinTool(t) : true;
}

function getAllToolsSafe(pi: ExtensionAPI): ToolInfo[] {
	try {
		return pi.getAllTools();
	} catch {
		return [];
	}
}

function getActiveToolsSafe(pi: ExtensionAPI): string[] {
	try {
		return pi.getActiveTools();
	} catch {
		return DEFAULT_TOOLS;
	}
}

function selectableTools(pi: ExtensionAPI): ToolInfo[] {
	const tools = getAllToolsSafe(pi);
	// De-duplicate by name (last wins for display purposes)
	const seen = new Map<string, ToolInfo>();
	for (const t of tools) {
		seen.set(t.name, t);
	}
	return Array.from(seen.values()).sort((a, b) => {
		const aB = isBuiltinTool(a);
		const bB = isBuiltinTool(b);
		if (aB !== bB) return aB ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

function formatToolChoice(tool: ToolInfo, selected: boolean, index: number): string {
	const marker = selected ? "[x]" : "[ ]";
	let policyLabel: string;
	if (isBuiltinTool(tool)) {
		policyLabel = SAFE_BUILTIN_PLAN_TOOLS.has(tool.name)
			? tool.name === "bash"
				? "built-in limited"
				: "built-in"
			: "built-in blocked";
	} else {
		const src = tool.sourceInfo;
		policyLabel = `user risk: ${src.scope}/${src.source}${src.path ? ` ${src.path}` : ""}`;
	}
	return `${marker} ${index + 1}. ${tool.name} (${policyLabel})`;
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}

// ─── Question helpers ───────────────────────────────────────────────────────

function normalizeQuestions(
	input: unknown,
): { ok: true; questions: PlanModeQuestion[] } | { ok: false; error: string } {
	if (!isRecord(input) || !Array.isArray(input.questions)) {
		return { ok: false, error: "questions must be an array" };
	}
	if (input.questions.length < 1 || input.questions.length > 3) {
		return { ok: false, error: "questions must contain 1-3 items" };
	}

	const questions: PlanModeQuestion[] = [];
	for (const [qi, raw] of input.questions.entries()) {
		if (!isRecord(raw)) return { ok: false, error: `question ${qi + 1} must be an object` };
		const id = strField(raw.id);
		const header = strField(raw.header);
		const question = strField(raw.question);
		if (!id || !header || !question) {
			return { ok: false, error: `question ${qi + 1} requires non-empty id, header, question` };
		}
		if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 4) {
			return { ok: false, error: `question ${qi + 1} options must contain 2-4 items` };
		}

		const options: PlanModeQuestionOption[] = [];
		for (const [oi, ro] of raw.options.entries()) {
			if (!isRecord(ro))
				return { ok: false, error: `question ${qi + 1} option ${oi + 1} must be an object` };
			const label = strField(ro.label);
			const desc = strField(ro.description);
			if (!label || !desc)
				return {
					ok: false,
					error: `question ${qi + 1} option ${oi + 1} requires label and description`,
				};
			options.push({ label, description: desc });
		}
		questions.push({ id, header, question, options });
	}
	return { ok: true, questions };
}

async function askQuestions(
	questions: PlanModeQuestion[],
	ctx: ExtensionContext,
): Promise<
	| Array<{ id: string; header: string; question: string; answer: string; wasCustom: boolean }>
	| undefined
> {
	const answers: Array<{
		id: string;
		header: string;
		question: string;
		answer: string;
		wasCustom: boolean;
	}> = [];
	for (const q of questions) {
		const choices = q.options.map((o, i) => `${i + 1}. ${o.label} — ${o.description}`);
		const other = `${q.options.length + 1}. Other (free-form)`;
		const choice = await ctx.ui.select(`${q.header}: ${q.question}`, [...choices, other]);
		if (!choice) return undefined;

		if (choice === other) {
			const custom = (await ctx.ui.editor(q.question, ""))?.trim();
			if (!custom) return undefined;
			answers.push({
				id: q.id,
				header: q.header,
				question: q.question,
				answer: custom,
				wasCustom: true,
			});
		} else {
			const idx = choices.indexOf(choice);
			const opt = q.options[idx];
			if (!opt) return undefined;
			answers.push({
				id: q.id,
				header: q.header,
				question: q.question,
				answer: opt.label,
				wasCustom: false,
			});
		}
	}
	return answers;
}

function questionAnswered(questions: PlanModeQuestion[], answers: unknown) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify({ cancelled: false, answers }, null, 2) },
		],
		details: { cancelled: false, questions, answers },
	};
}

function questionCancelled(
	questions: PlanModeQuestion[],
	reason: PlanModeQuestionReason,
	message: string,
) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({ cancelled: true, reason, message }, null, 2),
			},
		],
		details: { cancelled: true, reason, questions },
	};
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function strField(v: unknown): string | undefined {
	return typeof v === "string" ? v.trim() : undefined;
}
