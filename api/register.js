import { put } from '@vercel/blob';
import postgres from 'postgres';
import Busboy from 'busboy';

export const maxDuration = 60;
export const config = { api: { bodyParser: false } };

const sql = postgres(process.env.POSTGRES_URL, { ssl: 'require' });

const LATIN_RE = /^[A-Za-z\s'\-\.]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d][\d\s().\-]{5,}$/;
const ALLOWED_GENDERS = ['Female','Male'];
const ALLOWED_MIME    = ['image/jpeg','image/png','image/webp'];
const MAX_BYTES       = 4 * 1024 * 1024;

function parseMultipart(req){
  return new Promise((resolve, reject) => {
    const fields = {};
    let photo = null;
    let photoTooLarge = false;

    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { fileSize: MAX_BYTES + 1, files: 1, fields: 30 }
      });
    } catch (err) { return reject(err); }

    bb.on('field', (name, value) => { fields[name] = String(value).trim(); });

    bb.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', chunk => chunks.push(chunk));
      file.on('limit', () => { photoTooLarge = true; });
      file.on('end', () => {
        if (!photoTooLarge){
          photo = {
            buffer: Buffer.concat(chunks),
            filename: info.filename || 'photo.jpg',
            mimeType: info.mimeType || 'application/octet-stream',
          };
        }
      });
    });

    bb.on('close', () => {
      if (photoTooLarge) reject(new Error('PHOTO_TOO_LARGE'));
      else resolve({ fields, photo });
    });
    bb.on('error', reject);

    req.pipe(bb);
  });
}

export default async function handler(req, res){
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const t0 = Date.now();
  console.log('[register] start');

  try {
    const { fields, photo } = await parseMultipart(req);
    console.log('[register] form parsed', { elapsedMs: Date.now() - t0 });

    const familyName       = fields.familyName       || '';
    const givenName        = fields.givenName        || '';
    const gender           = fields.gender           || '';
    const countryBirth     = fields.countryBirth     || '';
    const countryResidence = fields.countryResidence || '';
    const dateOfBirth      = fields.dateOfBirth      || '';
    const email            = fields.email            || '';
    const phone            = fields.phone            || '';
    const affiliationCode  = fields.affiliationCode  || '';
    const chineseName      = fields.chineseName      || '';
    const consent          = fields.consent          || '';

    if (consent !== '1'){
      return res.status(400).json({ error: 'Authorisation to store personal data is required.' });
    }

    if (!familyName || !givenName || !gender || !countryBirth || !countryResidence
        || !dateOfBirth || !email || !phone || !affiliationCode){
      return res.status(400).json({ error: 'Please complete all required fields.' });
    }
    if (!LATIN_RE.test(familyName) || !LATIN_RE.test(givenName)){
      return res.status(400).json({ error: 'Name fields must contain Latin letters only (no accents).' });
    }
    if (!ALLOWED_GENDERS.includes(gender)){
      return res.status(400).json({ error: 'Invalid gender value.' });
    }
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid e-mail address.' });
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Invalid phone number.' });

    /* Date arrives as mm/dd/yyyy. Validate and convert to ISO yyyy-mm-dd for Postgres. */
    const dobMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateOfBirth);
    if (!dobMatch){
      return res.status(400).json({ error: 'Invalid date of birth (expected mm/dd/yyyy).' });
    }
    const dobM = Number(dobMatch[1]);
    const dobD = Number(dobMatch[2]);
    const dobY = Number(dobMatch[3]);
    const dobJs = new Date(dobY, dobM - 1, dobD);
    if (dobJs.getFullYear() !== dobY || dobJs.getMonth() !== dobM - 1 || dobJs.getDate() !== dobD
        || dobJs > new Date()){
      return res.status(400).json({ error: 'Invalid date of birth.' });
    }
    const dobIso = `${dobY}-${String(dobM).padStart(2,'0')}-${String(dobD).padStart(2,'0')}`;
    if (!photo || !photo.buffer || photo.buffer.length === 0){
      return res.status(400).json({ error: 'A profile photograph is required.' });
    }
    if (!ALLOWED_MIME.includes(photo.mimeType)){
      return res.status(400).json({ error: 'Photograph must be JPG, PNG or WEBP.' });
    }

    console.log('[register] validation OK');

    /* Upload photo to private Vercel Blob using access: 'private' */
    const sanitize = s => s.replace(/[^A-Za-z0-9]/g, '_');
    const ext      = (photo.filename.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
    const pathname = `photos/${sanitize(familyName)}_${sanitize(givenName)}_${Date.now()}.${ext}`;

    console.log('[register] uploading blob:', pathname);
    const blob = await put(pathname, photo.buffer, {
      access: 'public',
      contentType: photo.mimeType,
      addRandomSuffix: false,
    });
    console.log('[register] blob uploaded', { elapsedMs: Date.now() - t0, returnedUrl: blob.url });

    /* Store the public URL directly in the DB so the admin can fetch it without a proxy */
    console.log('[register] inserting row...');
    const rows = await sql`
      INSERT INTO registrations
        (family_name, given_name, gender, country_birth, country_residence,
         date_of_birth, email, phone, affiliation_code, photo_url, chinese_name)
      VALUES
        (${familyName}, ${givenName}, ${gender}, ${countryBirth}, ${countryResidence},
         ${dobIso}, ${email}, ${phone}, ${affiliationCode}, ${blob.url}, ${chineseName || null})
      RETURNING id
    `;
    console.log('[register] row inserted', { elapsedMs: Date.now() - t0, id: rows[0].id });

    /* === Notification email — must await so Vercel doesn't kill the function
       before the fetch to Resend completes. Errors don't fail the registration. === */
    console.log('[register] sending notification email...');
    try {
      await sendNotificationEmail({
        id: rows[0].id,
        familyName, givenName, gender,
        countryBirth, countryResidence,
        dateOfBirth: dobIso, email, phone,
        affiliationCode, chineseName,
        photoUrl: blob.url,
      });
    } catch (err) {
      console.warn('[register] email notification failed:', err?.message || err);
    }
    console.log('[register] handler done, returning success');

    return res.status(200).json({ success: true, id: rows[0].id });

  } catch (err) {
    console.error('[register] error after', Date.now() - t0, 'ms:', err);
    if (err && err.message === 'PHOTO_TOO_LARGE'){
      return res.status(413).json({ error: 'Photograph too large (max 4 MB).' });
    }
    return res.status(500).json({ error: `Server error: ${err?.message || 'unknown'}` });
  }
}

