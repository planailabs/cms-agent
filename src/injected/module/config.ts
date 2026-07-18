/**
 * Overlay config synced from the main window via cms:config — effective theme
 * (light/dark) and locale-resolved labels. The parent re-posts whenever its
 * <html lang> or data-theme changes, so the overlay follows the workspace,
 * not the preview page.
 */
import type { AgentApi } from '../protocol';

export interface OverlayConfig {
  theme: 'light' | 'dark';
  labels: { chatAboutThis: string };
}

export const cfg: OverlayConfig = {
  theme: 'dark',
  labels: { chatAboutThis: '💬 Chat about this' },
};

const listeners: Array<() => void> = [];

export const onConfigChange = (fn: () => void): void => {
  listeners.push(fn);
};

export const initConfig = (agent: AgentApi): void => {
  agent.on(
    'cms:config',
    agent.safe((data: Record<string, unknown>) => {
      if (data.theme === 'light' || data.theme === 'dark') cfg.theme = data.theme;
      const labels = data.labels as Record<string, unknown> | undefined;
      if (labels && typeof labels.chatAboutThis === 'string') {
        cfg.labels.chatAboutThis = labels.chatAboutThis;
      }
      for (const fn of listeners) fn();
    }),
  );
};
