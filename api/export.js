import postgres from 'postgres';

export const maxDuration = 30;

const sql = postgres(process.env.POSTGRES_URL, { ssl: 'require' });

export default async function handler(req, res){
  const password = req.headers['x-admin-password'] || '';
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD){
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const rows = await sql`
      SELECT
        id,
        TO_CHAR(submitted_at AT TIME ZONE 'UTC','FMMM/FMDD/YYYY FMHH24:MI:SS') AS "Timestamp",
        email                                  AS "Email Address",
        family_name                            AS "Family name",
        given_name                             AS "Given name",
        gender                                 AS "Gender",
        country_birth                          AS "Country of Birth",
        country_residence                      AS "Country of Residence",
        TO_CHAR(date_of_birth,'FMMM/FMDD/YYYY') AS "Date of Birth",
        email                                  AS "E-mail",
        phone                                  AS "Phone",
        photo_url                              AS "Photo",
        affiliation_code                       AS "National affiliation code",
        chinese_name                           AS "Chinese name",
        TO_CHAR(submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI') AS submitted_at
      FROM registrations
      ORDER BY submitted_at DESC
    `;
    return res.status(200).json({ rows });
  } catch (err){
    console.error('[export] error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
}
