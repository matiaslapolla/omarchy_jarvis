CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  content text NOT NULL,
  importance float NOT NULL,
  confidence float NOT NULL,
  embedding vector(384),
  entities text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY,
  name text UNIQUE NOT NULL,
  kind text NOT NULL
);
CREATE TABLE IF NOT EXISTS relationships (
  id uuid PRIMARY KEY,
  from_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation text NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_type_idx ON memories(type);
CREATE INDEX IF NOT EXISTS memories_last_accessed_idx ON memories(last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
