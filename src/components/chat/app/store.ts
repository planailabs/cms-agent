/**
 * Application Store
 *
 * A minimal pub/sub store for managing global application state.
 * Uses a simple observer pattern for reactivity without external dependencies.
 *
 * Design decisions:
 * - Single store instance (singleton) for simplicity
 * - Synchronous updates for predictable behavior
 * - No middleware or devtools (keep it simple)
 * - Mutable state object for performance (shallow copy on setState)
 */

import {
  createInitialState,
  clearCachedUserState,
  type AppState,
} from './state';

/** Listener callback type for store subscriptions */
type StoreListener = () => void;

/**
 * Simple reactive store for application state.
 * Provides subscribe/notify pattern for UI updates.
 */
class Store {
  /** Current application state (mutable for performance) */
  state: AppState;

  /** Set of subscribed listener callbacks */
  private listeners = new Set<StoreListener>();

  constructor() {
    this.state = createInitialState();
  }

  /**
   * Subscribes to state changes.
   *
   * @param listener - Callback invoked when state changes
   * @returns Unsubscribe function
   *
   * @example
   * const unsubscribe = store.subscribe(() => {
   *   console.log('State changed:', store.state);
   * });
   * // Later: unsubscribe();
   */
  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Triggers all subscribed listeners.
   * Call this after direct state mutations or when external
   * state changes need to trigger a UI update.
   */
  notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  /**
   * Updates state with a partial object or updater function.
   * Automatically notifies listeners after the update.
   *
   * @param updater - Partial state object or function returning partial state
   *
   * @example
   * // Object form
   * store.setState({ isAuthMenuOpen: true });
   *
   * // Function form (for updates based on current state)
   * store.setState((state) => ({
   *   counter: state.counter + 1
   * }));
   */
  setState(
    updater: Partial<AppState> | ((state: AppState) => Partial<AppState>),
  ): void {
    const updates =
      typeof updater === 'function' ? updater(this.state) : updater;
    this.state = { ...this.state, ...updates };
    this.notify();
  }

  /**
   * Resets state to initial values, preserving user-independent settings.
   * Used for sign-out to clear user data while keeping preferences like locale.
   */
  reset(): void {
    // Clear cached user state first so createInitialState doesn't restore it
    clearCachedUserState();

    const currentLocale = this.state.localeKey;
    const currentTheme = this.state.themeMode;
    this.state = {
      ...createInitialState(),
      localeKey: currentLocale,
      themeMode: currentTheme,
      // Explicitly clear user state (in case cache wasn't cleared)
      user: null,
    };
    this.notify();
  }
}

/** Singleton store instance */
export const store = new Store();
