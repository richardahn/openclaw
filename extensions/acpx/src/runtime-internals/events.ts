import type { AcpRuntimeEvent, AcpSessionUpdateTag } from "../../runtime-api.js";
import {
  asOptionalBoolean,
  asOptionalString,
  asString,
  asTrimmedString,
  type AcpxErrorEvent,
  type AcpxJsonObject,
  isRecord,
} from "./shared.js";

export function toAcpxErrorEvent(value: unknown): AcpxErrorEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  if (asTrimmedString(value.type) !== "error") {
    return null;
  }
  return {
    message: asTrimmedString(value.message) || "acpx reported an error",
    code: asOptionalString(value.code),
    retryable: asOptionalBoolean(value.retryable),
  };
}

export function parseJsonLines(value: string): AcpxJsonObject[] {
  const events: AcpxJsonObject[] = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Ignore malformed lines; callers handle missing typed events via exit code.
    }
  }
  return events;
}

function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveStructuredPromptPayload(parsed: Record<string, unknown>): {
  type: string;
  payload: Record<string, unknown>;
  tag?: AcpSessionUpdateTag;
} {
  const method = asTrimmedString(parsed.method);
  if (method === "session/update") {
    const params = parsed.params;
    if (isRecord(params) && isRecord(params.update)) {
      const update = params.update;
      const tag = asOptionalString(update.sessionUpdate) as AcpSessionUpdateTag | undefined;
      return {
        type: tag ?? "",
        payload: update,
        ...(tag ? { tag } : {}),
      };
    }
  }

  const sessionUpdate = asOptionalString(parsed.sessionUpdate) as AcpSessionUpdateTag | undefined;
  if (sessionUpdate) {
    return {
      type: sessionUpdate,
      payload: parsed,
      tag: sessionUpdate,
    };
  }

  const type = asTrimmedString(parsed.type);
  const tag = asOptionalString(parsed.tag) as AcpSessionUpdateTag | undefined;
  return {
    type,
    payload: parsed,
    ...(tag ? { tag } : {}),
  };
}

function resolveStatusTextForTag(params: {
  tag: AcpSessionUpdateTag;
  payload: Record<string, unknown>;
}): string | null {
  const { tag, payload } = params;
  if (tag === "available_commands_update") {
    const commands = Array.isArray(payload.availableCommands) ? payload.availableCommands : [];
    return commands.length > 0
      ? `available commands updated (${commands.length})`
      : "available commands updated";
  }
  if (tag === "current_mode_update") {
    const mode =
      asTrimmedString(payload.currentModeId) ||
      asTrimmedString(payload.modeId) ||
      asTrimmedString(payload.mode);
    return mode ? `mode updated: ${mode}` : "mode updated";
  }
  if (tag === "config_option_update") {
    const id = asTrimmedString(payload.id) || asTrimmedString(payload.configOptionId);
    const value =
      asTrimmedString(payload.currentValue) ||
      asTrimmedString(payload.value) ||
      asTrimmedString(payload.optionValue);
    if (id && value) {
      return `config updated: ${id}=${value}`;
    }
    if (id) {
      return `config updated: ${id}`;
    }
    return "config updated";
  }
  if (tag === "session_info_update") {
    return (
      asTrimmedString(payload.summary) || asTrimmedString(payload.message) || "session updated"
    );
  }
  if (tag === "plan") {
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const first = entries.find((entry) => isRecord(entry)) as Record<string, unknown> | undefined;
    const content = asTrimmedString(first?.content);
    return content ? `plan: ${content}` : null;
  }
  return null;
}

function resolveTextChunk(params: {
  payload: Record<string, unknown>;
  stream: "output" | "thought";
  tag: AcpSessionUpdateTag;
}): AcpRuntimeEvent | null {
  const contentRaw = params.payload.content;
  if (isRecord(contentRaw)) {
    const contentType = asTrimmedString(contentRaw.type);
    if (contentType && contentType !== "text") {
      return null;
    }
    const text = asString(contentRaw.text);
    if (text && text.length > 0) {
      return {
        type: "text_delta",
        text,
        stream: params.stream,
        tag: params.tag,
      };
    }
  }
  const text = asString(params.payload.text);
  if (!text || text.length === 0) {
    return null;
  }
  return {
    type: "text_delta",
    text,
    stream: params.stream,
    tag: params.tag,
  };
}

