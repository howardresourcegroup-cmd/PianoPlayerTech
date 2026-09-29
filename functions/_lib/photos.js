// Photos for identification.
//
// An owner of an antique player piano usually does not know what they have.
// Two photos -- the nameplate and the roll mechanism -- answer it. This module
// checks what was uploaded and turns it into one email with attachments.
//
// Nothing is stored. The photos go to the inbox that already receives leads
// and nowhere else, so there is no bucket to secure and nothing to clean up.
//
// An upload endpoint is an invitation, so every limit here is deliberate:
// how many files, how large, and what they actually are -- judged by their
// first bytes, never by the name or type the browser claimed.

export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
export const MAX_NOTE_CHARS = 1000;

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

// What the file is, from its signature. Returns an extension, or '' when it
// is not an image we accept. HEIC is here because it is what an iPhone takes.
export function sniff(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return '';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|heif)$/.test(ascii(8, 12))) return 'heic';
  return '';
}

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };

export function validEmail(s) {
  const v = String(s || '').trim();
  return v.length <= 254 && EMAIL_RE.test(v) ? v : '';
}

// files: [{ bytes: Uint8Array }]. Returns { ok, error, photos }.
// The names we send are our own. A client-supplied filename is attacker
// text headed for an inbox, and we have no use for it.
export function checkUpload(files) {
  if (!files.length) return { ok: false, error: 'Please choose at least one photo.' };
  if (files.length > MAX_PHOTOS) return { ok: false, error: `Please send up to ${MAX_PHOTOS} photos at a time.` };
  let total = 0;
  const photos = [];
  for (let i = 0; i < files.length; i++) {
    const bytes = files[i].bytes;
    if (bytes.length > MAX_PHOTO_BYTES) return { ok: false, error: 'Each photo must be under 5 MB.' };
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) return { ok: false, error: 'Those photos are too large together. Try sending fewer.' };
    const ext = sniff(bytes);
    if (!ext) return { ok: false, error: 'Photos must be JPEG, PNG, WebP or HEIC images.' };
    photos.push({ filename: `photo-${i + 1}.${ext}`, type: MIME[ext], bytes });
  }
  return { ok: true, error: '', photos };
}

// btoa takes a binary string, and building one from megabytes in a single
// call overflows the argument limit, so it is assembled in slices.
export function toBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// The email to us. The subject says PHOTOS so it sorts beside the lead it
// belongs to; reply goes to the customer.
export function buildPhotoEmail(env, { email, name, note, photos }) {
  const to = env.LEAD_NOTIFY_EMAIL || 'info@pianoplayertech.com';
  const from = env.LEAD_FROM_EMAIL || 'PianoPlayerTech <info@pianoplayertech.com>';
  const who = name || email;
  const count = `${photos.length} photo${photos.length === 1 ? '' : 's'}`;
  const text = [
    `PHOTOS FOR IDENTIFICATION`,
    '',
    `${count} from ${who}`,
    email,
    '',
    note ? `Note: ${note}` : '(no note)',
    '',
    'Match these to the message they sent through the form.'
  ].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;font-size:15px;line-height:1.6;color:#241d16;max-width:560px">
  <p style="margin:0 0 .3rem;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#96742a;font-weight:600">Photos for identification</p>
  <h2 style="margin:0 0 1rem;font-size:20px">${esc(count)} from ${esc(who)}</h2>
  <p style="margin:0 0 1rem"><a href="mailto:${esc(email)}" style="color:#96742a">${esc(email)}</a></p>
  ${note ? `<p style="margin:0 0 1rem">${esc(note).replace(/\n/g, '<br>')}</p>` : ''}
  <p style="margin:1.4rem 0 0;padding-top:.9rem;border-top:1px solid #ded3c0;font-size:13px;color:#7a6c5d">Match these to the message they sent through the form.</p>
</div>`;
  return {
    from, to: [to],
    subject: `PHOTOS — ${who}`,
    text, html,
    reply_to: email,
    attachments: photos.map((p) => ({ filename: p.filename, content: toBase64(p.bytes) }))
  };
}
