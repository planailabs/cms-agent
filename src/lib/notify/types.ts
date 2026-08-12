/**
 * Notification providers — the pluggable half of "tell me when the chat is
 * done".
 *
 * Two channels reach a person (email, SMS) and every deployment reaches them
 * through a different vendor: Twilio here, Vonage there, an in-house SMTP
 * relay somewhere else. A provider is that vendor and nothing else — one
 * `send`, a config object out of the environment, no channel logic. Adding
 * one is a single registerNotifyProvider call in its own file, the same shape
 * deploy flows and site backends already use.
 */

/** The ways a person can be reached. Channel ⇒ what an address looks like. */
export const NOTIFY_CHANNELS = ['email', 'sms'] as const;
export type NotifyChannelId = (typeof NOTIFY_CHANNELS)[number];

export const isNotifyChannel = (value: unknown): value is NotifyChannelId =>
  typeof value === 'string' && (NOTIFY_CHANNELS as readonly string[]).includes(value);

/** What gets delivered. SMS senders use `subject` + `url`; email uses all three. */
export interface NotifyMessage {
  /** One line: the SMS text and the email subject. */
  subject: string;
  /** Longer form for channels that have room for it. */
  body: string;
  /** Deep link back into the chat. */
  url: string;
}

/**
 * Provider-specific credentials, from NOTIFY_<CHANNEL>_CONFIG (JSON) with
 * `from` merged in from NOTIFY_<CHANNEL>_FROM. Untyped on purpose — each
 * provider validates the fields it needs and says which one is missing.
 */
export interface NotifyProviderConfig {
  /** Sender identity: a From address, a phone number, a messaging service id. */
  from: string;
  [key: string]: unknown;
}

export interface NotifyProvider {
  /** Value of NOTIFY_<CHANNEL>_PROVIDER that selects this one. */
  id: string;
  channel: NotifyChannelId;
  /** Deliver to one address. Throws with a readable message on failure. */
  send(to: string, message: NotifyMessage, config: NotifyProviderConfig): Promise<void>;
}

const registry = new Map<string, NotifyProvider>();

const key = (channel: NotifyChannelId, id: string) => `${channel}:${id}`;

export function registerNotifyProvider(provider: NotifyProvider): void {
  registry.set(key(provider.channel, provider.id), provider);
}

export function getNotifyProvider(
  channel: NotifyChannelId,
  id: string,
): NotifyProvider | undefined {
  return registry.get(key(channel, id));
}

/** Every provider registered for a channel — the admin-facing list of choices. */
export const listNotifyProviders = (channel: NotifyChannelId): NotifyProvider[] =>
  [...registry.values()].filter((p) => p.channel === channel);

/** Test hook: drop everything so a suite can register its own. */
export const clearNotifyProviders = (): void => registry.clear();

/**
 * A missing credential is a deployment mistake, not a runtime surprise — the
 * message names the provider, the field, and the variable it comes from.
 */
export function requireConfig(
  provider: NotifyProvider,
  config: NotifyProviderConfig,
  field: string,
): string {
  const value = config[field];
  if (typeof value !== 'string' || !value) {
    throw new Error(
      `Notification provider "${provider.id}" needs "${field}" — ` +
        `set it in NOTIFY_${provider.channel.toUpperCase()}_CONFIG` +
        (field === 'from' ? ` or NOTIFY_${provider.channel.toUpperCase()}_FROM` : ''),
    );
  }
  return value;
}
