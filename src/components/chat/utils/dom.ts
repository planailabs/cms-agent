/**
 * DOM Utilities
 *
 * Provides event delegation and custom event helpers for the vanilla JS UI.
 */

/**
 * Sets up event delegation for a specific event type on a root element.
 * This allows handling events from dynamically created elements without
 * needing to attach listeners to each element individually.
 *
 * @typeParam E - The event type (defaults to Event)
 * @param root - The root element to attach the listener to
 * @param eventType - The event type (e.g., 'click', 'input', 'change')
 * @param selector - CSS selector to match target elements
 * @param handler - Callback invoked when a matching element triggers the event
 *
 * @example
 * // Handle all button clicks within #app
 * delegateEvent(app, 'click', '[data-action="submit"]', (event, target) => {
 *   console.log('Submit clicked:', target.dataset.action);
 * });
 */
export const delegateEvent = <E extends Event = Event>(
  root: HTMLElement,
  eventType: string,
  selector: string,
  handler: (event: E, target: HTMLElement) => void,
): void => {
  root.addEventListener(eventType, (event) => {
    let targetNode = event.target as Node | null;

    // Handle text nodes (e.g. clicking text inside a button)
    if (targetNode && targetNode.nodeType === Node.TEXT_NODE) {
      targetNode = targetNode.parentElement;
    }

    // Verify we have an element to call closest on
    if (!targetNode || targetNode.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const targetElement = targetNode as Element;
    const target = targetElement.closest(selector) as HTMLElement | null;

    if (target && root.contains(target)) {
      handler(event as E, target);
    }
  });
};

/**
 * Dispatches a custom event on the document for inter-component communication.
 * Useful when components need to communicate without direct references.
 *
 * @param name - The event name
 * @param detail - Optional data to include with the event
 *
 * @example
 * dispatch('user:logout', { reason: 'session_expired' });
 */
export const dispatch = (name: string, detail?: unknown): void => {
  document.dispatchEvent(new CustomEvent(name, { detail }));
};
