/**
 * "Notify me when this chat is done" — the bell next to the composer and the
 * modal behind it.
 *
 * Arming is per chat and per person, and it is one-shot: the server drops the
 * request the moment it fires. The modal says so, because a bell that silently
 * turns itself off is otherwise indistinguishable from one that broke.
 *
 * Channels are offered only when the deployment configured a provider for
 * them. SMS additionally needs a number, which is why the phone field lives
 * here rather than only in account settings: needing it and giving it are the
 * same moment. Email comes from the identity provider and is never editable.
 */
import { store } from '../chat/app/store';
import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { AppState } from '../chat/app/state';

interface NotifyResponse {
  channels: string[];
  available: string[];
  missingAddress: string[];
  phone: string | null;
  email: string | null;
  error?: string;
}

/** Apply a server answer verbatim — the server decides what is armed. */
const apply = (chatId: string, data: NotifyResponse): void => {
  const notify = store.state.workspace.notify;
  // The viewer can switch chats while the round trip is in flight; adopting
  // the answer then would arm the bell of a chat it does not describe.
  if (store.state.activeChatId !== chatId) return;
  notify.forChatId = chatId;
  notify.channels = data.channels ?? [];
  notify.available = data.available ?? [];
  notify.missingAddress = data.missingAddress ?? [];
  notify.phone = data.phone ?? null;
  notify.email = data.email ?? null;
  notify.error = null;
};

/**
 * Load the bell's state for a chat. Called when a chat opens, so the icon is
 * already right before anyone clicks it — and skipped when it already
 * describes that chat.
 */
export const loadNotifyState = async (chatId: string, force = false): Promise<void> => {
  const notify = store.state.workspace.notify;
  if (!force && notify.forChatId === chatId) return;
  notify.loading = true;
  store.notify();
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/notify`);
    if (res.ok) apply(chatId, (await res.json()) as NotifyResponse);
  } catch {
    // Nothing to report: an unreachable bell is a dark bell, and the failure
    // surfaces the moment somebody opens the modal and tries to save.
  } finally {
    notify.loading = false;
    store.notify();
  }
};

export const openNotifyModal = (): void => {
  const chatId = store.state.activeChatId;
  if (!chatId) return;
  store.state.workspace.notify.open = true;
  store.notify();
  void loadNotifyState(chatId, true);
};

export const closeNotifyModal = (): void => {
  const notify = store.state.workspace.notify;
  if (!notify.open) return;
  notify.open = false;
  notify.error = null;
  store.notify();
};

/** Checkbox toggle — local until Save, because SMS may still need a number. */
export const toggleNotifyChannel = (channel: string): void => {
  const notify = store.state.workspace.notify;
  notify.channels = notify.channels.includes(channel)
    ? notify.channels.filter((c) => c !== channel)
    : [...notify.channels, channel];
  notify.error = null;
  store.notify();
};

/** Save channels (and the typed phone number) in one request. */
export const saveNotifySettings = async (): Promise<void> => {
  const chatId = store.state.activeChatId;
  const notify = store.state.workspace.notify;
  if (!chatId || notify.saving) return;
  const phoneInput = document.querySelector<HTMLInputElement>('[data-action="ws-notify-phone"]');
  const phone = phoneInput?.value.trim();

  // The server refuses a channel with no address (silence is not a
  // notification). Say so here instead of spending a round trip on it — the
  // number they need to type is in the same panel.
  const unreachable = notify.channels.filter((channel) =>
    channel === 'sms' ? !(phone || notify.phone) : !notify.email,
  );
  if (unreachable.length > 0) {
    notify.error = t(uiLocale(), 'chat.notify.needAddress');
    store.notify();
    return;
  }

  notify.saving = true;
  notify.error = null;
  store.notify();
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/notify`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channels: notify.channels,
        // Only when the field was rendered — omitting it leaves the saved
        // number alone, while '' would be read as "delete my number".
        ...(phone === undefined ? {} : { phone }),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as NotifyResponse;
    if (!res.ok) {
      notify.error = data.error ?? t(uiLocale(), 'chat.notify.saveFailed');
      return;
    }
    apply(chatId, data);
    notify.open = false;
  } catch {
    notify.error = t(uiLocale(), 'chat.notify.saveFailed');
  } finally {
    notify.saving = false;
    store.notify();
  }
};

