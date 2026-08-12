/**
 * Built-in notification providers.
 *
 * SMS:   twilio | notifme | logger
 * Email: resend | notifme | logger
 *
 * Two of these are libraries doing the work rather than hand-rolled HTTP:
 *
 *  - `twilio` is the official SDK. Twilio has more surface than a POST — API
 *    keys vs account tokens, regional accounts whose credentials the default
 *    host rejects with a bare 401, edges, retries, typed error codes. Every
 *    one of those was a bug found by hand here before it was a line of config.
 *  - `notifme` is notifme-sdk, which is the same idea one level up: one config
 *    shape over a dozen vendors per channel (smtp, sendgrid, ses, mailgun,
 *    sparkpost, mandrill / nexmo, plivo, clickatell, infobip, ovh, …), plus
 *    fallback and round-robin across several of them. Reaching a new vendor is
 *    a `type` in NOTIFY_<CHANNEL>_CONFIG, not a file in this directory.
 *
 * `resend` stays hand-written because notifme has no Resend provider and the
 * whole of it is one authenticated POST. `logger` is the dry run: it delivers
 * to the server log, so a deployment can prove the wiring before handing
 * anyone's phone number to a vendor.
 */
import {
  registerNotifyProvider,
  requireConfig,
  type NotifyChannelId,
  type NotifyMessage,
  type NotifyProvider,
  type NotifyProviderConfig,
} from './types';

/** Vendor errors are the whole diagnosis — never swallow the response body. */
async function failed(provider: string, res: Response): Promise<never> {
  const detail = await res.text().catch(() => '');
  throw new Error(
    `${provider} rejected the message (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
  );
}

/** SMS has no subject line — the link is the point, so it always rides along. */
const smsText = (message: NotifyMessage): string => `${message.subject}\n${message.url}`;

/** Email body: the sentence, then the link on its own line. */
const emailText = (message: NotifyMessage): string => `${message.body}\n\n${message.url}\n`;

// ── SMS ───────────────────────────────────────────────────────────────────

const twilio: NotifyProvider = {
  id: 'twilio',
  channel: 'sms',
  async send(to, message, config) {
    // The account is named separately from whoever signs the request: an API
    // key (SK…) authenticates as itself but still acts ON an account, and an
    // SK in the REST path is a 404 that reads like a wrong phone number.
    const accountSid = requireConfig(twilio, config, 'accountSid');
    const from = requireConfig(twilio, config, 'from');

    // Two credentials over one field. An API key pair is revocable on its
    // own; rotating the account auth token invalidates everything at once.
    const apiKeySid = typeof config.apiKeySid === 'string' ? config.apiKeySid : '';
    const username = apiKeySid || accountSid;
    const password = apiKeySid
      ? requireConfig(twilio, config, 'apiKeySecret')
      : requireConfig(twilio, config, 'authToken');

    const { default: createClient } = await import('twilio');
    const client = createClient(username, password, {
      // Needed when the API key signs: the SDK cannot infer which account.
      accountSid,
      // An account homed outside the default region (ie1, au1, sg1 …) answers
      // on its own host, and the default one rejects its credentials with the
      // same 401 as a wrong password.
      ...(typeof config.region === 'string' && config.region && config.region !== 'us1'
        ? { region: config.region }
        : {}),
      ...(typeof config.edge === 'string' && config.edge ? { edge: config.edge } : {}),
    });

    // `from` doubles as a Messaging Service SID (MG…), which is a different
    // parameter to Twilio even though it is the same field to a human.
    const sender = from.startsWith('MG') ? { messagingServiceSid: from } : { from };
    await client.messages.create({ ...sender, to, body: smsText(message) });
  },
};

// ── Email ─────────────────────────────────────────────────────────────────

const resend: NotifyProvider = {
  id: 'resend',
  channel: 'email',
  async send(to, message, config) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requireConfig(resend, config, 'apiKey')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: requireConfig(resend, config, 'from'),
        to: [to],
        subject: message.subject,
        text: emailText(message),
      }),
    });
    if (!res.ok) await failed('Resend', res);
  },
};

// ── Everything else, through notifme-sdk ──────────────────────────────────

/**
 * One provider id per channel that reaches every vendor notifme supports.
 *
 * NOTIFY_<CHANNEL>_CONFIG *is* notifme's own provider descriptor, so its
 * documentation is the documentation:
 *
 *   {"type":"smtp","host":"…","port":587,"auth":{"user":"…","pass":"…"}}
 *   {"type":"sendgrid","apiKey":"…"}
 *   {"type":"nexmo","apiKey":"…","apiSecret":"…"}
 *
 * Several vendors at once — notifme's reason to exist — by giving `providers`
 * instead, with an optional strategy:
 *
 *   {"providers":[{"type":"sendgrid",…},{"type":"smtp",…}],
 *    "multiProviderStrategy":"fallback"}
 */
const notifme = (channel: NotifyChannelId): NotifyProvider => {
  const provider: NotifyProvider = {
    id: 'notifme',
    channel,
    async send(to, message, config) {
      const from = requireConfig(provider, config, 'from');
      const { from: _from, providers, multiProviderStrategy, ...single } = config;

      const list = Array.isArray(providers) ? providers : [single];
      if (list.length === 0 || !list.every((p) => p && typeof (p as { type?: unknown }).type === 'string')) {
        throw new Error(
          `notifme needs a "type" (e.g. {"type":"smtp",…}) or a "providers" array of them — ` +
            `set it in NOTIFY_${channel.toUpperCase()}_CONFIG`,
        );
      }

      const { default: NotifmeSdk } = await import('notifme-sdk');
      const sdk = new NotifmeSdk({
        channels: {
          [channel]: {
            providers: list as Array<{ type: string }>,
            ...(typeof multiProviderStrategy === 'string' ? { multiProviderStrategy } : {}),
          },
        },
      });
      // notifme's winston logger prints every notification it handles at info
      // level — recipient address included, which is PII this app has no
      // reason to put in a log file — and prints failures a second time on
      // top of the throw below. Silence beats mute(): with no transports and
      // no silent flag, winston warns about the missing transports instead,
      // once per send. (The dry run is our own `logger` PROVIDER id, not
      // notifme's `{"type":"logger"}`, which goes quiet along with the rest.)
      (sdk.logger as unknown as { configure(o: unknown): void }).configure({
        transports: [],
        silent: true,
      });

      const result = await sdk.send(
        channel === 'email'
          ? { email: { from, to, subject: message.subject, text: emailText(message) } }
          : { sms: { from, to, text: smsText(message) } },
      );
      if (result.status !== 'success') {
        // The per-channel error carries the vendor's own words; the status
        // alone would only say that something, somewhere, did not send.
        const err = result.errors?.[channel];
        throw new Error(
          `notifme could not send the ${channel}: ${err instanceof Error ? err.message : (err ?? 'no detail')}`,
        );
      }
    },
  };
  return provider;
};

// ── Dry run ───────────────────────────────────────────────────────────────

const loggerProvider = (channel: NotifyChannelId): NotifyProvider => ({
  id: 'logger',
  channel,
  async send(to: string, message: NotifyMessage, _config: NotifyProviderConfig) {
    console.log(`[notify:${channel}] → ${to}: ${message.subject} ${message.url}`);
  },
});

export function registerBuiltinNotifyProviders(): void {
  registerNotifyProvider(twilio);
  registerNotifyProvider(resend);
  for (const channel of ['sms', 'email'] as const) {
    registerNotifyProvider(notifme(channel));
    registerNotifyProvider(loggerProvider(channel));
  }
}
