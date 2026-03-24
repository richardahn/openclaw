#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

function parseArgs(argv) {
  const args = {
    state: undefined,
    started: undefined,
    release: undefined,
    completed: undefined,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--state") {
      args.state = next;
      index += 1;
    } else if (token === "--started") {
      args.started = next;
      index += 1;
    } else if (token === "--release") {
      args.release = next;
      index += 1;
    } else if (token === "--completed") {
      args.completed = next;
      index += 1;
    }
  }
  if (!args.state || !args.started || !args.release || !args.completed) {
    throw new Error("Missing required agent fixture paths");
  }
  return args;
}

async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readState(statePath) {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { sessions: {} };
    }
    throw error;
  }
}

async function writeState(statePath, state) {
  await ensureParent(statePath);
  await fs.writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
}

async function waitForRelease(releasePath, signal) {
  const startedAt = Date.now();
  while (true) {
    if (signal.aborted) {
      throw new Error("cancelled");
    }
    try {
      await fs.access(releasePath);
      return;
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (Date.now() - startedAt > 15_000) {
      throw new Error(`Timed out waiting for release file ${releasePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function promptTextFromInput(prompt) {
  if (!Array.isArray(prompt)) {
    return "";
  }
  return prompt
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

class LoadableAgent {
  constructor(connection, paths) {
    this.connection = connection;
    this.paths = paths;
    this.pendingPrompts = new Map();
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
      },
    };
  }

  async authenticate() {
    return {};
  }

  async newSession() {
    const state = await readState(this.paths.state);
    const sessionId = `sess-${crypto.randomUUID()}`;
    state.sessions[sessionId] = { createdAt: new Date().toISOString() };
    await writeState(this.paths.state, state);
    return {
      sessionId,
      _meta: {
        agentSessionId: `agent-${sessionId}`,
      },
    };
  }

  async loadSession(params) {
    const state = await readState(this.paths.state);
    if (!state.sessions[params.sessionId]) {
      throw acp.RequestError.resourceNotFound(params.sessionId);
    }
    return {
      _meta: {
        agentSessionId: `agent-${params.sessionId}`,
      },
    };
  }

  async setSessionMode() {
    return {};
  }

  async setSessionConfigOption() {
    return {
      configOptions: [],
    };
  }

  async prompt(params) {
    const controller = new AbortController();
    this.pendingPrompts.set(params.sessionId, controller);
    await ensureParent(this.paths.started);
    await fs.writeFile(
      this.paths.started,
      `${JSON.stringify({ pid: process.pid, sessionId: params.sessionId })}\n`,
      "utf8",
    );

    const promptText = promptTextFromInput(params.prompt);

    try {
      if (promptText.includes("summarize-tool-output")) {
        const stringOutput = `STRING_HEAD:${"S".repeat(6_000)}:STRING_TAIL_MARKER`;
        const imageOutput = `data:image/png;base64,IMAGE_HEAD_${"I".repeat(24_000)}_IMAGE_TAIL_MARKER`;

        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-string-output",
            title: "read-log-fragment",
            kind: "read",
            rawInput: { path: "artifact.log" },
            status: "in_progress",
          },
        });
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-string-output",
            status: "completed",
            rawOutput: stringOutput,
          },
        });

        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-image-output",
            title: "capture-screenshot",
            kind: "other",
            rawInput: { window: "main" },
            status: "in_progress",
          },
        });
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-image-output",
            status: "completed",
            rawOutput: {
              screenshot: {
                mimeType: "image/png",
                data: imageOutput,
              },
              html: `<div>${"H".repeat(8_000)}HTML_TAIL_MARKER</div>`,
              frames: Array.from({ length: 12 }, (_, index) => ({
                index,
                label: `frame-${index}`,
                image: `FRAME_${index}_${"Q".repeat(1_500)}_FRAME_TAIL_MARKER`,
              })),
            },
          },
        });
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "summary-ready",
            },
          },
        });
        await ensureParent(this.paths.completed);
        await fs.writeFile(
          this.paths.completed,
          `${JSON.stringify({ pid: process.pid, sessionId: params.sessionId })}\n`,
          "utf8",
        );
        return {
          stopReason: "end_turn",
        };
      }

      if (promptText.includes("stream-events-before-release")) {
        for (let index = 1; index <= 3; index += 1) {
          await this.connection.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `progress-${index}`,
              },
            },
          });
          await wait(25);
        }
      }

      await waitForRelease(this.paths.release, controller.signal);
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "prompt-complete",
          },
        },
      });
      await ensureParent(this.paths.completed);
      await fs.writeFile(
        this.paths.completed,
        `${JSON.stringify({ pid: process.pid, sessionId: params.sessionId })}\n`,
        "utf8",
      );
      return {
        stopReason: "end_turn",
      };
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.message === "cancelled")) {
        return {
          stopReason: "cancelled",
        };
      }
      throw error;
    } finally {
      this.pendingPrompts.delete(params.sessionId);
    }
  }

  async cancel(params) {
    this.pendingPrompts.get(params.sessionId)?.abort();
  }
}

const paths = parseArgs(process.argv);
const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection((connection) => new LoadableAgent(connection, paths), stream);
