/** DOM helpers shared by the injected-agent module. */
import type { AgentApi } from '../protocol';

/** True for nodes belonging to our own UI (highlight box, chat button). */
export const isOurs = (node: EventTarget | null): boolean => {
  if (!(node instanceof Element)) return false;
  return node.hasAttribute('data-cms-overlay') || !!node.closest('[data-cms-overlay]');
};

/** Short structural CSS path — anchor for "where was this on the page". */
export const cssPath = (el: Element): string => {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 8) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${part}#${node.id}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      let sameTag = 0;
      let index = 0;
      for (const child of Array.from(parent.children)) {
        if (child.tagName === node.tagName) {
          sameTag++;
          if (child === node) index = sameTag;
        }
      }
      if (sameTag > 1) part += `:nth-of-type(${index})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
};

export type Listen = (
  target: EventTarget,
  type: string,
  fn: EventListener,
  capture?: boolean,
) => void;

/** addEventListener wrapper whose registrations are removed on teardown. */
export const createListen = (agent: AgentApi): Listen => {
  const listeners: Array<[EventTarget, string, EventListener, boolean?]> = [];
  agent.onTeardown(() => {
    for (const [target, type, fn, capture] of listeners) {
      target.removeEventListener(type, fn, capture);
    }
  });
  return (target, type, fn, capture) => {
    target.addEventListener(type, fn, capture);
    listeners.push([target, type, fn, capture]);
  };
};
