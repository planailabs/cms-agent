import { store } from '../app/store';

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

export const handleGlobalKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && store.state.isSettingsOverlayOpen) {
    event.preventDefault();
    closeSettingsOverlay();
  }
};

// Initialize global listeners
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', handleGlobalKeyDown);
}
