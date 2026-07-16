import { delegateEvent } from '../utils/dom';
import { handleSignOut } from '../actions/settings';
import { closeSettingsOverlay } from '../actions/overlay';

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
};
