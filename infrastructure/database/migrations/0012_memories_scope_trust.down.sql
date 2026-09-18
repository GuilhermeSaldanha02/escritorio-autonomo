CREATE INDEX memories_embedding_idx ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
DROP INDEX memories_dedup_idx;
DROP INDEX memories_scope_task_idx;
ALTER TABLE memories
  DROP COLUMN scope_task_id,
  DROP COLUMN trust_level;
