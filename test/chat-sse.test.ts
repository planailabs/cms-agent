import { afterEach, describe, expect, it, vi } from "vitest";

describe("chat SSE", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("registers the canonical state snapshot before the connection opens", async () => {
    const eventTypes: string[] = [];
    class MockEventSource {
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = 0;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(readonly url: string) {
        queueMicrotask(() => {
          this.readyState = MockEventSource.OPEN;
          this.onopen?.();
        });
      }

      addEventListener(type: string): void {
        eventTypes.push(type);
      }

      removeEventListener(): void {}
      close(): void {
        this.readyState = MockEventSource.CLOSED;
      }
    }
    vi.stubGlobal("EventSource", MockEventSource);

    const { store } = await import("@/components/chat/app/store");
    store.state.activeChatId = "phase-chat";
    const { connectEvents, disconnectEvents } = await import(
      "@/components/chat/actions/chat/sse"
    );
    await connectEvents();

    expect(eventTypes).toContain("state");
    expect(eventTypes).toContain("ui_language");
    expect(eventTypes).toContain("open_compare");
    disconnectEvents();
  });

  it("sends the current transient UI locale with each message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const { store } = await import("@/components/chat/app/store");
    store.state.activeChatId = "language-chat";
    store.state.localeKey = "de";
    const { postMessage } = await import("@/components/chat/actions/chat/sse");
    await postMessage({ type: "message", text: "Hallo" });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      chatId: "language-chat",
      type: "message",
      text: "Hallo",
      uiLocale: "de",
    });
  });
});
