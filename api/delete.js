import { del } from '@vercel/blob';
import postgres from 'postgres';

export const maxDuration = 30;

const sql = postgres(process.env.POSTGRES_URL, { ssl: 'require' });

export default async function handler(req, res){
  if (req.method !== 'POST' && req.method !== 'DELETE'){
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const password = req.headers['x-admin-password'] || '';
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD){
    return res.status(401).json({ error: 'Unauthorized' });
  }

  /* Robust body parsing — Vercel's runtime may or may not auto-parse JSON */
  let body = {};
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)){
    body = req.body;
  } else if (typeof req.body === 'string'){
    try { body = JSON.parse(req.body); } catch { body = {}; }
  } else {
    /* Read raw stream */
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length > 0){
        const raw = Buffer.concat(chunks).toString('utf8');
        body = JSON.parse(raw);
      }
    } catch (e){
      console.error('[delete] body parse failed:', e?.message);
      return res.status(400).json({ error: 'Invalid request body.' });
    }
  }

  console.log('[delete] received body:', body);

  const ids = Array.isArray(body.ids)
    ? body.ids.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0)
    : [];

  if (ids.length === 0){
    return res.status(400).json({ error: 'No valid IDs provided.' });
  }
  if (ids.length > 200){
    return res.status(400).json({ error: 'Too many IDs (max 200 per call).' });
  }

  try {
    /* Delete from DB and get photo URLs of deleted rows */
    const deleted = await sql`
      DELETE FROM registrations
      WHERE id = ANY(${ids}::int[])
      RETURNING id, photo_url
    `;
    console.log('[delete] removed', deleted.length, 'rows from DB');

    /* Best-effort cleanup of photo files from Vercel Blob — never fail because of this */
    const photoUrls = deleted.map(r => r.photo_url).filter(u => u && /^https?:\/\//.test(u));
    if (photoUrls.length > 0){
      try {
        await del(photoUrls);
        console.log('[delete] removed', photoUrls.length, 'blob files');
      } catch (blobErr) {
        console.warn('[delete] blob cleanup failed (rows still removed from DB):', blobErr?.message || blobErr);
      }
    }

    return res.status(200).json({ deleted: deleted.length });

  } catch (err){
    console.error('[delete] error:', err);
    return res.status(500).json({ error: `Server error: ${err?.message || 'unknown'}` });
  }
}
