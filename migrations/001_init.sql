
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE videos (
  video_id    TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  duration_s  NUMERIC,
  source_url  TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE transcript_chunks (
  id          TEXT PRIMARY KEY,                 -- "videoId::chunkIndex"
  video_id    TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  embedding   VECTOR(1536) NOT NULL,            -- match your embedding model dim
  metadata    JSONB NOT NULL,                   -- courseId, startTime, endTime, chunkIndex, ...
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Vector index (HNSW: better recall/latency tradeoff than IVFFlat)
CREATE INDEX transcript_chunks_embedding_idx
  ON transcript_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Filter indexes for the metadata fields we'll WHERE on
CREATE INDEX transcript_chunks_video_id_idx
  ON transcript_chunks (video_id);

CREATE INDEX transcript_chunks_metadata_gin
  ON transcript_chunks USING GIN (metadata);