// Needs Contact: the status that means the owner owes someone a call.
//
// Marking it leaves a reminder in the follow-ups panel; moving on from it
// takes that reminder away. The email side lives in outreach.js.

import { logQuietly } from './activity.js';

export const STATUS = 'needs_contact';
export const REMIND_AFTER_HOURS = 24;
const TAG = '"auto":"needs_contact"';

export async function onStatusChange(env, leadId, from, to, actor, nowIso) {
  if (from === to) return;
  if (to === STATUS) {
    const lead = await env.DB.prepare('SELECT name, contact_id FROM leads WHERE id = ?').bind(leadId).first();
    const due = new Date(Date.parse(nowIso) + REMIND_AFTER_HOURS * 3600000).toISOString();
    await logQuietly(env, {
      lead_id: leadId, contact_id: lead ? lead.contact_id : null, type: 'task', actor,
      subject: 'Reach ' + ((lead && lead.name) || 'this lead'),
      due_at: due, meta: { auto: 'needs_contact' }
    }, nowIso);
  } else if (from === STATUS) {
    // Only the reminder this module made. A task the owner wrote by hand
    // is theirs to tick off.
    await env.DB.prepare(
      `UPDATE activities SET completed_at = ?
        WHERE lead_id = ? AND completed_at IS NULL AND due_at IS NOT NULL AND meta LIKE ?`)
      .bind(nowIso, leadId, '%' + TAG + '%').run();
  }
}
