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

    return res.status(200).json({ success: true, id: rows[0].id });

  } catch (err) {
    console.error('[register] error after', Date.now() - t0, 'ms:', err);
    if (err && err.message === 'PHOTO_TOO_LARGE'){
      return res.status(413).json({ error: 'Photograph too large (max 4 MB).' });
    }
    return res.status(500).json({ error: `Server error: ${err?.message || 'unknown'}` });
  }
}
