import { describe, expect, it, vi } from "vitest";
import { createDiscordDraftStream } from "./draft-stream.js";

type DiscordDraftStreamParams = Parameters<typeof createDiscordDraftStream>[0];
type DiscordDraftWarnFn = NonNullable<DiscordDraftStreamParams["warn"]>;

function createDraftStreamHarness(
  params: {
    maxChars?: number;
    maxLines?: number;
    minInitialChars?: number;
    warn?: DiscordDraftWarnFn;
  } = {},
) {
  const rest = {
    post: vi.fn(async () => ({ id: "preview-1" })),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  };
  const warn = params.warn ?? vi.fn<DiscordDraftWarnFn>();
  const stream = createDiscordDraftStream({
    rest: rest as never,
    channelId: "c1",
    throttleMs: 250,
    maxChars: params.maxChars,
    maxLines: params.maxLines,
    minInitialChars: params.minInitialChars,
    warn,
  });
  return { stream, rest, warn };
}

describe("createDiscordDraftStream", () => {
  it("sends the first update and edits subsequent updates", async () => {
    const { stream, rest } = createDraftStreamHarness();

    stream.update("hello");
    await stream.flush();
    stream.update("hello world");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(1);
    expect(rest.patch).toHaveBeenCalledTimes(1);
    expect(rest.patch.mock.calls[0]?.[1]).toEqual({ body: { content: "hello world" } });
    expect(stream.messageId()).toBe("preview-1");
  });

  it("rolls long preview text into additional messages instead of stopping at maxChars", async () => {
    const { stream, rest, warn } = createDraftStreamHarness({ maxChars: 5, maxLines: 50 });
    rest.post.mockResolvedValueOnce({ id: "preview-1" }).mockResolvedValueOnce({ id: "preview-2" });

    stream.update("1234");
    await stream.flush();
    stream.update("123456");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.post.mock.calls[0]?.[1]).toEqual({ body: { content: "1234" } });
    expect(rest.post.mock.calls[1]?.[1]).toEqual({ body: { content: "6" } });
    expect(rest.patch).toHaveBeenCalledTimes(1);
    expect(rest.patch.mock.calls[0]?.[1]).toEqual({ body: { content: "12345" } });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("text length"));
    expect(stream.messageId()).toBeUndefined();
  });

  it("uses Discord chunking options for preview rollover", async () => {
    const { stream, rest } = createDraftStreamHarness({ maxChars: 2000, maxLines: 1 });
    rest.post.mockResolvedValueOnce({ id: "preview-1" }).mockResolvedValueOnce({ id: "preview-2" });

    stream.update("Line 1\nLine 2");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.post.mock.calls[0]?.[1]).toEqual({ body: { content: "Line 1" } });
    expect(rest.post.mock.calls[1]?.[1]).toEqual({ body: { content: "Line 2" } });
    expect(stream.messageId()).toBeUndefined();
  });

  it("clears all active and archived preview messages", async () => {
    const { stream, rest } = createDraftStreamHarness();
    rest.post.mockResolvedValueOnce({ id: "preview-1" }).mockResolvedValueOnce({ id: "preview-2" });

    stream.update("hello");
    await stream.flush();
    stream.forceNewMessage();
    stream.update("world");
    await stream.flush();
    await stream.clear();

    expect(rest.delete).toHaveBeenCalledTimes(2);
    expect(rest.delete.mock.calls.map((call) => call[0])).toEqual([
      "/channels/c1/messages/preview-1",
      "/channels/c1/messages/preview-2",
    ]);
    expect(stream.messageId()).toBeUndefined();
  });
});
