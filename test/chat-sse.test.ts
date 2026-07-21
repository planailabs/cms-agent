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
    disconnectEvents();
  });
});
