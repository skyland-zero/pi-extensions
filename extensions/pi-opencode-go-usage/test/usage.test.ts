import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
	fetchGoUsage,
	formatResetDuration,
	formatUsageBar,
	formatUsageSummary,
	parseUsageBody,
} from "../src/go-usage.js";
import {
	manualKeyPath,
	openCodeDataDir,
	parseAuthJson,
	parsePiAuthJson,
	piAgentDir,
	readManualKey,
	readOpenCodeGoKey,
	writeManualKey,
} from "../src/opencode-auth.js";
import openCodeGoUsage, {
	parseArgs,
	renderUsageEntry,
	type UsageEntryData,
	usageUrl,
} from "../src/usage.js";

test("usage registers command and entry renderer", () => {
	const mock = createMockPi();
	openCodeGoUsage(mock.pi);

	assert.ok(mock.commands.has("usage"));
	const command = mock.commands.get("usage");
	assert.equal(typeof command?.getArgumentCompletions, "function");
	assert.deepEqual([...mock.events.keys()], []);
});

test("parseArgs accepts all options", () => {
	assert.deepEqual(parseArgs(""), {
		ok: true,
		value: { refresh: false, timeoutMs: 10000, clearKey: false },
	});
	assert.deepEqual(parseArgs("--refresh"), {
		ok: true,
		value: { refresh: true, timeoutMs: 10000, clearKey: false },
	});
	assert.deepEqual(parseArgs("--timeout 3"), {
		ok: true,
		value: { refresh: false, timeoutMs: 3000, clearKey: false },
	});
	assert.deepEqual(parseArgs("--set-key sk-test"), {
		ok: true,
		value: { refresh: false, timeoutMs: 10000, setKey: "sk-test", clearKey: false },
	});
});

test("parseArgs rejects unknown arguments and bad values", () => {
	assert.equal(parseArgs("--bogus").ok, false);
	assert.equal(parseArgs("--set-key").ok, false);
	assert.equal(parseArgs("--timeout abc").ok, false);
});

test("parseAuthJson extracts entries and prefers opencode-go", () => {
	const entries = parseAuthJson(
		JSON.stringify({
			opencode: { type: "oauth", access: "token-a", refresh: "r", expires: 1 },
			"opencode-go": { type: "api", key: "key-b" },
			anthropic: { type: "api", key: "ignored" },
		}),
	);
	assert.deepEqual(
		entries.map((e) => [e.provider, e.key]),
		[
			["opencode-go", "key-b"],
			["opencode", "token-a"],
		],
	);
});

test("parseAuthJson handles wellknown, invalid, and empty input", () => {
	assert.deepEqual(
		parseAuthJson(JSON.stringify({ opencode: { type: "wellknown", token: "wk" } })).map(
			(e) => e.key,
		),
		["wk"],
	);
	assert.deepEqual(parseAuthJson(JSON.stringify({ opencode: { type: "api", key: "" } })), []);
	assert.deepEqual(parseAuthJson("not json"), []);
	assert.deepEqual(parseAuthJson("42"), []);
});

test("parsePiAuthJson reads keys written by pi /login", () => {
	const entries = parsePiAuthJson(
		JSON.stringify({
			"opencode-go": { type: "api_key", key: "sk-pi-login" },
			opencode: { type: "oauth", key: "token-oauth" },
			anthropic: { type: "api_key", key: "ignored" },
		}),
	);
	assert.deepEqual(
		entries.map((e) => [e.provider, e.key]),
		[
			["opencode-go", "sk-pi-login"],
			["opencode", "token-oauth"],
		],
	);
	assert.deepEqual(parsePiAuthJson("not json"), []);
	assert.deepEqual(
		parsePiAuthJson(JSON.stringify({ "opencode-go": { type: "api_key", key: "" } })),
		[],
	);
});

test("piAgentDir honors PI_AGENT_DIR and defaults to ~/.pi/agent", () => {
	assert.equal(piAgentDir({ home: "/home/u", env: {} }), "/home/u/.pi/agent");
	assert.equal(
		piAgentDir({ home: "/home/u", env: { PI_AGENT_DIR: "/custom/agent" } }),
		"/custom/agent",
	);
});

