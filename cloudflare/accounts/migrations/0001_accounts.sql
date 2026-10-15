CREATE TABLE oauth_flows (state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, client_challenge TEXT NOT NULL, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX oauth_flows_expiry ON oauth_flows(expires_at);
CREATE TABLE login_tickets (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT NOT NULL, challenge TEXT NOT NULL, origin TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX login_tickets_expiry ON login_tickets(expires_at);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT NOT NULL, expires_at INTEGER NOT NULL, access_json TEXT, checked_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE layouts (user_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,id));
CREATE INDEX layouts_owner_updated ON layouts(user_id,updated_at);
