import type { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import type { ChunkMode } from "../auto-reply/chunk.js";
import { createFinalizableDraftStreamControlsForState } from "../channels/draft-stream-controls.js";
import { chunkDiscordTextWithMode } from "./chunk.js";

/** Discord messages cap at 2000 characters. */
const DISCORD_STREAM_MAX_CHARS = 2000;
const DEFAULT_THROTTLE_MS = 1200;

type DiscordDraftPreviewMessage = {
  id: string;
  text: string;
};

export type DiscordDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => string | undefined;
  hasVisibleMessages: () => boolean;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
};

export function createDiscordDraftStream(params: {
  rest: RequestClient;
  channelId: string;
  maxChars?: number;
  maxLines?: number;
  chunkMode?: ChunkMode;
  replyToMessageId?: string | (() => string | undefined);
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): DiscordDraftStream {
  const maxChars = Math.min(params.maxChars ?? DISCORD_STREAM_MAX_CHARS, DISCORD_STREAM_MAX_CHARS);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const channelId = params.channelId;
  const rest = params.rest;
  const resolveReplyToMessageId = () =>
    typeof params.replyToMessageId === "function"
      ? params.replyToMessageId()
      : params.replyToMessageId;

  const streamState = { stopped: false, final: false };
  let activeMessages: DiscordDraftPreviewMessage[] = [];
  let archivedMessageIds: string[] = [];
  let lastSentText = "";

  const archiveMessageId = (messageId: string) => {
    if (!archivedMessageIds.includes(messageId)) {
      archivedMessageIds.push(messageId);
    }
  };

  const splitPreviewText = (text: string) => {
    const chunks = chunkDiscordTextWithMode(text, {
      maxChars,
      maxLines: params.maxLines,
      chunkMode: params.chunkMode,
    });
    if (!chunks.length && text) {
      return [text];
    }
    return chunks;
  };

  const deletePreviewMessage = async (messageId: string) => {
    await rest.delete(Routes.channelMessage(channelId, messageId));
  };

  const sendPreviewMessage = async (text: string): Promise<string | undefined> => {
    const replyToMessageId = resolveReplyToMessageId()?.trim();
    const messageReference = replyToMessageId
      ? { message_id: replyToMessageId, fail_if_not_exists: false }
      : undefined;
    const sent = (await rest.post(Routes.channelMessages(channelId), {
      body: {
        content: text,
        ...(messageReference ? { message_reference: messageReference } : {}),
      },
    })) as { id?: string } | undefined;
    return sent?.id;
  };

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    // Allow final flush even if stopped (e.g., after clear()).
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    if (trimmed === lastSentText) {
      return true;
    }

    // Debounce first preview send for better push notification quality.
    if (activeMessages.length === 0 && minInitialChars != null && !streamState.final) {
      if (trimmed.length < minInitialChars) {
        return false;
      }
    }

    const chunks = splitPreviewText(trimmed);
    try {
      const nextMessages: DiscordDraftPreviewMessage[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk.trim()) {
          continue;
        }
        const existing = activeMessages[i];
        if (existing && existing.text === chunk) {
          nextMessages.push(existing);
          continue;
        }
        if (existing) {
          await rest.patch(Routes.channelMessage(channelId, existing.id), {
            body: { content: chunk },
          });
          nextMessages.push({ id: existing.id, text: chunk });
          continue;
        }

        const sentMessageId = await sendPreviewMessage(chunk);
        if (typeof sentMessageId !== "string" || !sentMessageId) {
          streamState.stopped = true;
          params.warn?.("discord stream preview stopped (missing message id from send)");
          return false;
        }
        nextMessages.push({ id: sentMessageId, text: chunk });
      }

      const staleMessages = activeMessages.slice(nextMessages.length);
      activeMessages = nextMessages;
      lastSentText = trimmed;

      for (const staleMessage of staleMessages) {
        try {
          await deletePreviewMessage(staleMessage.id);
        } catch (err) {
          archiveMessageId(staleMessage.id);
          params.warn?.(
            `discord stream preview cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return true;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(
        `discord stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const { loop, update, stop, stopForClear } = createFinalizableDraftStreamControlsForState({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
  });

  const clear = async () => {
    await stopForClear();
    const messageIds = [
      ...archivedMessageIds,
      ...activeMessages.map((message) => message.id),
    ].filter((messageId, index, allIds) => messageId && allIds.indexOf(messageId) === index);

    activeMessages = [];
    archivedMessageIds = [];
    lastSentText = "";

    for (const messageId of messageIds) {
      try {
        await deletePreviewMessage(messageId);
      } catch (err) {
        params.warn?.(
          `discord stream preview cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  const forceNewMessage = () => {
    for (const activeMessage of activeMessages) {
      archiveMessageId(activeMessage.id);
    }
    activeMessages = [];
    lastSentText = "";
    loop.resetPending();
  };

  params.log?.(`discord stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    messageId: () =>
      archivedMessageIds.length === 0 && activeMessages.length === 1
        ? activeMessages[0]?.id
        : undefined,
    hasVisibleMessages: () => archivedMessageIds.length > 0 || activeMessages.length > 0,
    clear,
    stop,
    forceNewMessage,
  };
}
