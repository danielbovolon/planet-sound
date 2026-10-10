-- Sign-in with email + password (no email is sent). Replaces the sign-in link from 0002.
ALTER TABLE users ADD COLUMN password_hash TEXT;
DROP TABLE IF EXISTS login_tokens;
