import { describe, expect, it } from "vitest";
import { extractCumulativePromptOutputText, parsePromptEventLine } from "./events.js";

describe("parsePromptEventLine", () => {
  it("parses raw ACP session/update agent_message_chunk lines", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    });
    expect(parsePromptEventLine(line)).toEqual({
      type: "text_delta",
      text: "hello",
      stream: "output",
      tag: "agent_message_chunk",
    });
  });

  it("parses raw codex event_msg agent_message lines", () => {
    const line = JSON.stringify({
      event_msg: {
        agent_message: "Hello from Codex",
      },
    });

    expect(extractCumulativePromptOutputText(line)).toBe("Hello from Codex");
    expect(parsePromptEventLine(line)).toEqual({
      type: "text_delta",
      text: "Hello from Codex",
      stream: "output",
      tag: "agent_message_chunk",
    });
  });

  it("parses raw codex response_item assistant output_text content", () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Hello" },
          { type: "output_text", text: " there" },
        ],
      },
    });

    expect(extractCumulativePromptOutputText(line)).toBe("Hello there");
    expect(parsePromptEventLine(line)).toEqual({
      type: "text_delta",
      text: "Hello there",
      stream: "output",
      tag: "agent_message_chunk",
    });
  });

  it("treats raw codex task_complete as done while exposing last_agent_message text", () => {
    const line = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "All done" }],
        },
      },
    });

    expect(extractCumulativePromptOutputText(line)).toBe("All done");
    expect(parsePromptEventLine(line)).toEqual({
      type: "done",
      stopReason: "task_complete",
    });
  });

  it("parses usage_update with stable metadata", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "usage_update",
          used: 12,
          size: 500,
        },
      },
    });
    expect(parsePromptEventLine(line)).toEqual({
      type: "status",
      text: "usage updated: 12/500",
      tag: "usage_update",
      used: 12,
      size: 500,
    });
  });

  it("parses tool_call_update without using call ids as primary fallback label", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_ABC123",
          status: "in_progress",
        },
      },
    });
    expect(parsePromptEventLine(line)).toEqual({
      type: "tool_call",
      text: "tool call (in_progress)",
      tag: "tool_call_update",
      toolCallId: "call_ABC123",
      status: "in_progress",
      title: "tool call",
    });
  });

  it("keeps compatibility with simplified text/done lines", () => {
    expect(parsePromptEventLine(JSON.stringify({ type: "text", content: "alpha" }))).toEqual({
      type: "text_delta",
      text: "alpha",
      stream: "output",
    });
    expect(parsePromptEventLine(JSON.stringify({ type: "done", stopReason: "end_turn" }))).toEqual({
      type: "done",
      stopReason: "end_turn",
    });
  });
});
