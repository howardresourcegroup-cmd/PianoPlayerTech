// The label a lead gets for how they found us. tests/lead-flow.test.mjs covers
// the same thing end to end; this is the order of the rules, one at a time.
import test from 'node:test';
import assert from 'node:assert';
import { cleanAttribution, leadSource } from '../functions/_lib/attribution.js';

test('nothing known is null, not a guess', () => {
  assert.strictEqual(leadSource(null, {}), null);
  assert.strictEqual(leadSource(null, null), null);
});

test('each signal gets its label', () => {
  const cases = [
    [{ gclid: 'a' }, {}, 'Google Ads'],
    [{ gbraid: 'a' }, {}, 'Google Ads'],
    [{ wbraid: 'a' }, {}, 'Google Ads'],
    [{ fbclid: 'a' }, {}, 'Facebook'],
    [{ utm_source: 'newsletter', utm_medium: 'email' }, {}, 'newsletter / email'],
    [{ utm_source: 'card' }, {}, 'card'],
    [{ referrer: 'www.google.com' }, {}, 'Google search'],
    [{ referrer: 'www.google.co.uk' }, {}, 'Google search'],
    [{ referrer: 'www.bing.com' }, {}, 'Bing search'],
    [{ referrer: 'l.facebook.com' }, {}, 'Facebook'],
    [{ referrer: 'www.instagram.com' }, {}, 'Instagram'],
    [{ referrer: 'www.ptg.org' }, {}, 'Website: ptg.org'],
    [{ landing: '/tuning' }, {}, 'Direct'],
    [null, { heard_about: 'Google Maps' }, 'Google Maps'],
    [null, { heard_about: 'Friend or family', referred_by: 'Sam' }, 'Friend or family: Sam'],
    [null, { heard_about: 'Piano teacher' }, 'Piano teacher'],
    [null, { heard_about: 'Piano teacher', referred_by: 'Pat Lee' }, 'Teacher: Pat Lee'],
    [null, { referring_tech: 'Sam Tuner' }, 'Technician: Sam Tuner']
  ];
  for (const [attr, fields, want] of cases) assert.strictEqual(leadSource(attr, fields), want);
});

test('a teacher beats an ad, an ad beats the dropdown, the dropdown beats a referrer', () => {
  const ad = { gclid: 'a' };
  assert.strictEqual(leadSource(ad, { heard_about: 'Piano teacher', referred_by: 'Pat' }), 'Teacher: Pat');
  assert.strictEqual(leadSource(ad, { heard_about: 'Google search' }), 'Google Ads');
  assert.strictEqual(leadSource({ referrer: 'www.google.com' }, { heard_about: 'Friend or family' }), 'Friend or family');
});

test('a long name cannot make a long label', () => {
  assert.ok(leadSource(null, { heard_about: 'Piano teacher', referred_by: 'x'.repeat(500) }).length <= 120);
});

test('only known keys survive, trimmed and clipped', () => {
  assert.deepStrictEqual(cleanAttribution({ gclid: ' a ', nope: 'b', referrer: '' }), { gclid: 'a' });
  assert.strictEqual(cleanAttribution({ gclid: 'x'.repeat(500) }).gclid.length, 200);
});

test('anything that is not an object is nothing', () => {
  for (const bad of [null, undefined, 'gclid', 7, {}]) assert.strictEqual(cleanAttribution(bad), null);
});
