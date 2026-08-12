import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	formatResetDuration,
	formatUsageBar,
	formatUsageSummary,
	fetchGoUsage,
	type GoUsageReport,
	type GoUsageWindow,
} from "./go-usage.js";
import {
	manualKeyPath,
	authJsonPath,
	openCodeDbPath,
	piAuthJsonPath,
	readOpenCodeGoKey,
	removeManualKey,
	writeManualKey,
	type OpenCodeGoKey,
} from "./opencode-auth.js";

const COMMAND_NAME = "usage";
const ENTRY_TYPE = "opencode-go-usage";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Usage endpoint URL; can be overridden for testing/mirrors. */
export function usageUrl(): string {
	return process.env.OPENCODE_GO_USAGE_URL ?? "https://opencode.ai/zen/go/v1/usage";
}

/**
 * Resolve the OpenCode Go API key. Prefers the pi model registry (the key
 * saved by `pi /login`), then falls back to file-based lookups.
 */
async function resolveCredential(ctx: ExtensionCommandContext): Promise<OpenCodeGoKey | undefined> {
	try {
		const viaRegistry = await ctx.modelRegistry.getApiKeyForProvider("opencode-go");
		if (viaRegistry) {
			return { key: viaRegistry, source: "pi-login" };
		}
	} catch {
		// registry unavailable: fall through to file lookups
	}
	return readOpenCodeGoKey({
		piAuthFile: piAuthJsonPath(),
		authFile: authJsonPath(),
		dbFile: openCodeDbPath(),
		manualKeyFile: manualKeyPath(),
	});
}

export interface UsageArgs {
	/** Kept for compatibility; every /usage invocation fetches fresh usage. */
	refresh: boolean;
	timeoutMs: number;
	setKey?: string;
	clearKey: boolean;
}

export type ParseArgsResult =
	| { ok: true; value: UsageArgs }
	| { ok: false; error: string };

export function parseArgs(args: string): ParseArgsResult {
	const value: UsageArgs = {
		refresh: false,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		clearKey: false,
	};
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		switch (token) {
			case "--refresh":
				value.refresh = true;
				break;
			case "--clear-key":
				value.clearKey = true;
				break;
			case "--set-key": {
				const key = tokens[i + 1];
				if (!key) return { ok: false, error: "--set-key requires a key argument" };
				value.setKey = key;
				i += 1;
				break;
			}
			case "--timeout": {
				const raw = tokens[i + 1];
				const seconds = Number.parseFloat(raw ?? "");
				if (!Number.isFinite(seconds) || seconds <= 0) {
					return { ok: false, error: `--timeout requires a positive number, got "${raw}"` };
				}
				value.timeoutMs = Math.round(seconds * 1000);
				i += 1;
				break;
			}
			default:
				return { ok: false, error: `Unknown argument: ${token}` };
		}
	}
	return { ok: true, value };
}

const COMMAND_COMPLETIONS: readonly AutocompleteItem[] = [
	{ value: "--refresh", label: "--refresh", description: "Fetch fresh usage (default behavior)" },
	{ value: "--set-key ", label: "--set-key ", description: "Save an OpenCode Go API key" },
	{ value: "--clear-key", label: "--clear-key", description: "Clear the manually saved API key" },
	{ value: "--timeout ", label: "--timeout ", description: "Set query timeout in seconds" },
];

export function completeUsageArguments(prefix: string): AutocompleteItem[] | null {
	const items = COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
	return items.length > 0 ? items : null;
}

export interface UsageEntryData {
	report?: GoUsageReport;
	source?: string;
	error?: string;
}

