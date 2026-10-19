// The role/permission matrix, written out in full.
//
// This is the same table as docs/users-and-roles.md. It is spelled out here
// rather than derived from roles.js, so that a permission quietly added to a
// role fails a test instead of shipping.

import test from 'node:test';
import assert from 'node:assert';
import {
  ROLES, ROLE_LABELS, PERMISSIONS, can, isRole, permissionsFor
} from '../functions/_lib/roles.js';

const MATRIX = {
  owner: [
    'activities.delete', 'activities.read', 'activities.write',
    'invoices.read', 'invoices.void', 'invoices.write',
    'leads.archive', 'leads.create', 'leads.delete', 'leads.export', 'leads.read', 'leads.refer', 'leads.update',
    'outreach.configure', 'outreach.read', 'outreach.send',
    'payments.write',
    'people.read', 'people.write',
    'settings.write',
    'users.manage'
  ],
  manager: [
    'activities.delete', 'activities.read', 'activities.write',
    'invoices.read', 'invoices.void', 'invoices.write',
    'leads.archive', 'leads.create', 'leads.delete', 'leads.export', 'leads.read', 'leads.refer', 'leads.update',
    'outreach.configure', 'outreach.read', 'outreach.send',
    'payments.write',
    'people.read', 'people.write'
  ],
  tech: [
    'activities.read', 'activities.write',
    'leads.read', 'leads.update',
    'people.read'
  ],
  viewer: [
    'activities.read',
    'leads.read',
    'people.read'
  ]
};

test('the four roles, in order', () => {
  assert.deepStrictEqual(ROLES, ['owner', 'manager', 'tech', 'viewer']);
});

test('each role has exactly the permissions in the matrix', () => {
  for (const role of ROLES) {
    assert.deepStrictEqual(permissionsFor(role), MATRIX[role], `${role} drifted from the matrix`);
  }
});

test('every cell of the matrix agrees with can()', () => {
  for (const role of ROLES) {
    for (const p of PERMISSIONS) {
      assert.strictEqual(can(role, p), MATRIX[role].includes(p), `${role} / ${p}`);
    }
  }
});

test('owner has every permission there is', () => {
  assert.deepStrictEqual(permissionsFor('owner'), [...PERMISSIONS].sort());
});

test('manager is everything except users and settings', () => {
  const missing = PERMISSIONS.filter((p) => !can('manager', p)).sort();
  assert.deepStrictEqual(missing, ['settings.write', 'users.manage']);
});

test('tech touches no money, settings, users or customer email, and only reads contractors', () => {
  for (const p of PERMISSIONS) {
    if (/^(invoices|payments|settings|users|outreach)\./.test(p)) assert.strictEqual(can('tech', p), false, p);
  }
  assert.strictEqual(can('tech', 'people.read'), true);
  assert.strictEqual(can('tech', 'people.write'), false);
  assert.strictEqual(can('tech', 'leads.refer'), false, 'a referral emails World Class and the customer');
});

test('viewer only reads, and contacts nobody', () => {
  for (const p of permissionsFor('viewer')) assert.match(p, /\.read$/);
  for (const p of ['leads.refer', 'outreach.send', 'activities.write', 'leads.export']) {
    assert.strictEqual(can('viewer', p), false, p);
  }
});

test('no role is granted a permission that does not exist', () => {
  for (const role of ROLES) {
    for (const p of permissionsFor(role)) assert.ok(PERMISSIONS.includes(p), `${role}: ${p}`);
  }
});

test('an unknown role can do nothing', () => {
  assert.strictEqual(isRole('admin'), false);
  assert.strictEqual(can('admin', 'leads.read'), false);
  assert.strictEqual(can('', 'leads.read'), false);
  assert.strictEqual(can(undefined, 'leads.read'), false);
  assert.strictEqual(can('constructor', 'leads.read'), false);
  assert.deepStrictEqual(permissionsFor('admin'), []);
});

test('the one-line labels are the HRG ones', () => {
  assert.deepStrictEqual(ROLE_LABELS, {
    owner: 'Everything, including managing people',
    manager: 'Leads, invoices, accounting and quotes',
    tech: 'Leads only — status, notes and appointments',
    viewer: 'Read-only. No invoices, no accounting'
  });
});

test('permissionsFor hands out a copy', () => {
  permissionsFor('viewer').push('users.manage');
  assert.strictEqual(can('viewer', 'users.manage'), false);
});
