import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PLANS_DIR = path.join(os.homedir(), ".pi", "plans");

export interface PlanFileInfo {
	filePath: string;
	relativePath: string;
	sessionName: string;
}

/**
 * Ensure the plans directory exists.
 */
function ensurePlansDir(): void {
	fs.mkdirSync(PLANS_DIR, { recursive: true });
}

/**
 * Create a new plan file for the given session name.
 * Returns the absolute file path.
 */
export function createPlanFile(sessionName?: string): PlanFileInfo {
	ensurePlansDir();
	const name = sessionName?.trim()
		? sessionName.replace(/[^a-zA-Z0-9_\-\s]/g, "_").replace(/\s+/g, "-")
		: `plan-${Date.now()}`;
	const filePath = path.join(PLANS_DIR, `${name}.md`);
	return {
		filePath,
		relativePath: path.relative(os.homedir(), filePath),
		sessionName: name,
	};
}

/**
 * Write content to a plan file. Creates parent directories if needed.
 */
export function writePlanToFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * Read content from a plan file.
 */
export function readPlanFromFile(filePath: string): string {
	return fs.readFileSync(filePath, "utf-8");
}

/**
 * Check if a plan file exists and has non-whitespace content.
 */
export function planFileHasContent(filePath: string): boolean {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return content.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * List all existing plan files, newest first.
 */
export function listPlanFiles(): PlanFileInfo[] {
	ensurePlansDir();
	const files = fs
		.readdirSync(PLANS_DIR)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const filePath = path.join(PLANS_DIR, f);
			const stat = fs.statSync(filePath);
			return {
				filePath,
				relativePath: path.relative(os.homedir(), filePath),
				sessionName: f.replace(/\.md$/, ""),
				mtimeMs: stat.mtimeMs,
			};
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return files;
}

/**
 * Delete a plan file.
 */
export function deletePlanFile(filePath: string): void {
	try {
		fs.unlinkSync(filePath);
	} catch {
		// File already gone, ignore
	}
}
