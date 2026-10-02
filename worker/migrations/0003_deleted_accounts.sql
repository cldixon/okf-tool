-- Deleted accounts (v2 spec: Accounts and sign-in, A2): a hash of the email and when, for abuse
-- handling. Nothing else of the account is kept.
CREATE TABLE deleted_accounts (
  email_hash TEXT NOT NULL,
  deleted    TEXT NOT NULL
);
CREATE INDEX deleted_accounts_email ON deleted_accounts (email_hash);