/* === Email notification via Resend (https://resend.com) ===
   Set RESEND_API_KEY in Vercel → Settings → Environment Variables.
   Optional: NOTIFY_FROM (defaults to onboarding@resend.dev — works without
   verifying a domain but mails will say "via resend.dev"). */
async function sendNotificationEmail(data){
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey){
    console.log('[email] RESEND_API_KEY not set — skipping email');
    return;
  }

  const from = process.env.NOTIFY_FROM || 'WBF Registrations <onboarding@resend.dev>';
  const to = ['info@worldbridge.org', 'registration@worldbridge.org'];
  const refId = 'WBF-' + String(data.id).padStart(6, '0');

  const esc = s => String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const dobDisplay = (() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.dateOfBirth);
    if (!m) return data.dateOfBirth;
    return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
  })();

  const subject = `[WBF] New player registration · ${data.familyName} ${data.givenName} · ${refId}`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0a0a0a;max-width:600px;margin:0 auto;padding:24px;">
      <div style="border-bottom:1px solid #e7e5e4;padding-bottom:16px;margin-bottom:24px;">
        <div style="font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:.08em;font-weight:600;">WBF · EBL Player Registration</div>
        <h1 style="font-size:22px;margin:6px 0 0;font-weight:700;color:#14532d;">New player registration</h1>
      </div>

      <p style="font-size:15px;line-height:1.55;color:#3f3f46;margin:0 0 20px;">
        A new player has submitted their registration to the WBF / EBL shared database. Please review the submission below.
      </p>

      <table cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">
        ${[
          ['Reference', refId],
          ['Family name', esc(data.familyName)],
          ['Given name', esc(data.givenName)],
          ['Gender', data.gender === 'Male' ? '♂️ Male' : '♀️ Female'],
          ['Date of birth', dobDisplay],
          ['Country of birth', esc(data.countryBirth)],
          ['Country of residence', esc(data.countryResidence)],
          ['E-mail', `<a href="mailto:${esc(data.email)}" style="color:#166534;">${esc(data.email)}</a>`],
          ['Phone', esc(data.phone)],
          ['National affiliation code', esc(data.affiliationCode)],
          data.chineseName ? ['Chinese name', esc(data.chineseName)] : null,
        ].filter(Boolean).map(([k, v]) => `
          <tr>
            <td style="padding:8px 12px 8px 0;color:#71717a;font-weight:500;width:38%;vertical-align:top;border-bottom:1px solid #f5f5f4;">${k}</td>
            <td style="padding:8px 0;color:#0a0a0a;vertical-align:top;border-bottom:1px solid #f5f5f4;">${v}</td>
          </tr>
        `).join('')}
      </table>

      <div style="margin-bottom:24px;">
        <div style="font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:10px;">Photograph</div>
        <a href="${esc(data.photoUrl)}" style="display:inline-block;text-decoration:none;">
          <img src="${esc(data.photoUrl)}" alt="Player photo" style="width:200px;height:auto;border:1px solid #e7e5e4;border-radius:8px;display:block;">
        </a>
        <div style="margin-top:8px;font-size:12px;">
          <a href="${esc(data.photoUrl)}" style="color:#166534;">Open full size</a>
        </div>
      </div>

      <div style="background:#f0fdf4;border:1px solid #d1fae5;border-radius:8px;padding:14px 16px;margin-bottom:20px;">
        <p style="margin:0;font-size:13px;color:#14532d;line-height:1.55;">
          ✓ The player has accepted the data-processing authorisation required by the WBF / EBL Privacy Policies.
        </p>
      </div>

      <p style="font-size:12px;color:#a1a1aa;margin:24px 0 0;line-height:1.5;">
        This message was sent automatically by the WBF · EBL player registration form. Reference ${refId}.
      </p>
    </div>
  `.trim();

  const text = [
    'New WBF / EBL player registration',
    '',
    `Reference: ${refId}`,
    `Family name: ${data.familyName}`,
    `Given name: ${data.givenName}`,
    `Gender: ${data.gender}`,
    `Date of birth: ${dobDisplay}`,
    `Country of birth: ${data.countryBirth}`,
    `Country of residence: ${data.countryResidence}`,
    `E-mail: ${data.email}`,
    `Phone: ${data.phone}`,
    `National affiliation code: ${data.affiliationCode}`,
    data.chineseName ? `Chinese name: ${data.chineseName}` : null,
    `Photograph: ${data.photoUrl}`,
    '',
    'The player has accepted the data-processing authorisation.',
  ].filter(Boolean).join('\n');

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from, to, subject, html, text,
      reply_to: data.email,
    }),
  });

  if (!r.ok){
    const body = await r.text().catch(()=>'');
    throw new Error(`Resend HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  console.log('[email] notification sent to', to.join(', '));
}
