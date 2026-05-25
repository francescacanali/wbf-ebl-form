-- Run this ONCE in your Postgres database (Vercel dashboard → Storage → your DB → Query)

CREATE TABLE IF NOT EXISTS registrations (
  id                 SERIAL       PRIMARY KEY,
  family_name        TEXT         NOT NULL,
  given_name         TEXT         NOT NULL,
  gender             TEXT         NOT NULL,
  country_birth      TEXT         NOT NULL,
  country_residence  TEXT         NOT NULL,
  date_of_birth      DATE         NOT NULL,
  email              TEXT         NOT NULL,
  phone              TEXT         NOT NULL,
  affiliation_code   TEXT         NOT NULL,
  photo_url          TEXT         NOT NULL,
  chinese_name       TEXT,
  submitted_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_registrations_email     ON registrations(email);
CREATE INDEX IF NOT EXISTS idx_registrations_submitted ON registrations(submitted_at DESC);
