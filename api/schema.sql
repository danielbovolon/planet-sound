-- Planet Sound — D1 schema. Safe to run more than once.
-- Apply with:  npx wrangler d1 execute planet-sound --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  key_hash    TEXT UNIQUE,               -- SHA-256 of the listener key (legacy; see device_keys)
  email       TEXT,                      -- sign-in address; one account per person
  password_hash TEXT,                    -- pbkdf2 of the account password
  name        TEXT,                      -- how contributions are credited
  collections TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  ip_hash     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email);

-- Several devices (listener keys) can belong to one account.
CREATE TABLE IF NOT EXISTS device_keys (
  key_hash   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sounds (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,   -- accession number, PS-0001…
  id              TEXT NOT NULL UNIQUE,
  owner_id        TEXT REFERENCES users(id),
  visibility      TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  title           TEXT NOT NULL,
  notes           TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  lat             REAL NOT NULL,
  lng             REAL NOT NULL,
  place           TEXT,
  recorded_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  credit          TEXT,
  equipment       TEXT,
  duration        REAL,
  codec           TEXT,
  lossless        INTEGER,
  sample_rate     INTEGER,
  bit_depth       INTEGER,
  channels        INTEGER,
  lufs            REAL,
  peak_db         REAL,
  background_lufs REAL,
  clipped         INTEGER,
  audio_key       TEXT,
  audio_type      TEXT,
  audio_bytes     INTEGER,
  spec_key        TEXT,
  photo_key       TEXT,
  peaks           TEXT,
  allow_download  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sounds_owner  ON sounds(owner_id);
CREATE INDEX IF NOT EXISTS sounds_public ON sounds(visibility);

CREATE TABLE IF NOT EXISTS uploads (
  key        TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  attached   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ip_log (
  ip_hash TEXT NOT NULL,
  day     TEXT NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);
