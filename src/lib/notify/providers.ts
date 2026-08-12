/**
 * Built-in notification providers.
 *
 * SMS:   twilio | vonage | logger
 * Email: smtp   | resend | logger
 *
 * The HTTP ones are a fetch and a status check — a vendor SDK per provider
 * would be more dependency than transaction. SMTP is the exception: speaking
 * it is a protocol, not a request, so nodemailer does it (zero dependencies,
 * and one transport already covers every provider that offers an SMTP relay).
 *
 * `logger` exists for the same reason a dry run does: a deployment can arm
 * notifications, watch them fire in the log, and never hand a phone number to
 * a vendor to find out whether the wiring works.
 */
import {
  registerNotifyProvider,
  requireConfig,
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

// ── SMS ───────────────────────────────────────────────────────────────────

const twilio: NotifyProvider = {
  id: 'twilio',
  channel: 'sms',
  async send(to, message, config) {
    // The URL always names the ACCOUNT (AC…), whoever signs the request.
    const accountSid = requireConfig(twilio, config, 'accountSid');
    const from = requireConfig(twilio, config, 'from');

    // Twilio accepts two credentials over the same basic-auth field. An API
    // key pair (SK… + secret) is what the console hands out and what can be
    // revoked on its own; the account's auth token is the older form and
    // rotating it invalidates everything at once. Neither is derivable from
    // the other, and an SK in the username with no account sid in the path is
    // a 404 that reads like a wrong phone number — so the two are separate
    // fields and the account sid is required either way.
    const apiKeySid = typeof config.apiKeySid === 'string' ? config.apiKeySid : '';
    const user = apiKeySid || accountSid;
    const pass = apiKeySid
      ? requireConfig(twilio, config, 'apiKeySecret')
      : requireConfig(twilio, config, 'authToken');

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: smsText(message) }),
      },
    );
    if (!res.ok) await failed('Twilio', res);
  },
};

const vonage: NotifyProvider = {
  id: 'vonage',
  channel: 'sms',
  async send(to, message, config) {
    const res = await fetch('https://rest.nexmo.com/sms/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        api_key: requireConfig(vonage, config, 'apiKey'),
        api_secret: requireConfig(vonage, config, 'apiSecret'),
        // Alphanumeric sender ids are legal here, so this is not a number.
        from: requireConfig(vonage, config, 'from'),
        to,
        text: smsText(message),
      }),
    });
    if (!res.ok) await failed('Vonage', res);
    // Vonage answers 200 for a rejected message — the verdict is in the body.
    const data = (await res.json().catch(() => null)) as {
      messages?: Array<{ status?: string; 'error-text'?: string }>;
    } | null;
    const first = data?.messages?.[0];
    if (first && first.status !== '0') {
      throw new Error(
        `Vonage rejected the message (status ${first.status}): ${first['error-text'] ?? 'no detail'}`,
      );
    }
  },
};

// ── Email ─────────────────────────────────────────────────────────────────

const smtp: NotifyProvider = {
  id: 'smtp',
  channel: 'email',
  async send(to, message, config) {
    const { host, port, secure, auth } = config as {
      host?: unknown;
      port?: unknown;
      secure?: unknown;
      auth?: unknown;
    };
    if (typeof host !== 'string' || !host) {
      throw new Error('SMTP needs "host" — set it in NOTIFY_EMAIL_CONFIG');
    }
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host,
      port: typeof port === 'number' ? port : 587,
      // Implicit TLS on 465, STARTTLS everywhere else — the same rule every
      // provider's setup page states, so nobody has to pass `secure` at all.
      secure: typeof secure === 'boolean' ? secure : port === 465,
      ...(auth ? { auth: auth as { user: string; pass: string } } : {}),
    });
    try {
      await transport.sendMail({
        from: requireConfig(smtp, config, 'from'),
        to,
        subject: message.subject,
        text: `${message.body}\n\n${message.url}\n`,
      });
    } finally {
      // Long-lived pools would keep a socket open per deployment for a mail
      // sent minutes apart at best; this is a one-shot transport.
      transport.close();
    }
  },
};

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
        text: `${message.body}\n\n${message.url}\n`,
      }),
    });
    if (!res.ok) await failed('Resend', res);
  },
};

// ── Dry run ───────────────────────────────────────────────────────────────

const loggerProvider = (channel: 'email' | 'sms'): NotifyProvider => ({
  id: 'logger',
  channel,
  async send(to: string, message: NotifyMessage, _config: NotifyProviderConfig) {
    console.log(`[notify:${channel}] → ${to}: ${message.subject} ${message.url}`);
  },
});

export function registerBuiltinNotifyProviders(): void {
  registerNotifyProvider(twilio);
  registerNotifyProvider(vonage);
  registerNotifyProvider(smtp);
  registerNotifyProvider(resend);
  registerNotifyProvider(loggerProvider('sms'));
  registerNotifyProvider(loggerProvider('email'));
}
