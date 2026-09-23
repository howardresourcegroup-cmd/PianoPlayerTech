// Telling somebody when the CRM breaks.
//
// Until now a failure was a console.error into Workers logs, which nobody is
// tailing at 2am. This sends an email instead. Three things make that safe
// rather than annoying:
//
// Deduplication. A database outage does not produce one failure, it produces
// one per request. Alerting on each would fill a mailbox in a minute and the
// alerts would be switched off, which is worse than never having had them.
// The same failure is reported once an hour, and the email says how many
// times it happened.
//
// Redaction. An error message is written for a developer and can carry an
// API key, a bearer token, or a customer's email address. Everything that
// looks like a credential or a person is stripped before it is sent, because
// an alert email is a copy of production going somewhere less guarded.
//
// Best effort, always. Alerting runs after the response, never throws, and
// never changes what the user sees. A monitoring system that can take the
// application down with it is worse than no monitoring.

const WINDOW_S = 3600;          // report the same failure at most hourly
const MAX_MESSAGE = 600;

// Things that must never leave the Worker in an email.
const SECRETS = [
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g, '[stripe-key]'],
  [/\bre_[A-Za-z0-9_-]{8,}/g, '[resend-key]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [token]'],
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[long-token]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]']
];

export function redact(text) {
  let s = String(text == null ? '' : text);
  for (const [re, with_] of SECRETS) s = s.replace(re, with_);
  return s.slice(0, MAX_MESSAGE);
}

/**
 * A stable key for "the same failure".
 *
 * Built from where it happened plus the shape of the message, with digits
 * flattened so `lead 41 not found` and `lead 42 not found` are one failure
 * rather than two hundred.
 */
export function signature(where, message) {
  const shape = redact(message).toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return `alert:${String(where || 'unknown').slice(0, 60)}:${shape.slice(0, 120)}`;
}

// KV keys must be safe to round-trip; a signature is free text.
async function keyFor(sig) {
  const bytes = new TextEncoder().encode(sig);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return 'alert:' + [...new Uint8Array(hash)].slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Should this failure be emailed now?
 *
 * Returns {send, seen} -- seen is how many times it has happened inside the
 * current window, so a repeat that does get sent can say so.
 *
 * Without KV there is nowhere to remember, so it falls back to a module-level
 * note. A Worker isolate is reused for a while, so that still absorbs a burst
 * from one isolate; it is weaker than KV and the email says which was used.
 */
const seenHere = new Map();

export async function shouldSend(env, sig, now) {
  const stamp = now instanceof Date ? now.getTime() : Date.now();

  if (!env.RATE_LIMIT) {
    const prev = seenHere.get(sig);
    if (prev && stamp - prev.at < WINDOW_S * 1000) {
      prev.n++;
      return { send: false, seen: prev.n, durable: false };
    }
    seenHere.set(sig, { at: stamp, n: 1 });
    return { send: true, seen: 1, durable: false };
  }

  try {
    const key = await keyFor(sig);
    const raw = await env.RATE_LIMIT.get(key);
    const n = raw ? parseInt(raw, 10) || 0 : 0;
    // The TTL is the window: the counter expiring is what re-arms the alert.
    await env.RATE_LIMIT.put(key, String(n + 1), { expirationTtl: WINDOW_S });
    return { send: n === 0, seen: n + 1, durable: true };
  } catch (err) {
    // KV being unavailable must not swallow the alert.
    console.error('alert dedupe failed', err && err.message);
    return { send: true, seen: 1, durable: false };
  }
}

export function buildEmail(where, message, meta) {
  const lines = [
    `The PianoPlayerTech CRM hit an error.`,
    ``,
    `Where:  ${where}`,
    `When:   ${meta.when}`,
    `Error:  ${message}`
  ];
  if (meta.action) lines.push(`Action: ${meta.action}`);
  if (meta.seen > 1) {
    lines.push(``, `This has happened ${meta.seen} times in the last hour. ` +
      `Further copies are suppressed until the hour is up.`);
  }
  if (!meta.durable) {
    lines.push(``, `(Repeat suppression is running in memory rather than KV, ` +
      `so a busy period may send more than one of these.)`);
  }
  lines.push(``, `Nothing here is a customer record: names, addresses and ` +
    `email addresses are stripped before this is sent.`);
  lines.push(``, `The CRM: https://pianoplayertech.com/leads`);
  return lines.join('\n');
}

/**
 * Report a failure. Never throws.
 *
 * @param where  a short stable label, e.g. 'dashboard action'
 * @param err    the caught error
 * @param opts   {action} the CRM action being attempted, if any
 */
export async function alertError(env, where, err, opts = {}) {
  try {
    const message = redact((err && err.message) || String(err));
    const sig = signature(where, message);
    const now = new Date();
    const { send, seen, durable } = await shouldSend(env, sig, now);
    if (!send) return { sent: false, reason: 'suppressed', seen };

    const to = env.ALERT_EMAIL || env.LEAD_NOTIFY_EMAIL;
    const from = env.LEAD_FROM_EMAIL;
    if (!env.RESEND_API_KEY || !to || !from) {
      return { sent: false, reason: 'not configured', seen };
    }

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from, to,
        subject: `CRM error: ${where}`,
        text: buildEmail(where, message, { when: now.toISOString(), action: opts.action, seen, durable })
      })
    });
    if (!r.ok) {
      console.error('alert email rejected', r.status);
      return { sent: false, reason: 'rejected', seen };
    }
    return { sent: true, seen };
  } catch (e) {
    // The whole point is that this cannot break the request it reports on.
    console.error('alerting itself failed', e && e.message);
    return { sent: false, reason: 'threw' };
  }
}
