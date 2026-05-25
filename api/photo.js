import { head } from '@vercel/blob';

export const maxDuration = 30;

/* Proxies a photo from the private Vercel Blob store to the admin's browser.
   Requires the admin password as a query parameter (because <img> tags can't
   send custom headers). No URL expiry — works forever. */

export default async function handler(req, res){
  if (req.method !== 'GET'){
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  /* Auth via query string */
  const password = req.query.pwd || '';
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD){
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const pathname = String(req.query.p || '').trim();
  if (!pathname || pathname.startsWith('/') || pathname.includes('..')){
    return res.status(400).json({ error: 'Invalid pathname.' });
  }

  try {
    /* head() resolves the blob to a downloadable URL (works for private stores) */
    const meta = await head(pathname);
    if (!meta || !meta.url){
      return res.status(404).json({ error: 'Photo not found.' });
    }

    /* Fetch the bytes server-side and stream them back */
    const blobRes = await fetch(meta.url);
    if (!blobRes.ok){
      console.error('[photo] blob fetch failed:', blobRes.status);
      return res.status(502).json({ error: 'Photo fetch failed.' });
    }

    const contentType = meta.contentType || blobRes.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await blobRes.arrayBuffer());

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=60');

    if (req.query.download){
      const safeName = String(req.query.download).replace(/[^\w.\-]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    }

    return res.status(200).send(buffer);

  } catch (err){
    console.error('[photo] error:', err);
    return res.status(500).json({ error: `Server error: ${err?.message || 'unknown'}` });
  }
}