function createTextDeltaEvent(params: {
  content: string | null | undefined;
  stream: "output" | "thought";
  tag?: AcpSessionUpdateTag;
}): AcpRuntimeEvent | null {
  if (params.content == null || params.content.length === 0) {
    return null;
  }
  return {
    type: "text_delta",
    text: params.content,
    stream: params.stream,
    ...(params.tag ? { tag: params.tag } : {}),
  };
}

function createToolCallEvent(params: {
  payload: Record<string, unknown>;
  tag: AcpSessionUpdateTag;
}): AcpRuntimeEvent {
  const title = asTrimmedString(params.payload.title) || "tool call";
  const status = asTrimmedString(params.payload.status);
  const toolCallId = asOptionalString(params.payload.toolCallId);
  return {
    type: "tool_call",
    text: status ? `${title} (${status})` : title,
    tag: params.tag,
    ...(toolCallId ? { toolCallId } : {}),
    ...(status ? { status } : {}),
    title,
  };
}

function resolveRawEventMsgPayload(
  parsed: Record<string, unknown>,
): Record<string, unknown> | null {
  if (asTrimmedString(parsed.type) === "event_msg" && isRecord(parsed.payload)) {
    return parsed.payload;
  }
  const eventMsg = parsed.event_msg;
  if (!isRecord(eventMsg)) {
    return null;
  }
  if (isRecord(eventMsg.payload)) {
    return eventMsg.payload;
  }
  return eventMsg;
}

function resolveRawResponseItemPayload(
  parsed: Record<string, unknown>,
): Record<string, unknown> | null {
  if (asTrimmedString(parsed.type) === "response_item" && isRecord(parsed.payload)) {
    return parsed.payload;
  }
  const responseItem = parsed.response_item;
  if (!isRecord(responseItem)) {
    return null;
  }
  if (isRecord(responseItem.payload)) {
    return responseItem.payload;
  }
  return responseItem;
}

function extractContentText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (Array.isArray(value)) {
    let combined = "";
    for (const item of value) {
      const text = extractContentText(item);
      if (text) {
        combined += text;
      }
    }
    return combined.length > 0 ? combined : null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const type = asTrimmedString(value.type);
  if (type === "output_text" || type === "text") {
    const text = asString(value.text);
    if (text && text.length > 0) {
      return text;
    }
  }

  if (Array.isArray(value.content) || isRecord(value.content)) {
    return extractContentText(value.content);
  }

  return null;
}

function extractLastAgentMessageText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (Array.isArray(value)) {
    return extractContentText(value);
  }
  if (!isRecord(value)) {
    return null;
  }

  const directText =
    asString(value.message) || asString(value.text) || asString(value.agent_message);
  if (directText && directText.length > 0) {
    return directText;
  }

  if (Array.isArray(value.content) || isRecord(value.content)) {
    const contentText = extractContentText(value.content);
    if (contentText) {
      return contentText;
    }
  }

  if (isRecord(value.last_agent_message) || Array.isArray(value.last_agent_message)) {
    return extractLastAgentMessageText(value.last_agent_message);
  }

  return null;
}

function resolveRawAgentMessageText(parsed: Record<string, unknown>): string | null {
  const payload = resolveRawEventMsgPayload(parsed);
  if (!payload) {
    return null;
  }
  if (asTrimmedString(payload.type) === "agent_message") {
    return asString(payload.message) || asString(payload.text) || asString(payload.content) || null;
  }
  const agentMessage = asString(payload.agent_message);
  return agentMessage && agentMessage.length > 0 ? agentMessage : null;
}

function resolveRawResponseItemText(parsed: Record<string, unknown>): string | null {
  const payload = resolveRawResponseItemPayload(parsed);
  if (!payload) {
    return null;
  }
  const itemType = asTrimmedString(payload.type);
  if (itemType && itemType !== "message") {
    return null;
  }
  const role = asTrimmedString(payload.role);
  if (role && role !== "assistant") {
    return null;
  }
  return extractContentText(payload.content);
}

