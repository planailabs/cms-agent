import { registerHeaderEvents } from './headerEvents';
import { registerChatEvents } from './chatEvents';
import { registerSettingsEvents } from './settingsEvents';
import { registerGlobalEvents } from './globalEvents';

export const registerAllEvents = (app: HTMLElement) => {
  registerHeaderEvents(app);
  registerChatEvents(app);
  registerSettingsEvents(app);
  registerGlobalEvents();
};
