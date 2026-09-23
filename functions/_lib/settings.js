// The small key/value store, and the calendar token that lives in it.
//
// The token is in the database rather than an environment variable so it can
// be rotated from the dashboard without a redeploy. Rotating is the only
// revocation a calendar subscription has: there is no session to end and no
// cookie to clear, so the ability to do it in one click matters.

export const CALENDAR_TOKEN = 'calendar_token';

export async function getSetting(env, key) {
  try {
    const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    return r ? r.value : null;
  } catch (err) {
    // A database without the settings table must not take the dashboard
    // down; the feature that needs the setting simply stays off.
    console.error('settings unavailable', key, err && err.message);
    return null;
  }
}

export async function setSetting(env, key, value, now) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(key, value, now).run();
  return value;
}

// 32 bytes, base64url. Long enough that guessing is not a threat model, and
// URL-safe so it survives being pasted into a calendar client.
export function newToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Only creates one if asked. The feed is off until somebody turns it on,
// because the URL is a bearer credential for customer names and addresses.
export async function getCalendarToken(env, { create = false } = {}) {
  const existing = await getSetting(env, CALENDAR_TOKEN);
  if (existing || !create) return existing;
  return await setSetting(env, CALENDAR_TOKEN, newToken(), new Date().toISOString());
}

export async function rotateCalendarToken(env) {
  return await setSetting(env, CALENDAR_TOKEN, newToken(), new Date().toISOString());
}

export async function disableCalendar(env) {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(CALENDAR_TOKEN).run();
}
