import { put } from '@vercel/blob';
import postgres from 'postgres';

/* Vercel auto-injects POSTGRES_URL when you add a Postgres integration
   (Neon, Supabase, etc. from the Vercel Marketplace). */
const sql = postgres(process.env.POSTGRES_URL, { ssl: 'require' });

const LATIN_RE = /^[A-Za-z\s'\-\.]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d][\d\s().\-]{5,}$/;
const ALLOWED_GENDERS = ['Female','Male'];
const ALLOWED_MIME    = ['image/jpeg','image/png','image/webp'];
const MAX_BYTES       = 4 * 1024 * 1024;

function jsonRes(status, body){
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type':'application/json' }
  });
}

export default async function handler(request){
  if (request.method !== 'POST') return jsonRes(405, { error: 'Method not allowed.' });

  try {
    const formData = await request.formData();
    const get = k => String(formData.get(k) ?? '').trim();

    const familyName       = get('familyName');
    const givenName        = get('givenName');
    const gender           = get('gender');
    const countryBirth     = get('countryBirth');
    const countryResidence = get('countryResidence');
    const dateOfBirth      = get('dateOfBirth');
    const email            = get('email');
    const phone            = get('phone');
    const affiliationCode  = get('affiliationCode');
    const chineseName      = get('chineseName');
    const photo            = formData.get('photo');

    /* ---- server-side validation ---- */
    if (!familyName || !givenName || !gender || !countryBirth || !countryResidence
        || !dateOfBirth || !email || !phone || !affiliationCode){
      return jsonRes(400, { error: 'Please complete all required fields.' });
    }
    if (!LATIN_RE.test(familyName) || !LATIN_RE.test(givenName)){
      return jsonRes(400, { error: 'Name fields must contain Latin letters only (no accents).' });
    }
    if (!ALLOWED_GENDERS.includes(gender)){
      return jsonRes(400, { error: 'Invalid gender value.' });
    }
    if (!EMAIL_RE.test(email))  return jsonRes(400, { error: 'Invalid e-mail address.' });
    if (!PHONE_RE.test(phone))  return jsonRes(400, { error: 'Invalid phone number.' });
    if (isNaN(Date.parse(dateOfBirth))) return jsonRes(400, { error: 'Invalid date of birth.' });

    if (!photo || typeof photo === 'string' || !photo.size){
      return jsonRes(400, { error: 'A profile photograph is required.' });
    }
    if (!ALLOWED_MIME.includes(photo.type)){
      return jsonRes(400, { error: 'Photograph must be JPG, PNG or WEBP.' });
    }
    if (photo.size > MAX_BYTES){
      return jsonRes(413, { error: 'Photograph too large (max 4 MB).' });
    }

    /* ---- upload photo to Vercel Blob ---- */
    const sanitize = s => s.replace(/[^A-Za-z0-9]/g, '_');
    const ext      = (photo.name?.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
    const filename = `${sanitize(familyName)}_${sanitize(givenName)}_${Date.now()}.${ext}`;

    const blob = await put(`photos/${filename}`, photo, {
      access: 'public',
      contentType: photo.type,
      addRandomSuffix: false,
    });

    /* ---- insert row in Postgres ---- */
    const rows = await sql`
      INSERT INTO registrations
        (family_name, given_name, gender, country_birth, country_residence,
         date_of_birth, email, phone, affiliation_code, photo_url, chinese_name)
      VALUES
        (${familyName}, ${givenName}, ${gender}, ${countryBirth}, ${countryResidence},
         ${dateOfBirth}, ${email}, ${phone}, ${affiliationCode}, ${blob.url}, ${chineseName || null})
      RETURNING id
    `;

    return jsonRes(200, { success: true, id: rows[0].id });

  } catch (err){
    console.error('register error:', err);
    return jsonRes(500, { error: 'Server error. Please try again later.' });
  }
}
