import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFileAtomic(filePath, Buffer.from(content, "utf8"));
}

export async function writeFileAtomic(filePath: string, content: Buffer): Promise<void> {
  const dirPath = path.dirname(filePath);
  await ensureDir(dirPath);

  const tempPath = path.join(dirPath, `.tmp-${randomUUID()}`);
  await fs.writeFile(tempPath, content, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content) as T;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function resolveDefaultStorageDir(): string {
  return process.env.CODEX_SWITCH_HOME || path.join(os.homedir(), ".codex-switch");
}

export function resolveDefaultCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
