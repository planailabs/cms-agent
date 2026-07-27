import { store } from '../app/store';
import { installLayerListeners, registerLayer } from '../app/layers';

export const registerGlobalEvents = () => {
  // Header dropdowns are popover layers: Esc + outside-click close via the
  // shared layer stack (their toggles stopPropagation on the opening click).
  registerLayer({
    id: 'language-menu',
    priority: 95,
    isOpen: (s) => s.isLanguageMenuOpen,
    close: () => store.setState({ isLanguageMenuOpen: false }),
    outsideSelector: '[data-menu="language"]',
  });
  registerLayer({
    id: 'auth-menu',
    priority: 95,
    isOpen: (s) => s.isAuthMenuOpen,
    close: () => store.setState({ isAuthMenuOpen: false }),
    outsideSelector: '[data-menu="auth"]',
  });
  installLayerListeners();
};