function isRawTaskCompleteEvent(parsed: Record<string, unknown>): boolean {
  const payload = resolveRawEventMsgPayload(parsed);
  if (!payload) {
    return false;
  }
  return asTrimmedString(payload.type) === "task_complete" || isRecord(payload.task_complete);
}

function resolveRawTaskCompleteText(parsed: Record<string, unknown>): string | null {
  const payload = resolveRawEventMsgPayload(parsed);
  if (!payload) {
    return null;
  }
  if (asTrimmedString(payload.type) === "task_complete") {
    return extractLastAgentMessageText(payload.last_agent_message);
  }
  if (isRecord(payload.task_complete)) {
    return extractLastAgentMessageText(payload.task_complete.last_agent_message);
  }
  return null;
}

export function extractCumulativePromptOutputText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  return (
    resolveRawAgentMessageText(parsed) ??
    resolveRawResponseItemText(parsed) ??
    resolveRawTaskCompleteText(parsed)
  );
}

export function parsePromptEventLine(line: string): AcpRuntimeEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      type: "status",
      text: trimmed,
    };
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const structured = resolveStructuredPromptPayload(parsed);
  const type = structured.type;
  const payload = structured.payload;
  const tag = structured.tag;

  switch (type) {
    case "text":
      return createTextDeltaEvent({
        content: asString(payload.content),
        stream: "output",
        tag,
      });
    case "thought":
      return createTextDeltaEvent({
        content: asString(payload.content),
        stream: "thought",
        tag,
      });
    case "tool_call":
      return createToolCallEvent({
        payload,
        tag: (tag ?? "tool_call") as AcpSessionUpdateTag,
      });
    case "tool_call_update":
      return createToolCallEvent({
        payload,
        tag: (tag ?? "tool_call_update") as AcpSessionUpdateTag,
      });
    case "agent_message_chunk":
      return resolveTextChunk({
        payload,
        stream: "output",
        tag: "agent_message_chunk",
      });
    case "agent_thought_chunk":
      return resolveTextChunk({
        payload,
        stream: "thought",
        tag: "agent_thought_chunk",
      });
    case "usage_update": {
      const used = asOptionalFiniteNumber(payload.used);
      const size = asOptionalFiniteNumber(payload.size);
      const text =
        used != null && size != null ? `usage updated: ${used}/${size}` : "usage updated";
      return {
        type: "status",
        text,
        tag: "usage_update",
        ...(used != null ? { used } : {}),
        ...(size != null ? { size } : {}),
      };
    }
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "plan": {
      const text = resolveStatusTextForTag({
        tag: type as AcpSessionUpdateTag,
        payload,
      });
      if (!text) {
        return null;
      }
      return {
        type: "status",
        text,
        tag: type as AcpSessionUpdateTag,
      };
    }
    case "client_operation": {
      const method = asTrimmedString(payload.method) || "operation";
      const status = asTrimmedString(payload.status);
      const summary = asTrimmedString(payload.summary);
      const text = [method, status, summary].filter(Boolean).join(" ");
      if (!text) {
        return null;
      }
      return { type: "status", text, ...(tag ? { tag } : {}) };
    }
    case "update": {
      const update = asTrimmedString(payload.update);
      if (!update) {
        return null;
      }
      return { type: "status", text: update, ...(tag ? { tag } : {}) };
    }
    case "done": {
      return {
        type: "done",
        stopReason: asOptionalString(payload.stopReason),
      };
    }
    case "error": {
      const message = asTrimmedString(payload.message) || "acpx runtime error";
      return {
        type: "error",
        message,
        code: asOptionalString(payload.code),
        retryable: asOptionalBoolean(payload.retryable),
      };
    }
    default:
      if (isRawTaskCompleteEvent(parsed)) {
        return {
          type: "done",
          stopReason: "task_complete",
        };
      }
      return createTextDeltaEvent({
        content: resolveRawAgentMessageText(parsed) ?? resolveRawResponseItemText(parsed),
        stream: "output",
        tag: "agent_message_chunk",
      });
  }
}
