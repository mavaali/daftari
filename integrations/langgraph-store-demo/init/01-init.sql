-- Runs once at first `docker compose up` (docker-entrypoint-initdb.d), against
-- the `memories` database as the postgres superuser.
--
-- Two jobs:
--   1. Enable pgvector so LangMem's semantic memories (embeddings) land in
--      store_vectors. langgraph PostgresStore.setup() also creates the extension
--      when it has permission, but doing it here means the read-only role never
--      needs CREATE EXTENSION.
--   2. Create the read-only role the Daftari adapter connects as. This is the
--      Phase 2 boundary posture: read-only is enforced by the grant, not by
--      config or convention. The adapter has no write path because the role has
--      no write grants.

CREATE EXTENSION IF NOT EXISTS vector;

-- Read-only role for `daftari import langgraph-store --dsn ...`.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'daftari_ro') THEN
        CREATE ROLE daftari_ro LOGIN PASSWORD 'daftari_ro';
    END IF;
END $$;

GRANT CONNECT ON DATABASE memories TO daftari_ro;
GRANT USAGE ON SCHEMA public TO daftari_ro;

-- Cover tables that already exist (none yet at init time) and, via default
-- privileges, the store/store_vectors tables PostgresStore.setup() creates
-- later as the postgres role.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO daftari_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO daftari_ro;