test("readOpenCodeGoKey prefers pi auth.json over opencode auth.json", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-og-usage-"));
	try {
		const piAuthFile = path.join(dir, "pi-auth.json");
		const authFile = path.join(dir, "opencode-auth.json");
		await writeFile(
			piAuthFile,
			JSON.stringify({ "opencode-go": { type: "api_key", key: "from-pi" } }),
		);
		await writeFile(authFile, JSON.stringify({ "opencode-go": { type: "api", key: "from-cli" } }));

		assert.deepEqual(
			await readOpenCodeGoKey({ piAuthFile, authFile, manualKeyFile: path.join(dir, "m.json") }),
			{ key: "from-pi", source: "pi-auth-json" },
		);
		await rm(piAuthFile);
		assert.deepEqual(
			await readOpenCodeGoKey({ piAuthFile, authFile, manualKeyFile: path.join(dir, "m.json") }),
			{ key: "from-cli", source: "auth-json" },
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("usageUrl defaults to the official endpoint", () => {
	assert.equal(usageUrl(), "https://opencode.ai/zen/go/v1/usage");
});

test("handler uses the pi /login key from modelRegistry and renders usage", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-og-usage-"));
	const previousXdg = process.env.XDG_DATA_HOME;
	const previousUrl = process.env.OPENCODE_GO_USAGE_URL;
	let receivedAuth: string | undefined;
	let requestCount = 0;
	const server: Server = createServer((req, res) => {
		requestCount += 1;
		receivedAuth = req.headers.authorization;
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify({
				usage: { weekly: { status: "ok", percent: 33, resetsAt: "2099-01-01T00:00:00.000Z" } },
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.XDG_DATA_HOME = dir;
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		process.env.OPENCODE_GO_USAGE_URL = `http://127.0.0.1:${address.port}/zen/go/v1/usage`;

		const mock = createMockPi();
		openCodeGoUsage(mock.pi);
		const ctx = createMockContext({
			modelRegistry: { getApiKeyForProvider: async () => "sk-pi-login" },
		});

		await mock.commands.get("usage")?.handler("", ctx.ctx);
		// Every /usage invocation fetches fresh usage; no caching.
		await mock.commands.get("usage")?.handler("", ctx.ctx);

		assert.equal(requestCount, 2);
		assert.equal(receivedAuth, "Bearer sk-pi-login");
		assert.equal(mock.sentMessages.length, 0);
		assert.equal(mock.entries.length, 2);
		const data = mock.entries[0]?.data as UsageEntryData;
		assert.equal(data.source, "pi-login");
		assert.equal(data.report?.weekly?.percent, 33);
		assert.equal(ctx.notifications.length, 0);
	} finally {
		if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previousXdg;
		if (previousUrl === undefined) delete process.env.OPENCODE_GO_USAGE_URL;
		else process.env.OPENCODE_GO_USAGE_URL = previousUrl;
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await rm(dir, { recursive: true, force: true });
	}
});

test("openCodeDataDir resolves platform data directories", () => {
	const env = { XDG_DATA_HOME: "/xdg" };
	assert.equal(openCodeDataDir({ platform: "linux", home: "/home/u", env }), "/xdg/opencode");
	assert.equal(
		openCodeDataDir({ platform: "darwin", home: "/Users/u", env }),
		"/Users/u/Library/Application Support/opencode",
	);
	assert.equal(
		openCodeDataDir({
			platform: "win32",
			home: "C:\\Users\\u",
			env: { LOCALAPPDATA: "C:\\AppData" },
		}),
		path.join("C:\\AppData", "opencode"),
	);
});

test("readOpenCodeGoKey prefers env, then auth.json, then manual key", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-og-usage-"));
	try {
		const authFile = path.join(dir, "auth.json");
		const keyFile = path.join(dir, "manual.json");
		const piAuthFile = path.join(dir, "no-pi-auth.json");
		await writeFile(authFile, JSON.stringify({ "opencode-go": { type: "api", key: "from-auth" } }));

		assert.deepEqual(
			await readOpenCodeGoKey({
				piAuthFile,
				authFile,
				manualKeyFile: keyFile,
				env: { OPENCODE_API_KEY: "from-env" },
			}),
			{ key: "from-env", source: "env" },
		);
		assert.deepEqual(await readOpenCodeGoKey({ piAuthFile, authFile, manualKeyFile: keyFile }), {
			key: "from-auth",
			source: "auth-json",
		});

		await rm(authFile);
		await writeManualKey(keyFile, "from-manual");
		assert.deepEqual(await readOpenCodeGoKey({ piAuthFile, authFile, manualKeyFile: keyFile }), {
			key: "from-manual",
			source: "manual",
		});
		// A missing opencode.db must not break resolution; it falls back to the manual key.
		assert.deepEqual(
			await readOpenCodeGoKey({
				piAuthFile,
				authFile,
				manualKeyFile: keyFile,
				dbFile: path.join(dir, "missing.db"),
			}),
			{ key: "from-manual", source: "manual" },
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("writeManualKey and readManualKey round-trip", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-og-usage-"));
	try {
		const keyFile = path.join(dir, "manual.json");
		assert.equal(await readManualKey(keyFile), undefined);
		await writeManualKey(keyFile, "sk-secret");
		assert.equal(await readManualKey(keyFile), "sk-secret");
		assert.equal(manualKeyPath({ dataDir: dir }), path.join(dir, "pi-opencode-go-usage.json"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("parseUsageBody accepts nested, flat, and lenient field variants", () => {
	const nested = parseUsageBody({
		usage: {
			rolling: { status: "ok", percent: 65, resetsAt: "2099-01-01T00:00:00.000Z" },
			weekly: { status: "ok", usagePercent: 30, resetAt: "2099-01-02T00:00:00.000Z" },
			monthly: { status: "rate-limited", usage_percent: 12, reset_in_sec: 3600 },
		},
		useBalance: true,
	});
	assert.equal(nested.rolling?.percent, 65);
	assert.equal(nested.weekly?.percent, 30);
	assert.equal(nested.monthly?.status, "rate-limited");
	const resetInSec = (Date.parse(nested.monthly?.resetsAt ?? "") - Date.now()) / 1000;
	assert.ok(
		Math.abs(resetInSec - 3600) < 5,
		`resetsAt should be ~1h from now, got ${nested.monthly?.resetsAt}`,
	);
	assert.equal(nested.useBalance, true);
	assert.equal(parseUsageBody(null).rolling, undefined);
});

test("fetchGoUsage sends the bearer key and parses the response", async () => {
	let receivedAuth: string | undefined;
	const server: Server = createServer((req, res) => {
		receivedAuth = req.headers.authorization;
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify({
				usage: { rolling: { status: "ok", percent: 41, resetsAt: "2099-01-01T00:00:00.000Z" } },
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const url = `http://127.0.0.1:${address.port}/zen/go/v1/usage`;
		const result = await fetchGoUsage("sk-test", { url });
		assert.equal(receivedAuth, "Bearer sk-test");
		assert.ok(result.ok);
		if (result.ok) {
			assert.equal(result.report.rolling?.percent, 41);
			assert.equal(result.report.rolling?.status, "ok");
		}
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

test("fetchGoUsage reports HTTP errors", async () => {
	const server: Server = createServer((_req, res) => {
		res.statusCode = 401;
		res.end("unauthorized");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const result = await fetchGoUsage("sk-bad", { url: `http://127.0.0.1:${address.port}/usage` });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.status, 401);
		}
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

test("formatUsageBar renders segments", () => {
	assert.equal(formatUsageBar(0, 4), "░░░░");
	assert.equal(formatUsageBar(50, 4), "██░░");
	assert.equal(formatUsageBar(100, 4), "████");
	assert.equal(formatUsageBar(150, 4), "████");
	assert.equal(formatUsageBar(-5, 4), "░░░░");
});

test("formatResetDuration renders countdown", () => {
	const now = Date.parse("2026-01-01T00:00:00Z");
	assert.equal(formatResetDuration("2026-01-05T09:00:00Z", now), "4D");
	assert.equal(formatResetDuration("2026-01-01T02:30:00Z", now), "2H30M");
	assert.equal(formatResetDuration("2026-01-01T00:45:00Z", now), "45M");
	assert.equal(formatResetDuration("2026-01-01T00:00:10Z", now), "1M");
	assert.equal(formatResetDuration("invalid", now), "");
});

test("formatUsageSummary joins windows", () => {
	const report = {
		rolling: { percent: 65, status: "ok" as const },
		weekly: { percent: 30, status: "ok" as const },
		capturedAt: Date.now(),
	};
	assert.equal(formatUsageSummary(report), "5h 65% · 7d 30%");
});

test("renderUsageEntry renders windows and rate-limited state", () => {
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		dim: (text: string) => text,
		italic: (text: string) => text,
	};
	const data: UsageEntryData = {
		report: {
			rolling: { percent: 65, status: "ok", resetsAt: "2099-01-01T00:00:00.000Z" },
			monthly: { percent: 12, status: "rate-limited" },
			capturedAt: Date.now(),
		},
		source: "auth-json",
	};
	const text = renderUsageEntry(data, false, theme as never)
		.render(120)
		.join("\n");
	assert.match(text, /OpenCode Go Usage/);
	assert.match(text, /rolling 5h/);
	assert.match(text, /65%/);
	assert.match(text, /RATE LIMITED/);
	assert.match(text, /via auth-json/);
});

test("handler reports no-key state without sending messages", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-og-usage-"));
	const previousXdg = process.env.XDG_DATA_HOME;
	const previousPiAgentDir = process.env.PI_AGENT_DIR;
	process.env.XDG_DATA_HOME = dir;
	process.env.PI_AGENT_DIR = path.join(dir, "pi-agent");
	try {
		const mock = createMockPi();
		openCodeGoUsage(mock.pi);
		const ctx = createMockContext();
		const command = mock.commands.get("usage");

		await command?.handler("", ctx.ctx);

		assert.equal(mock.sentMessages.length, 0);
		assert.equal(mock.sentUserMessages.length, 0);
		assert.equal(mock.entries.length, 1);
		assert.equal(mock.entries[0]?.customType, "opencode-go-usage");
		assert.match(
			String((mock.entries[0]?.data as { error?: string })?.error ?? ""),
			/No OpenCode Go key found/,
		);
		assert.equal(ctx.notifications.length, 1);
	} finally {
		if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previousXdg;
		if (previousPiAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previousPiAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
});
