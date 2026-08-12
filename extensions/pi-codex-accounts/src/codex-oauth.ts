import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";

/**
 * Local stand-ins for APIs removed from pi 0.84:
 *
 * - `AuthStorageBackend` / `FileAuthStorageBackend` (were exported from
 *   @earendil-works/pi-coding-agent, now internal).
 * - `openaiCodexOAuthProvider` (was exported from @earendil-works/pi-ai/oauth,
 *   removed). Reimplemented here as a device-code-only Codex OAuth flow,
 *   ported from the pi-ai 0.80.3 implementation.
 */

// ── Auth storage backend ────────────────────────────────────────────────────

export interface LockResult<T> {
	result: T;
	next?: string;
}

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

/**
 * Minimal JSON-file auth storage backend with process-local serialization.
 * pi is single-process, so no cross-process file locking is needed.
 */
export class FileAuthStorageBackend implements AuthStorageBackend {
	private readonly authPath: string;
	private pendingWrite: Promise<void> = Promise.resolve();

	constructor(authPath: string) {
		this.authPath = authPath;
	}

	private readCurrent(): string | undefined {
		try {
			return readFileSync(this.authPath, "utf8");
		} catch {
			return undefined;
		}
	}

	private writeNext(next: string): void {
		mkdirSync(dirname(this.authPath), { recursive: true });
		writeFileSync(this.authPath, next, { mode: 0o600 });
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const result = fn(this.readCurrent());
		if (result.next !== undefined) this.writeNext(result.next);
		return result.result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const run = this.pendingWrite.then(async () => {
			const result = await fn(this.readCurrent());
			if (result.next !== undefined) this.writeNext(result.next);
			return result.result;
		});
		// Serialize writes; keep the promise chain alive but swallow errors here.
		this.pendingWrite = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

/**
 * In-memory auth storage backend for tests.
 */
export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private asyncChain: Promise<void> = Promise.resolve();

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const result = fn(this.value);
		if (result.next !== undefined) this.value = result.next;
		return result.result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const run = this.asyncChain.then(async () => {
			const result = await fn(this.value);
			if (result.next !== undefined) this.value = result.next;
			return result.result;
		});
		this.asyncChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

// ── Codex OAuth provider (device code flow) ─────────────────────────────────

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const MINIMUM_INTERVAL_MS = 1000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

export type CodexOAuthProvider = {
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
};

type DeviceAuthInfo = {
	deviceAuthId: string;
	userCode: string;
	intervalSeconds: number;
};

async function fetchWithLoginCancellation(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	try {
		return await fetch(input, init);
	} catch (error) {
		if (init?.signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}
}

async function readTokenResponse(response: Response, operation: string): Promise<OAuthCredentials> {
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`OpenAI Codex token ${operation} failed (${response.status}): ${text || response.statusText}`,
		);
	}
	const json = (await response.json()) as {
		access_token?: unknown;
		refresh_token?: unknown;
		expires_in?: unknown;
	};
	if (
		typeof json.access_token !== "string" ||
		typeof json.refresh_token !== "string" ||
		typeof json.expires_in !== "number"
	) {
		throw new Error(`OpenAI Codex token ${operation} response missing fields: ${JSON.stringify(json)}`);
	}
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

async function startDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthInfo> {
	const response = await fetchWithLoginCancellation(DEVICE_USER_CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
		signal,
	});
	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(
				"OpenAI Codex device code login is not enabled for this server. Verify the server URL.",
			);
		}
		const responseBody = await response.text().catch(() => "");
		throw new Error(
			`OpenAI Codex device code request failed with status ${response.status}${
				responseBody ? `: ${responseBody}` : ""
			}`,
		);
	}
	const json = (await response.json()) as {
		device_auth_id?: unknown;
		user_code?: unknown;
		interval?: unknown;
	};
	const intervalSeconds =
		typeof json.interval === "string" ? Number(json.interval.trim()) : json.interval;
	if (
		typeof json.device_auth_id !== "string" ||
		typeof json.user_code !== "string" ||
		typeof intervalSeconds !== "number" ||
		!Number.isFinite(intervalSeconds) ||
		intervalSeconds < 0
	) {
		throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`);
	}
	return {
		deviceAuthId: json.device_auth_id,
		userCode: json.user_code,
		intervalSeconds,
	};
}

async function pollDeviceAuth(
	device: DeviceAuthInfo,
	signal?: AbortSignal,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
	const deadline = Date.now() + DEVICE_CODE_TIMEOUT_SECONDS * 1000;
	let intervalMs = Math.max(MINIMUM_INTERVAL_MS, device.intervalSeconds * 1000);
	let slowDownResponses = 0;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Login cancelled");
		const response = await fetchWithLoginCancellation(DEVICE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
			signal,
		});
		if (response.ok) {
			const json = (await response.json()) as {
				authorization_code?: unknown;
				code_verifier?: unknown;
			};
			if (typeof json.authorization_code !== "string" || typeof json.code_verifier !== "string") {
				throw new Error(`Invalid OpenAI Codex device auth token response: ${JSON.stringify(json)}`);
			}
			return { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier };
		}
		if (response.status === 403 || response.status === 404) {
			// still pending
		} else {
			const responseBody = await response.text().catch(() => "");
			let errorCode: unknown;
			try {
				const parsed = JSON.parse(responseBody) as { error?: { code?: unknown } | unknown };
				const error = parsed.error;
				errorCode = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : error;
			} catch {
				// not JSON
			}
			if (errorCode === "deviceauth_authorization_pending") {
				// still pending
			} else if (errorCode === "slow_down") {
				slowDownResponses += 1;
				intervalMs += SLOW_DOWN_INTERVAL_INCREMENT_MS;
			} else {
				throw new Error(
					`OpenAI Codex device auth failed with status ${response.status}${
						responseBody ? `: ${responseBody}` : ""
					}`,
				);
			}
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		await abortableSleep(Math.min(intervalMs, remainingMs), signal);
	}
	throw new Error(
		slowDownResponses > 0
			? "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again."
			: "Device flow timed out",
	);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Login cancelled"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function exchangeAuthorizationCode(
	authorizationCode: string,
	codeVerifier: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const response = await fetchWithLoginCancellation(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: authorizationCode,
			code_verifier: codeVerifier,
			redirect_uri: "http://localhost:1455/auth/callback",
		}),
		signal,
	});
	return readTokenResponse(response, "exchange");
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthCredentials> {
	let response: Response;
	try {
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		});
	} catch (error) {
		throw new Error(
			`OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return readTokenResponse(response, "refresh");
}

/**
 * Codex OAuth provider using the device-code flow (headless-friendly).
 * Ported from the pi-ai 0.80.3 `openaiCodexOAuthProvider` implementation.
 */
export const openaiCodexOAuthProvider: CodexOAuthProvider = {
	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		const device = await startDeviceAuth(callbacks.signal);
		callbacks.onDeviceCode?.({
			userCode: device.userCode,
			verificationUri: DEVICE_VERIFICATION_URI,
			intervalSeconds: device.intervalSeconds,
		});
		callbacks.onProgress?.("Waiting for Codex login to complete...");
		const { authorizationCode, codeVerifier } = await pollDeviceAuth(device, callbacks.signal);
		return exchangeAuthorizationCode(authorizationCode, codeVerifier, callbacks.signal);
	},
	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshAccessToken(credentials.refresh);
	},
	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