function windowLine(
	label: string,
	window: GoUsageWindow | undefined,
	theme: Theme,
	expanded: boolean,
): string {
	const labelPad = label.padEnd(12);
	if (!window) {
		return `  ${theme.fg("dim", `${labelPad}  unavailable`)}`;
	}
	const barColor =
		window.status === "rate-limited" ? "error" : window.percent >= 85 ? "error" : window.percent >= 60 ? "warning" : "success";
	const bar = theme.fg(barColor, formatUsageBar(window.percent));
	const percent = theme.bold(`${Math.round(window.percent)}%`.padStart(4));
	const status =
		window.status === "rate-limited" ? ` ${theme.fg("error", "RATE LIMITED")}` : "";
	let line = `  ${theme.fg("muted", labelPad)}  ${bar}  ${percent}${status}`;
	if (window.resetsAt) {
		line += `  ${theme.fg("dim", `reset ${formatResetDuration(window.resetsAt)}`)}`;
	}
	if (expanded && window.resetsAt) {
		line += `\n     ${theme.fg("dim", `resetsAt ${window.resetsAt}`)}`;
	}
	return line;
}

export function renderUsageEntry(data: UsageEntryData, expanded: boolean, theme: Theme): Text {
	if (data.error) {
		return new Text(`${theme.fg("error", "OpenCode Go Usage")} ${theme.fg("dim", data.error)}`, 0, 0);
	}
	if (!data.report) {
		return new Text(theme.fg("error", "OpenCode Go Usage: no data"), 0, 0);
	}
	let text = `${theme.fg("accent", theme.bold("OpenCode Go Usage"))}`;
	text += ` ${theme.fg("dim", `via ${data.source ?? "unknown"}`)}`;
	text += `\n${windowLine("rolling 5h", data.report.rolling, theme, expanded)}`;
	text += `\n${windowLine("weekly 7d", data.report.weekly, theme, expanded)}`;
	text += `\n${windowLine("monthly 30d", data.report.monthly, theme, expanded)}`;
	if (data.report.useBalance) {
		text += `\n  ${theme.italic(theme.fg("dim", "falls back to Zen balance after Go quota exhaustion"))}`;
	}
	if (expanded) {
		text += `\n  ${theme.fg("dim", `captured ${new Date(data.report.capturedAt).toISOString()}`)}`;
	}
	return new Text(text, 0, 0);
}

export default function openCodeGoUsage(pi: ExtensionAPI) {
	const showReport = (report: GoUsageReport, source: string) => {
		pi.appendEntry(ENTRY_TYPE, { report, source } satisfies UsageEntryData);
	};

	pi.registerCommand(COMMAND_NAME, {
		description: "Show OpenCode Go subscription usage (rolling/weekly/monthly)",
		getArgumentCompletions: completeUsageArguments,
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			const options = parsed.value;

			if (options.setKey !== undefined) {
				await writeManualKey(manualKeyPath(), options.setKey);
				ctx.ui.notify("OpenCode Go API key saved.", "info");
				return;
			}

			if (options.clearKey) {
				await removeManualKey(manualKeyPath());
				ctx.ui.notify("Manual OpenCode Go API key cleared.", "info");
				return;
			}

			const credential = await resolveCredential(ctx);
			if (!credential) {
				const message =
					"No OpenCode Go key found. Run `opencode auth login`, set OPENCODE_API_KEY, or save one with /usage --set-key <key>";
				pi.appendEntry(ENTRY_TYPE, { error: message } satisfies UsageEntryData);
				ctx.ui.notify(message, "error");
				return;
			}

			const result = await fetchGoUsage(credential.key, {
				timeoutMs: options.timeoutMs,
				url: usageUrl(),
			});
			if (!result.ok) {
				const message =
					result.status === 401 || result.status === 403
						? `OpenCode Go usage unavailable (HTTP ${result.status}): the key may be invalid or the account has no Go plan`
						: `Failed to fetch OpenCode Go usage: ${result.message}`;
				pi.appendEntry(ENTRY_TYPE, { error: message } satisfies UsageEntryData);
				ctx.ui.notify(message, "error");
				return;
			}

			showReport(result.report, credential.source);
		},
	});

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, options, theme) => {
		return renderUsageEntry(entry.data as UsageEntryData, options.expanded, theme);
	});
}
