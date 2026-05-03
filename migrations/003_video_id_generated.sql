-- LangChain PGVectorStore only populates id/embedding/content/metadata, so
-- the original NOT NULL video_id column always violated the constraint.
-- Derive it from metadata->>'videoId' as a stored generated column instead.
-- DROP COLUMN cascades the FK constraint and the single-column index.

ALTER TABLE transcript_chunks DROP COLUMN video_id;

ALTER TABLE transcript_chunks
  ADD COLUMN video_id TEXT
  GENERATED ALWAYS AS (metadata->>'videoId') STORED
  NOT NULL
  REFERENCES videos(video_id) ON DELETE CASCADE;

CREATE INDEX transcript_chunks_video_id_idx
  ON transcript_chunks (video_id);
