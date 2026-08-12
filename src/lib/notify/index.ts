/**
 * Notification delivery — which channels this deployment can actually reach a
 * person on, and how a message gets there.
 *
 * A channel is "available" only when BOTH halves exist: the deployment
 * configured a provider for it, and the person has an address on it. The UI
 * asks the same question this module answers, so a channel nobody can be
 * reached on is never offered as a choice in the first place.
 *
 * Configuration is per channel, three variables each — the provider id, the
 * sender identity, and a JSON blob of whatever credentials that provider
 * needs. Vendor-specific variables (TWILIO_*, SENDGRID_*, …) would mean the
 * env schema grows a section per provider anyone ever adds.
 */
import { env } from '@/lib/env';
import { registerBuiltinNotifyProviders } from './providers';
import {
  NOTIFY_CHANNELS,
  getNotifyProvider,
  type NotifyChannelId,
  type NotifyMessage,
  type NotifyProvider,
  type NotifyProviderConfig,
} from './types';

export * from './types';

// Registries are keyed Maps; a second call replaces rather than duplicates.
// Done at import so every consumer (delivery, the API listing the choices)
// sees the same set without an init step that one of them could skip.
registerBuiltinNotifyProviders();

interface ChannelSetup {
  provider: NotifyProvider;
  config: NotifyProviderConfig;
}

const CHANNEL_ENV: Record<
  NotifyChannelId,
  { provider: 'NOTIFY_EMAIL_PROVIDER' | 'NOTIFY_SMS_PROVIDER'; from: string; config: string }
> = {
  email: { provider: 'NOTIFY_EMAIL_PROVIDER', from: 'NOTIFY_EMAIL_FROM', config: 'NOTIFY_EMAIL_CONFIG' },
  sms: { provider: 'NOTIFY_SMS_PROVIDER', from: 'NOTIFY_SMS_FROM', config: 'NOTIFY_SMS_CONFIG' },
};

/**
 * Resolve a channel's provider and credentials, or null when this deployment
 * has not configured it.
 *
 * Not cached: env() is, and a bad NOTIFY_*_CONFIG must not be able to poison
 * a resolved setup for the life of the process.
 */
export function channelSetup(channel: NotifyChannelId): ChannelSetup | null {
  const names = CHANNEL_ENV[channel];
  const e = env() as unknown as Record<string, string | undefined>;
  const id = e[names.provider];
  if (!id) return null;

  const provider = getNotifyProvider(channel, id);
  if (!provider) {
    console.warn(`[notify] ${names.provider}="${id}" is not a registered ${channel} provider`);
    return null;
  }

  let config: Record<string, unknown> = {};
  const raw = e[names.config];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('expected a JSON object');
      }
      config = parsed as Record<string, unknown>;
    } catch (err) {
      console.warn(
        `[notify] ${names.config} is not valid JSON (${err instanceof Error ? err.message : err}) — ${channel} notifications are off`,
      );
      return null;
    }
  }

  return { provider, config: { ...config, from: e[names.from] ?? (config.from as string) ?? '' } };
}

/** Channels this deployment has a working provider for. */
export const configuredChannels = (): NotifyChannelId[] =>
  NOTIFY_CHANNELS.filter((c) => channelSetup(c) !== null);

/** Where a channel delivers for this person, or null if they have no address. */
export function addressFor(
  channel: NotifyChannelId,
  user: { email?: string | null; phone?: string | null },
): string | null {
  const address = channel === 'email' ? user.email : user.phone;
  return address?.trim() || null;
}

/** Send one message. Throws when the channel is unconfigured or delivery fails. */
export async function deliver(
  channel: NotifyChannelId,
  to: string,
  message: NotifyMessage,
): Promise<void> {
  const setup = channelSetup(channel);
  if (!setup) throw new Error(`No ${channel} provider configured (${CHANNEL_ENV[channel].provider})`);
  await setup.provider.send(to, message, setup.config);
}

/**
 * E.164, the only format every SMS provider agrees on: a leading + and 8–15
 * digits. Spaces, dashes and parentheses are how humans write numbers, so
 * they are stripped rather than rejected.
 */
export function normalizePhone(input: string): string | null {
  const compact = input.replace(/[\s()\-./]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}
