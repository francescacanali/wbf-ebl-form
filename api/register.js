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
    if (isNaN(Date.parse(dateOfBirth))){
      return res.status(400).json({ error: 'Invalid date of birth.' });
    }
    if (!photo || !photo.buffer || photo.buffer.length === 0){
      return res.status(400).json({ error: 'A profile photograph is required.' });
    }
    if (!ALLOWED_MIME.includes(photo.mimeType)){
      return res.status(400).json({ error: 'Photograph must be JPG, PNG or WEBP.' });
    }

    console.log('[register] validation OK');

    /* Upload photo to private Vercel Blob */
    const sanitize = s => s.replace(/[^A-Za-z0-9]/g, '_');
    const ext      = (photo.filename.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
    const pathname = `photos/${sanitize(familyName)}_${sanitize(givenName)}_${Date.now()}.${ext}`;

    console.log('[register] uploading blob:', pathname);
    /* For private stores in @vercel/blob v1.x, no `access` parameter is required;
       the SDK detects the store type automatically via the token. */
    const blob = await put(pathname, photo.buffer, {
      contentType: photo.mimeType,
      addRandomSuffix: false,
    });
    console.log('[register] blob uploaded', { elapsedMs: Date.now() - t0, returnedUrl: blob.url });

    /* Store BOTH the pathname (for proxy access) and the URL (returned by SDK).
       The proxy endpoint will use the pathname; the URL is kept as backup. */
    console.log('[register] inserting row...');
    const rows = await sql`
      INSERT INTO registrations
        (family_name, given_name, gender, country_birth, country_residence,
         date_of_birth, email, phone, affiliation_code, photo_url, chinese_name)
      VALUES
        (${familyName}, ${givenName}, ${gender}, ${countryBirth}, ${countryResidence},
         ${dateOfBirth}, ${email}, ${phone}, ${affiliationCode}, ${pathname}, ${chineseName || null})
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
