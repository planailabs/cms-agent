import { store } from '../app/store';
import { registerLayer } from '../app/layers';

export const openSettingsOverlay = () => {
  const state = store.state;
  if (state.isSettingsOverlayOpen) {
    return;
  }
  store.setState({ isSettingsOverlayOpen: true });
};

export const closeSettingsOverlay = () => {
  const state = store.state;
  if (!state.isSettingsOverlayOpen) {
    return;
  }
  store.setState({
    isSettingsOverlayOpen: false,
  });
};

// Settings sits above every other layer; Esc routes through the layer stack.
registerLayer({
  id: 'settings-overlay',
  priority: 120,
  isOpen: (s) => s.isSettingsOverlayOpen,
  close: closeSettingsOverlay,
});
