import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const AGENT_SCRIPT_PATH = fileURLToPath(new URL("./fake-loadable-acp-agent.mjs", import.meta.url));

export type AcpxSessionExports = {
  createSession: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  sendSession: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  closeSession: (sessionId: string) => Promise<Record<string, unknown>>;
  runSessionQueueOwner: (options: Record<string, unknown>) => Promise<void>;
};

export type AcpxQueueIpcExports = {
  probeQueueOwnerHealth: (sessionId: string) => Promise<{ healthy: boolean; hasLease: boolean }>;
  trySubmitToRunningOwner: (
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | undefined>;
};

export const DISCARD_ACPX_OUTPUT_FORMATTER = {
  setContext(_context: unknown) {},
  onAcpMessage(_message: unknown) {},
  onError(_params: unknown) {},
  flush() {},
};

function resolveAcpxDistDir(): string {
  const packageJsonPath = require.resolve("acpx/package.json");
  return path.join(path.dirname(packageJsonPath), "dist");
}

export async function loadAcpxSessionExports(): Promise<AcpxSessionExports> {
  const distDir = resolveAcpxDistDir();
  const sessionChunk = (await fs.readdir(distDir)).find((name) => /^session-.*\.js$/.test(name));
  if (!sessionChunk) {
    throw new Error(`Unable to locate acpx session chunk in ${distDir}`);
  }

  const moduleUrl = pathToFileURL(path.join(distDir, sessionChunk)).href;
  const imported = (await import(moduleUrl)) as { t?: AcpxSessionExports };
  if (!imported.t) {
    throw new Error(`acpx session exports missing from ${moduleUrl}`);
  }
  return imported.t;
}

export async function loadAcpxQueueIpcExports(): Promise<AcpxQueueIpcExports> {
  const distDir = resolveAcpxDistDir();
  const queueChunk = (await fs.readdir(distDir)).find((name) => /^queue-ipc-.*\.js$/.test(name));
  if (!queueChunk) {
    throw new Error(`Unable to locate acpx queue chunk in ${distDir}`);
  }

  const moduleUrl = pathToFileURL(path.join(distDir, queueChunk)).href;
  const imported = (await import(moduleUrl)) as { r?: AcpxQueueIpcExports };
  if (!imported.r) {
    throw new Error(`acpx queue exports missing from ${moduleUrl}`);
  }
  return imported.r;
}

export function createLoadableAcpAgentCommand(tempDir: string): {
  agentCommand: string;
  statePath: string;
  startedPath: string;
  releasePath: string;
  completedPath: string;
} {
  const statePath = path.join(tempDir, "fake-acp-state.json");
  const startedPath = path.join(tempDir, "fake-acp-started.json");
  const releasePath = path.join(tempDir, "fake-acp-release");
  const completedPath = path.join(tempDir, "fake-acp-completed.json");
  return {
    agentCommand: `${process.execPath} ${AGENT_SCRIPT_PATH} --state ${statePath} --started ${startedPath} --release ${releasePath} --completed ${completedPath}`,
    statePath,
    startedPath,
    releasePath,
    completedPath,
  };
}

export async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

export async function waitForJsonFile<T>(filePath: string, timeoutMs = 5_000): Promise<T> {
  await waitForCondition(() => existsSync(filePath), timeoutMs);
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

export async function readAcpxSessionRecord<T extends Record<string, unknown>>(
  homeDir: string,
  recordId: string,
): Promise<T> {
  const sessionPath = path.join(homeDir, ".acpx", "sessions", `${recordId}.json`);
  return JSON.parse(await fs.readFile(sessionPath, "utf8")) as T;
}

export function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
