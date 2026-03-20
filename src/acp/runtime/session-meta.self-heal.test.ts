import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions.js";
import { ensureAcpSessionTranscript, upsertAcpSessionMeta } from "./session-meta.js";

const tempDirs: string[] = [];

function createFixture(): { cfg: OpenClawConfig; storePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-acp-session-meta-"));
  tempDirs.push(root);
  const storePath = path.join(root, "sessions.json");
  fs.writeFileSync(storePath, "{}\n", "utf-8");
  return {
    cfg: {
      session: {
        store: storePath,
      },
    } as OpenClawConfig,
    storePath,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ACP session transcript self-heal", () => {
  it("creates a transcript file and header when ACP metadata is first persisted", async () => {
    const { cfg, storePath } = createFixture();
    const sessionKey = "agent:codex:acp:binding:discord:default:heal-new";

    const persisted = await upsertAcpSessionMeta({
      cfg,
      sessionKey,
      mutate: () => ({
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:new",
        mode: "persistent",
        runtimeOptions: {
          cwd: "/workspace/heal-new",
        },
        state: "idle",
        lastActivityAt: 123,
      }),
    });

    expect(persisted?.sessionFile).toBeTruthy();
    expect(typeof persisted?.sessionId).toBe("string");
    expect(fs.existsSync(String(persisted?.sessionFile))).toBe(true);

    const lines = fs.readFileSync(String(persisted?.sessionFile), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      type: "session",
      id: persisted?.sessionId,
      cwd: "/workspace/heal-new",
    });

    const stored = loadSessionStore(storePath, { skipCache: true });
    expect(stored[sessionKey]?.sessionFile).toBe(persisted?.sessionFile);
  });

  it("recreates a missing transcript header for an existing ACP session entry", async () => {
    const { cfg, storePath } = createFixture();
    const sessionKey = "agent:codex:acp:binding:discord:default:heal-existing";
    const missingTranscript = path.join(path.dirname(storePath), "ghost.jsonl");

    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: "session-existing",
            updatedAt: Date.now(),
            sessionFile: missingTranscript,
            acp: {
              backend: "acpx",
              agent: "codex",
              runtimeSessionName: "runtime:existing",
              mode: "persistent",
              runtimeOptions: {
                cwd: "/workspace/heal-existing",
              },
              state: "idle",
              lastActivityAt: Date.now(),
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const healed = await ensureAcpSessionTranscript({
      cfg,
      sessionKey,
    });

    expect(healed?.sessionFile).toBe(missingTranscript);
    expect(fs.existsSync(missingTranscript)).toBe(true);

    const lines = fs.readFileSync(missingTranscript, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      type: "session",
      id: "session-existing",
      cwd: "/workspace/heal-existing",
    });
  });
});
