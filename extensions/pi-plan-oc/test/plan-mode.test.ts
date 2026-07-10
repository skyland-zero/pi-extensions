import assert from "node:assert/strict";
import test from "node:test";
import { builtinTool, createMockPi, extensionTool } from "../../../test/support.js";
import planModeOC, {
	canSelectToolInPlanMode,
	completePlanArgs,
	isSafeCommand,
	readCommand,
	withoutQuestionTool,
} from "../src/plan-mode.js";

const PLAN_COMMAND_COMPLETIONS = [
	{ value: "exit", label: "exit", description: "Leave Plan mode" },
	{ value: "off", label: "off", description: "Leave Plan mode" },
	{ value: "tools", label: "tools", description: "Select tools allowed in Plan mode" },
	{ value: "plan", label: "plan", description: "Show current plan file" },
];

test("plan-mode-oc registers flag, question tool, command, and safety hooks", () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planModeOC(mock.pi);

	assert.ok(mock.flags.has("plan"));
	assert.equal(mock.flags.get("plan")?.type, "boolean");
	assert.ok(mock.tools.some((t) => t.name === "plan_mode_question"));
	assert.ok(mock.commands.has("plan"));
	assert.ok(mock.events.has("tool_call"));
	assert.ok(mock.events.has("before_agent_start"));
});

test("completePlanArgs suggests management tokens only", () => {
	assert.deepEqual(
		completePlanArgs("", PLAN_COMMAND_COMPLETIONS)?.map((item) => item.label),
		["exit", "off", "tools", "plan"],
	);
	assert.deepEqual(
		completePlanArgs("to", PLAN_COMMAND_COMPLETIONS)?.map((item) => item.value),
		["tools"],
	);
	assert.deepEqual(
		completePlanArgs("pl", PLAN_COMMAND_COMPLETIONS)?.map((item) => item.value),
		["plan"],
	);
	assert.equal(completePlanArgs("tools ", PLAN_COMMAND_COMPLETIONS), null);
	assert.equal(completePlanArgs("unknown", PLAN_COMMAND_COMPLETIONS), null);
});

test("tool selection allows safe built-ins and non-built-ins only", () => {
	type PlanTool = Parameters<typeof canSelectToolInPlanMode>[0];
	assert.equal(canSelectToolInPlanMode(builtinTool("read") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(builtinTool("bash") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(builtinTool("grep") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(builtinTool("find") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(builtinTool("ls") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(builtinTool("edit") as PlanTool), false);
	assert.equal(canSelectToolInPlanMode(builtinTool("write") as PlanTool), false);
	assert.equal(canSelectToolInPlanMode(extensionTool("custom") as PlanTool), true);
});

test("isSafeCommand permits read-only and blocks mutating commands", () => {
	assert.equal(isSafeCommand("git status --short"), true);
	assert.equal(isSafeCommand("git diff HEAD~1"), true);
	assert.equal(isSafeCommand("cat file.ts"), true);
	assert.equal(isSafeCommand("grep -r foo src/"), true);
	assert.equal(isSafeCommand("sed -n '1,20p' file.ts"), true);
	assert.equal(isSafeCommand("rm -rf build"), false);
	assert.equal(isSafeCommand("npm install"), false);
	assert.equal(isSafeCommand("git commit -m 'fix'"), false);
	assert.equal(isSafeCommand("mv old new"), false);
	assert.equal(isSafeCommand(""), false);
	assert.equal(isSafeCommand("cat > file"), false);
});

test("withoutQuestionTool removes plan_mode_question", () => {
	assert.deepEqual(withoutQuestionTool(["read", "bash", "plan_mode_question", "subagent"]), [
		"read",
		"bash",
		"subagent",
	]);
	assert.deepEqual(withoutQuestionTool(["read", "bash"]), ["read", "bash"]);
});

test("readCommand extracts command from tool input", () => {
	assert.equal(readCommand({ command: "ls -la" }), "ls -la");
	assert.equal(readCommand({}), "");
	assert.equal(readCommand(undefined), "");
	assert.equal(readCommand(null), "");
});

test("session_start with --plan flag enters plan mode", () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	mock.flags.set("plan", { value: true });
	planModeOC(mock.pi);

	assert.ok(mock.events.has("session_start"), "session_start handler must be registered");
});
