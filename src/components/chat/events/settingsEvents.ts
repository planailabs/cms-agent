import { delegateEvent } from '../utils/dom';
import { handleSignOut, setCommunicationMode } from '../actions/settings';
import { closeSettingsOverlay } from '../actions/overlay';
import type { CommunicationModePreference } from '../app/state';

export const registerSettingsEvents = (app: HTMLElement) => {
  // Settings: Close
  delegateEvent(app, 'click', '[data-action="close-settings"]', (event) => {
    event.preventDefault();
    closeSettingsOverlay();
  });

  // Settings: Sign Out
  delegateEvent(app, 'click', '[data-action="overlay-sign-out"]', (event) => {
    event.preventDefault();
    closeSettingsOverlay();
    void handleSignOut();
  });

  delegateEvent(app, 'change', '[data-action="communication-mode"]', (_event, target) => {
    const value = (target as HTMLSelectElement).value;
    if (value === 'default' || value === 'technical' || value === 'non-technical') {
      void setCommunicationMode(value as CommunicationModePreference);
    }
  });
};
