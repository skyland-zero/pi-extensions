import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Locates the OpenCode Go API key used by `opencode auth login`.
 *
 * The opencode CLI stores login credentials in its XDG data directory
 * (auth.json in older versions, the `credential` table of opencode.db in
 * v1.18+). Both are read here. The key can also come from the
 * OPENCODE_API_KEY environment variable or from a manual key saved via
 * `/usage --set-key <key>`.
 */

export interface OpenCodeAuthEntry {
	/** Provider key from auth.json / credential row ("opencode-go" or "opencode"). */
	provider: string;
	/** Auth record type: api key, oauth token, or well-known token. */
	type: "api" | "oauth" | "wellknown";
	/** Bearer token usable against the OpenCode Go usage endpoint. */
	key: string;
}

export interface OpenCodeGoKey {
	key: string;
	source: "env" | "pi-login" | "pi-auth-json" | "auth-json" | "database" | "manual";
}

const PREFERRED_PROVIDER_ORDER = ["opencode-go", "opencode"] as const;

/** Whether this provider's key can authenticate the OpenCode Go usage endpoint. */
const isOpenCodeProvider = (provider: string) =>
	(PREFERRED_PROVIDER_ORDER as readonly string[]).includes(provider);

/** XDG data directory used by opencode, e.g. ~/.local/share/opencode. */
export function openCodeDataDir(
	options: {
		platform?: NodeJS.Platform;
		home?: string;
		env?: Record<string, string | undefined>;
	} = {},
): string {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	if (platform === "darwin") {
		return join(home, "Library", "Application Support", "opencode");
	}
	if (platform === "win32") {
		return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "opencode");
	}
	return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode");
}

export function authJsonPath(options: { dataDir?: string } = {}): string {
	const dataDir = options.dataDir ?? openCodeDataDir();
	return join(dataDir, "auth.json");
}

/**
 * Pi agent config directory (e.g. ~/.pi/agent, or $PI_AGENT_DIR when set).
 * This is where `pi /login` stores provider credentials in auth.json.
 */
export function piAgentDir(
	options: {
		env?: Record<string, string | undefined>;
		home?: string;
	} = {},
): string {
	const env = options.env ?? process.env;
	const envDir = env.PI_AGENT_DIR;
	if (envDir) return envDir;
	return join(options.home ?? homedir(), ".pi", "agent");
}

export function piAuthJsonPath(options: { agentDir?: string } = {}): string {
	return join(options.agentDir ?? piAgentDir(), "auth.json");
}

/**
 * Parse pi auth.json contents ({ providerId: { type: "api_key" | "oauth", key } })
 * into usable auth entries.
 */
export function parsePiAuthJson(content: string): OpenCodeAuthEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null) {
		return [];
	}
	const entries: OpenCodeAuthEntry[] = [];
	for (const provider of Object.keys(parsed as Record<string, unknown>)) {
		if (!isOpenCodeProvider(provider)) continue;
		const value = (parsed as Record<string, unknown>)[provider];
		if (typeof value !== "object" || value === null) continue;
		const record = value as Record<string, unknown>;
		const key = record.type === "api_key" || record.type === "oauth" ? record.key : undefined;
		if (typeof key !== "string" || key.length === 0) continue;
		entries.push({ provider, type: "api", key });
	}
	return entries;
}

/** Read auth entries from pi's auth.json (written by `pi /login`). */
export async function readPiAuthJson(authFile: string): Promise<OpenCodeAuthEntry[]> {
	try {
		return parsePiAuthJson(await readFile(authFile, "utf8"));
	} catch {
		return [];
	}
}

export function openCodeDbPath(options: { dataDir?: string } = {}): string {
	const dataDir = options.dataDir ?? openCodeDataDir();
	return join(dataDir, "opencode.db");
}

/**
 * Parse auth.json contents into usable auth entries.
 * Accepts both { provider: entry } maps and a bare entry object.
 */
export function parseAuthJson(content: string): OpenCodeAuthEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null) {
		return [];
	}
	if (isAuthEntry(parsed)) {
		const entry = toAuthEntry("opencode", parsed);
		return entry ? [entry] : [];
	}
	const entries: OpenCodeAuthEntry[] = [];
	for (const provider of Object.keys(parsed as Record<string, unknown>)) {
		if (!isOpenCodeProvider(provider)) continue;
		const value = (parsed as Record<string, unknown>)[provider];
		if (!isAuthEntry(value)) continue;
		const entry = toAuthEntry(provider, value);
		if (entry) entries.push(entry);
	}
	return entries.sort(
		(a, b) =>
			PREFERRED_PROVIDER_ORDER.indexOf(a.provider as (typeof PREFERRED_PROVIDER_ORDER)[number]) -
			PREFERRED_PROVIDER_ORDER.indexOf(b.provider as (typeof PREFERRED_PROVIDER_ORDER)[number]),
	);
}

