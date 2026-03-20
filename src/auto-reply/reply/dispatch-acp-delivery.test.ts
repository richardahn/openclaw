import { describe, expect, it, vi } from "vitest";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
}));

vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

function createCoordinator(params?: {
  onReplyStart?: (...args: unknown[]) => Promise<void>;
  suppressVisibleBlockReplies?: boolean;
}) {
  return createAcpDispatchDeliveryCoordinator({
    cfg: createAcpTestConfig(),
    ctx: buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:codex-acp:session-1",
    }),
    dispatcher: createDispatcher(),
    inboundAudio: false,
    shouldRouteToOriginating: false,
    ...(params?.onReplyStart ? { onReplyStart: params.onReplyStart } : {}),
    ...(params?.suppressVisibleBlockReplies === true ? { suppressVisibleBlockReplies: true } : {}),
  });
}

describe("createAcpDispatchDeliveryCoordinator", () => {
  it("starts reply lifecycle only once when called directly and through deliver", async () => {
    const onReplyStart = vi.fn(async () => {});
    const coordinator = createCoordinator({ onReplyStart });

    await coordinator.startReplyLifecycle();
    await coordinator.deliver("final", { text: "hello" });
    await coordinator.startReplyLifecycle();
    await coordinator.deliver("block", { text: "world" });

    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("starts reply lifecycle once when deliver triggers first", async () => {
    const onReplyStart = vi.fn(async () => {});
    const coordinator = createCoordinator({ onReplyStart });

    await coordinator.deliver("final", { text: "hello" });
    await coordinator.startReplyLifecycle();

    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("does not start reply lifecycle for empty payload delivery", async () => {
    const onReplyStart = vi.fn(async () => {});
    const coordinator = createCoordinator({ onReplyStart });

    await coordinator.deliver("final", {});

    expect(onReplyStart).not.toHaveBeenCalled();
  });

  it("can suppress visible ACP block replies while still accumulating final text", async () => {
    const dispatcher = createDispatcher();
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher,
      inboundAudio: false,
      shouldRouteToOriginating: false,
      suppressVisibleBlockReplies: true,
    });

    const delivered = await coordinator.deliver("block", { text: "Hello from ACP" });

    expect(delivered).toBe(false);
    expect(coordinator.getBlockCount()).toBe(1);
    expect(coordinator.getAccumulatedBlockText()).toBe("Hello from ACP");
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });
});
