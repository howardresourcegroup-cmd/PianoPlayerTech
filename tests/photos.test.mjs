// Photo upload.
//
// The ways this turns bad: it accepts something that is not a photo, it
// accepts too much, it lets a stranger's text into our inbox as a filename,
// or it tells a customer their photos arrived when they did not.

import test from 'node:test';
import assert from 'node:assert';
import {
  sniff, validEmail, checkUpload, toBase64, buildPhotoEmail,
  MAX_PHOTOS, MAX_PHOTO_BYTES
} from '../functions/_lib/photos.js';
import { onRequestPost } from '../functions/api/photos.js';

// Node provides these as globals; the lint config only lists the older ones.
const { FormData, File, Request } = globalThis;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72]);
const ascii = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const WEBP = ascii('RIFF\x00\x00\x00\x00WEBPVP8 ');
const HEIC = new Uint8Array([0, 0, 0, 24, ...ascii('ftypheic'), 0, 0, 0, 0]);
const HTML = ascii('<html><script>alert(1)</script></html>');
const PDF = ascii('%PDF-1.7 not an image at all');

// ------------------------------------------------------------------ sniffing
test('real image types are recognised by their first bytes', () => {
  assert.strictEqual(sniff(JPEG), 'jpg');
  assert.strictEqual(sniff(PNG), 'png');
  assert.strictEqual(sniff(WEBP), 'webp');
  assert.strictEqual(sniff(HEIC), 'heic');
});

test('a file that is not an image is refused whatever it is called', () => {
  assert.strictEqual(sniff(HTML), '');
  assert.strictEqual(sniff(PDF), '');
  assert.strictEqual(sniff(new Uint8Array([1, 2, 3])), '');
  assert.strictEqual(sniff(null), '');
});

// ------------------------------------------------------------------ limits
test('no photos, too many photos, and an oversized photo are each refused', () => {
  assert.strictEqual(checkUpload([]).ok, false);
  const many = Array.from({ length: MAX_PHOTOS + 1 }, () => ({ bytes: JPEG }));
  assert.strictEqual(checkUpload(many).ok, false);
  const big = new Uint8Array(MAX_PHOTO_BYTES + 1); big.set(JPEG);
  assert.strictEqual(checkUpload([{ bytes: big }]).ok, false);
});

test('one bad file refuses the whole upload', () => {
  const r = checkUpload([{ bytes: JPEG }, { bytes: HTML }]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /JPEG, PNG, WebP or HEIC/);
});

test('accepted photos are renamed by us, in order', () => {
  const r = checkUpload([{ bytes: JPEG }, { bytes: PNG }, { bytes: HEIC }]);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.photos.map((p) => p.filename), ['photo-1.jpg', 'photo-2.png', 'photo-3.heic']);
});

// ------------------------------------------------------------------ email
test('an address with markup or spaces in it is not an address', () => {
  assert.strictEqual(validEmail('dana@example.com'), 'dana@example.com');
  for (const bad of ['', 'dana', 'a@b', 'a b@example.com', '"><img>@example.com', 'x@example.com\nBcc: y@z.com']) {
    assert.strictEqual(validEmail(bad), '', bad);
  }
});

test('base64 survives more bytes than one call to fromCharCode allows', () => {
  const bytes = new Uint8Array(200000).map((_, i) => i % 251);
  assert.deepStrictEqual(new Uint8Array(Buffer.from(toBase64(bytes), 'base64')), bytes);
});

test('the email goes to us, replies go to the customer, and text is escaped', () => {
  const { photos } = checkUpload([{ bytes: JPEG }]);
  const mail = buildPhotoEmail({}, { email: 'dana@example.com', name: '<b>Dana</b>', note: 'Ampico? <script>', photos });
  assert.deepStrictEqual(mail.to, ['info@pianoplayertech.com']);
  assert.strictEqual(mail.reply_to, 'dana@example.com');
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(!mail.html.includes('<b>Dana</b>'));
  assert.strictEqual(mail.attachments.length, 1);
  assert.strictEqual(mail.attachments[0].filename, 'photo-1.jpg');
});

// ------------------------------------------------------------------ handler
function post(files, fields = { email: 'dana@example.com' }, headers = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  files.forEach((bytes, i) => fd.append('photos', new File([bytes], `../../evil-${i}.exe`, { type: 'image/jpeg' })));
  return new Request('https://pianoplayertech.com/api/photos', {
    method: 'POST', body: fd,
    headers: { Origin: 'https://pianoplayertech.com', Accept: 'application/json', ...headers }
  });
}

async function run(request, env, resend) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return resend(); };
  try {
    const res = await onRequestPost({ request, env });
    return { res, calls, json: await res.clone().json().catch(() => null) };
  } finally {
    globalThis.fetch = real;
  }
}

const ENV = { RESEND_API_KEY: 'test-key' };
const OK = () => new Response('{}', { status: 200 });

test('a good upload is emailed once, under our filenames, and reported as received', async () => {
  const { res, calls, json } = await run(post([JPEG, PNG]), ENV, OK);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(json.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].body.attachments.map((a) => a.filename), ['photo-1.jpg', 'photo-2.png']);
  assert.ok(!JSON.stringify(calls[0].body).includes('evil'));
});

test('a request from another site is refused before anything is read', async () => {
  const { res, calls } = await run(post([JPEG], undefined, { Origin: 'https://example.com' }), ENV, OK);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(calls.length, 0);
});

test('a request that names no origin is refused', async () => {
  const fd = new FormData(); fd.append('email', 'dana@example.com');
  const req = new Request('https://pianoplayertech.com/api/photos', { method: 'POST', body: fd, headers: { Accept: 'application/json' } });
  const { res } = await run(req, ENV, OK);
  assert.strictEqual(res.status, 403);
});

test('with email not configured the customer is told, not reassured', async () => {
  const { res, json, calls } = await run(post([JPEG]), {}, OK);
  assert.strictEqual(res.status, 503);
  assert.strictEqual(json.ok, false);
  assert.match(json.message, /info@pianoplayertech\.com/);
  assert.strictEqual(calls.length, 0);
});

test('when the email provider fails the customer is told to email instead', async () => {
  const { res, json } = await run(post([JPEG]), ENV, () => new Response('nope', { status: 500 }));
  assert.strictEqual(res.status, 502);
  assert.strictEqual(json.ok, false);
  assert.match(json.message, /info@pianoplayertech\.com/);
});

test('a disguised file, a missing email and an empty upload send nothing', async () => {
  for (const req of [post([HTML]), post([JPEG], { email: 'not-an-address' }), post([])]) {
    const { res, calls } = await run(req, ENV, OK);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(calls.length, 0);
  }
});

test('the fourth upload from one address inside the window is refused', async () => {
  const store = new Map();
  const kv = { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); } };
  const env = { ...ENV, RATE_LIMIT: kv };
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const { res } = await run(post([JPEG], undefined, { 'CF-Connecting-IP': '203.0.113.9' }), env, OK);
    statuses.push(res.status);
  }
  assert.deepStrictEqual(statuses, [200, 200, 200, 429]);
});

test('without scripts a good upload lands on the thank-you page', async () => {
  const { res } = await run(post([JPEG], undefined, { Accept: 'text/html' }), ENV, OK);
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get('Location'), 'https://pianoplayertech.com/thank-you');
});
