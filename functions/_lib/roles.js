// Roles, and exactly what each one may do.
//
// Ported from HRG's platform (api/internal/auth/roles.go). Permissions are
// `area.verb`, and every role's list below is written out in full: there is
// no inheritance. "Manager inherits tech" is how a technician quietly ends up
// able to void an invoice, so adding a permission to one role must never add
// it to another.
//
// The server checks these on every request (see ACTION_PERMS in leads.js).
// The client hides what a role cannot do, but only as a convenience: hiding
// a button is not what stops anybody.
//
// docs/users-and-roles.md and tests/roles.test.mjs both carry this matrix.
// Change all three together.

// In the order the Users screen lists them.
export const ROLES = ['owner', 'manager', 'tech', 'viewer'];

// One line each, shown on the Users screen. Kept word for word from HRG so
// the two products describe their roles the same way.
export const ROLE_LABELS = {
  owner: 'Everything, including managing people',
  manager: 'Leads, invoices, accounting and quotes',
  tech: 'Leads only — status, notes and appointments',
  viewer: 'Read-only. No invoices, no accounting'
};

// Every permission there is, by area. Leads covers contacts too: a contact
// is the person behind a lead and is only ever read or written through one.
export const PERMISSIONS = [
  // leads and contacts (a lead with a date is a job)
  'leads.read', 'leads.create', 'leads.update', 'leads.archive', 'leads.delete',
  'leads.export', 'leads.refer',
  // notes, calls, follow-ups and appointments on a lead
  'activities.read', 'activities.write', 'activities.delete',
  // invoices and payments
  'invoices.read', 'invoices.write', 'invoices.void', 'payments.write',
  // automated emails
  'outreach.read', 'outreach.send', 'outreach.configure',
  // contractors and partners (the people table)
  'people.read', 'people.write',
  // the calendar feed, statuses and shared saved views
  'settings.write',
  // this file's subject: who may sign in, and as what
  'users.manage'
];

const GRANTS = {
  owner: [
    'leads.read', 'leads.create', 'leads.update', 'leads.archive', 'leads.delete',
    'leads.export', 'leads.refer',
    'activities.read', 'activities.write', 'activities.delete',
    'invoices.read', 'invoices.write', 'invoices.void', 'payments.write',
    'outreach.read', 'outreach.send', 'outreach.configure',
    'people.read', 'people.write',
    'settings.write',
    'users.manage'
  ],
  // Everything except settings and users.
  manager: [
    'leads.read', 'leads.create', 'leads.update', 'leads.archive', 'leads.delete',
    'leads.export', 'leads.refer',
    'activities.read', 'activities.write', 'activities.delete',
    'invoices.read', 'invoices.write', 'invoices.void', 'payments.write',
    'outreach.read', 'outreach.send', 'outreach.configure',
    'people.read', 'people.write'
  ],
  // Works the jobs: reads and updates leads, logs notes and calls, ticks off
  // follow-ups. No money, no settings, no users, no emails to customers, and
  // contractors read-only.
  tech: [
    'leads.read', 'leads.update',
    'activities.read', 'activities.write',
    'people.read'
  ],
  // Looks, touches nothing, contacts nobody.
  viewer: [
    'leads.read',
    'activities.read',
    'people.read'
  ]
};

export function isRole(role) {
  return Object.prototype.hasOwnProperty.call(GRANTS, role);
}

// An unknown role can do nothing, which is the safe way for a typo in the
// users table to fail.
export function can(role, permission) {
  return isRole(role) && GRANTS[role].includes(permission);
}

// A fresh, sorted copy -- empty for an unknown role.
export function permissionsFor(role) {
  return isRole(role) ? [...GRANTS[role]].sort() : [];
}

export function roleName(role) {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
}