function isAuthEntry(value: unknown): value is Record<string, unknown> {
	// An auth entry carries a `type` discriminator ("api" | "oauth" | "wellknown");
	// a provider map does not.
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>).type === "string"
	);
}

function toAuthEntry(provider: string, value: Record<string, unknown>): OpenCodeAuthEntry | undefined {
	const type = value.type;
	const key =
		type === "api"
			? value.key
			: type === "oauth"
				? value.access
				: type === "wellknown"
					? value.token
					: undefined;
	if (typeof key !== "string" || key.length === 0) return undefined;
	return { provider, type: type as OpenCodeAuthEntry["type"], key };
}

/** Read auth entries from the opencode auth.json file. */
export async function readAuthJson(authFile: string): Promise<OpenCodeAuthEntry[]> {
	try {
		const content = await readFile(authFile, "utf8");
		return parseAuthJson(content);
	} catch {
		return [];
	}
}

/**
 * Read credentials from the opencode.db `credential` table (v1.18+).
 * Uses node:sqlite read-only; any failure (old Node, WAL without shm,
 * missing table) degrades silently to no entries.
 */
export async function readDatabaseCredentials(dbFile: string): Promise<OpenCodeAuthEntry[]> {
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbFile, { readOnly: true });
		try {
			const rows = db
				.prepare(
					`SELECT integration_id, value, active FROM credential
					 WHERE integration_id = ? ORDER BY active DESC, rowid ASC`,
				)
				.all("opencode") as Array<{ integration_id?: unknown; value: unknown; active?: unknown }>;
			const entries: OpenCodeAuthEntry[] = [];
			for (const row of rows) {
				const parsed = parseCredentialValue(row.value);
				if (parsed) entries.push(parsed);
			}
			return entries;
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}

function parseCredentialValue(value: unknown): OpenCodeAuthEntry | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const type = record.type;
	const key = type === "api" ? record.key : type === "oauth" ? record.access : undefined;
	if (typeof key !== "string" || key.length === 0) return undefined;
	return { provider: "opencode", type: type as OpenCodeAuthEntry["type"], key };
}

/** Path of the manually saved key (fallback when no login credentials exist). */
export function manualKeyPath(options: { dataDir?: string } = {}): string {
	const dataDir = options.dataDir ?? openCodeDataDir();
	return join(dataDir, "pi-opencode-go-usage.json");
}

export async function readManualKey(keyFile: string): Promise<string | undefined> {
	try {
		const parsed = JSON.parse(await readFile(keyFile, "utf8")) as { key?: unknown };
		return typeof parsed.key === "string" && parsed.key.length > 0 ? parsed.key : undefined;
	} catch {
		return undefined;
	}
}

export async function writeManualKey(keyFile: string, key: string): Promise<void> {
	await mkdir(dirname(keyFile), { recursive: true });
	await writeFile(keyFile, `${JSON.stringify({ key }, null, 2)}\n`, { mode: 0o600 });
	await chmod(keyFile, 0o600);
}

export async function removeManualKey(keyFile: string): Promise<void> {
	try {
		await writeManualKey(keyFile, "");
	} catch {
		// best-effort clear
	}
}

/**
 * Resolve the OpenCode Go API key, trying (in order): the pi model
 * registry (key saved by `pi /login`), pi's auth.json, the opencode CLI
 * auth.json, the opencode.db credential table, the OPENCODE_API_KEY env
 * var, then the manually saved key.
 */
export async function readOpenCodeGoKey(
	options: {
		piAuthFile?: string;
		authFile?: string;
		dbFile?: string;
		manualKeyFile?: string;
		env?: Record<string, string | undefined>;
	} = {},
): Promise<OpenCodeGoKey | undefined> {
	const env = options.env ?? process.env;
	const envKey = env.OPENCODE_API_KEY;
	if (typeof envKey === "string" && envKey.length > 0) {
		return { key: envKey, source: "env" };
	}

	const piAuthFile = options.piAuthFile ?? piAuthJsonPath();
	const piEntries = await readPiAuthJson(piAuthFile);
	const piEntry = piEntries.find((entry) => entry.key.length > 0);
	if (piEntry) {
		return { key: piEntry.key, source: "pi-auth-json" };
	}

	const authFile = options.authFile ?? authJsonPath();
	const authEntries = await readAuthJson(authFile);
	const authEntry = authEntries.find((entry) => entry.key.length > 0);
	if (authEntry) {
		return { key: authEntry.key, source: "auth-json" };
	}

	const dbFile = options.dbFile ?? openCodeDbPath();
	const dbEntries = await readDatabaseCredentials(dbFile);
	const dbEntry = dbEntries.find((entry) => entry.key.length > 0);
	if (dbEntry) {
		return { key: dbEntry.key, source: "database" };
	}

	const keyFile = options.manualKeyFile ?? manualKeyPath();
	const manualKey = await readManualKey(keyFile);
	if (manualKey) {
		return { key: manualKey, source: "manual" };
	}

	return undefined;
}