/** True while this viewer has something armed for the open chat. */
export const notifyArmed = (state: AppState): boolean =>
  state.workspace.notify.forChatId === state.activeChatId &&
  state.workspace.notify.channels.length > 0;

/** Bell in the sidebar header — lit while something is armed. Lives outside
 *  the composer on purpose: the composer is replaced by the Stop card while a
 *  turn runs, which is exactly when somebody decides to walk away. */
export const renderNotifyBell = (state: AppState): string => {
  if (!state.activeChatId || state.activeChatArchived) return '';
  const armed = notifyArmed(state);
  const label = t(uiLocale(), armed ? 'chat.notify.bellArmed' : 'chat.notify.bell');
  return `<button type="button" class="ws-mini-button ws-notify__bell${armed ? ' is-armed' : ''}"
      data-action="ws-notify-open" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"
      aria-pressed="${armed}">${armed ? '🔔' : '🔕'}</button>`;
};

const CHANNEL_LABEL: Record<string, string> = {
  email: 'chat.notify.channel.email',
  sms: 'chat.notify.channel.sms',
};

const renderChannel = (
  state: AppState,
  channel: string,
  locale: string,
): string => {
  const notify = state.workspace.notify;
  const checked = notify.channels.includes(channel);
  const address = channel === 'email' ? notify.email : notify.phone;
  return `<label class="ws-notify__channel">
      <input type="checkbox" data-action="ws-notify-channel" data-channel="${escapeHtml(channel)}"
        ${checked ? 'checked' : ''} />
      <span class="ws-notify__channel-text">
        <span class="ws-notify__channel-name">${escapeHtml(t(locale, CHANNEL_LABEL[channel] ?? channel))}</span>
        <span class="ws-notify__channel-addr">${escapeHtml(address ?? t(locale, 'chat.notify.noAddress'))}</span>
      </span>
    </label>`;
};

export const renderNotifyModal = (state: AppState): string => {
  const notify = state.workspace.notify;
  if (!notify.open) return '';
  const locale = uiLocale();
  const title = t(locale, 'chat.notify.title');

  const body = notify.loading
    ? `<p class="ws-rc__hint">${escapeHtml(t(locale, 'chat.notify.loading'))}</p>`
    : notify.available.length === 0
      ? `<p class="ws-rc__hint">${escapeHtml(t(locale, 'chat.notify.noChannels'))}</p>`
      : `<div class="ws-notify__channels">
          ${notify.available.map((c) => renderChannel(state, c, locale)).join('')}
        </div>
        ${
          notify.available.includes('sms')
            ? `<label class="ws-notify__field">
                <span>${escapeHtml(t(locale, 'chat.notify.phoneLabel'))}</span>
                <input type="tel" class="ws-notify__input" data-action="ws-notify-phone"
                  inputmode="tel" autocomplete="tel"
                  placeholder="${escapeHtml(t(locale, 'chat.notify.phonePlaceholder'))}"
                  value="${escapeHtml(notify.phone ?? '')}" />
              </label>`
            : ''
        }`;

  return `<div class="ws-rc" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="ws-rc__panel">
        <div class="ws-rc__head">
          <h2 class="ws-rc__heading">${escapeHtml(title)}</h2>
          <button type="button" class="ws-mini-button" data-action="ws-notify-close"
            aria-label="${escapeHtml(t(locale, 'workspace.modal.close'))}">✕</button>
        </div>
        <p class="ws-rc__hint">${escapeHtml(t(locale, 'chat.notify.hint'))}</p>
        ${body}
        ${notify.error ? `<p class="ws-notify__error" role="alert">${escapeHtml(notify.error)}</p>` : ''}
        <div class="ws-notify__actions">
          <button type="button" class="ws-mini-button" data-action="ws-notify-close">
            ${escapeHtml(t(locale, 'chat.notify.cancel'))}
          </button>
          <button type="button" class="ws-mini-button ws-mini-button--primary"
            data-action="ws-notify-save" ${notify.saving || notify.loading ? 'disabled' : ''}>
            ${escapeHtml(t(locale, notify.saving ? 'chat.notify.saving' : 'chat.notify.save'))}
          </button>
        </div>
      </div>
    </div>`;
};
