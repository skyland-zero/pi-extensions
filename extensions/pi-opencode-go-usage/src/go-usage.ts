/**
 * OpenCode Go usage client.
 *
 * Queries the official usage endpoint (GET /zen/go/v1/usage, added in
 * sst/opencode #16513) with the Bearer key stored by `opencode auth login`.
 * The response is parsed leniently so small upstream shape changes degrade
 * gracefully instead of breaking the extension.
 */

export const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const CACHE_TTL_MS = 5 * 60 * 1000;
export const BAR_SEGMENTS = 20;

export type UsageWindowStatus = "ok" | "rate-limited";

export interface GoUsageWindow {
	/** Usage percentage of the window, 0-100. */
	percent: number;
	/** Window status reported by the API. */
	status: UsageWindowStatus;
	/** ISO timestamp when the window resets, when reported. */
	resetsAt?: string;
}

export interface GoUsageReport {
	/** 5-hour rolling window. */
	rolling?: GoUsageWindow;
	/** 7-day weekly window. */
	weekly?: GoUsageWindow;
	/** 30-day monthly window. */
	monthly?: GoUsageWindow;
	/** Whether the account falls back to the Zen balance after Go quota exhaustion. */
	useBalance?: boolean;
	/** Epoch ms when the snapshot was captured. */
	capturedAt: number;
}

function parseWindow(raw: unknown): GoUsageWindow | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const obj = raw as Record<string, unknown>;
	const percentValue = obj.percent ?? obj.usagePercent ?? obj.usage_percent;
	const percent =
		typeof percentValue === "number" ? percentValue : Number.parseFloat(String(percentValue ?? ""));
	if (!Number.isFinite(percent) || percent < 0) return undefined;

	let resetsAt: string | undefined;
	const resetsAtValue = obj.resetsAt ?? obj.resetAt;
	if (typeof resetsAtValue === "string") {
		const ts = Date.parse(resetsAtValue);
		if (!Number.isNaN(ts)) resetsAt = new Date(ts).toISOString();
	}
	if (!resetsAt) {
		const resetInSecValue = obj.reset_in_sec ?? obj.resets_in_seconds;
		const resetInSec =
			typeof resetInSecValue === "number"
				? resetInSecValue
				: Number.parseFloat(String(resetInSecValue ?? ""));
		if (Number.isFinite(resetInSec) && resetInSec > 0) {
			resetsAt = new Date(Date.now() + resetInSec * 1000).toISOString();
		}
	}

	const status = obj.status === "rate-limited" ? "rate-limited" : "ok";
	return { percent: Math.min(Math.max(percent, 0), 100), status, resetsAt };
}

/**
 * Parse the usage endpoint response body leniently. Accepts
 * `{ usage: {...} }`, `{ windows: {...} }`, or flat fields.
 */
export function parseUsageBody(body: unknown): GoUsageReport {
	const capturedAt = Date.now();
	if (typeof body !== "object" || body === null) {
		return { capturedAt };
	}
	const source =
		(typeof (body as Record<string, unknown>).usage === "object" &&
		(body as Record<string, unknown>).usage !== null
			? (body as Record<string, unknown>).usage
			: undefined) ??
		(typeof (body as Record<string, unknown>).windows === "object" &&
		(body as Record<string, unknown>).windows !== null
			? (body as Record<string, unknown>).windows
			: undefined) ??
		body;
	const raw = source as Record<string, unknown>;
	const useBalance = (body as Record<string, unknown>).useBalance;
	return {
		rolling: parseWindow(raw.rolling),
		weekly: parseWindow(raw.weekly),
		monthly: parseWindow(raw.monthly),
		useBalance: typeof useBalance === "boolean" ? useBalance : undefined,
		capturedAt,
	};
}

export interface FetchUsageOptions {
	url?: string;
	timeoutMs?: number;
}

export interface FetchUsageResult {
	ok: true;
	report: GoUsageReport;
}

export interface FetchUsageFailure {
	ok: false;
	/** HTTP status when the endpoint responded, undefined on network/timeout errors. */
	status?: number;
	message: string;
}

/**
 * Fetch Go usage from the official endpoint.
 * A 401/403 response means the key is invalid or the account has no Go plan.
 */
export async function fetchGoUsage(
	apiKey: string,
	options: FetchUsageOptions = {},
): Promise<FetchUsageResult | FetchUsageFailure> {
	const url = options.url ?? GO_USAGE_URL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	try {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				message: `Go usage error: [${response.status}] ${response.statusText}`,
			};
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			return {
				ok: false,
				message: `Failed to parse usage response: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		return { ok: true, report: parseUsageBody(body) };
	} catch (error) {
		return {
			ok: false,
			message:
				error instanceof Error && error.name === "TimeoutError"
					? `Request timed out after ${timeoutMs}ms`
					: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Compact countdown for a reset time, e.g. "2H13M", "45M", "4D". */
export function formatResetDuration(resetsAt: string, now: number = Date.now()): string {
	const diffMs = new Date(resetsAt).getTime() - now;
	if (Number.isNaN(diffMs)) return "";
	const totalMinutes = Math.max(0, Math.ceil(diffMs / 60000));
	const days = Math.floor(totalMinutes / 1440);
	if (days > 0) return `${days}D`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) return `${hours}H${String(minutes).padStart(2, "0")}M`;
	return `${Math.max(minutes, 1)}M`;
}

/** ASCII progress bar, e.g. "████████░░░░░░░░░░░░" for 40%. */
export function formatUsageBar(percent: number, segments: number = BAR_SEGMENTS): string {
	const filled = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * segments);
	return `${"█".repeat(filled)}${"░".repeat(segments - filled)}`;
}

const WINDOW_LABELS: Array<{ key: "rolling" | "weekly" | "monthly"; label: string }> = [
	{ key: "rolling", label: "5h" },
	{ key: "weekly", label: "7d" },
	{ key: "monthly", label: "30d" },
];

/** One-line summary, e.g. "5h 65% · 7d 30% · 30d 12%". */
export function formatUsageSummary(report: GoUsageReport): string {
	const parts: string[] = [];
	for (const { key, label } of WINDOW_LABELS) {
		const window = report[key];
		if (window) parts.push(`${label} ${Math.round(window.percent)}%`);
	}
	return parts.join(" \u00b7 ");
}
