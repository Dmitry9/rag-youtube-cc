# 04 — pgvector Setup

Schema, indexes, and the operational details for using Postgres as the vector
store.

## Why pgvector and not a dedicated vector DB

We're at ~500 chunks today and ~50,000 even at 100× scale. At that size:

- One database (Postgres) instead of two (Postgres + Pinecone) means
  transactional ingestion, no sync logic, and SQL joins between vectors and
  app tables.
- `WHERE courseId = ?` combined with vector search in one query — impossible
  if vectors live in a separate service.
- Backups, replication, access control, migrations: things we already have.
- Cheap. Tens of dollars/month at this size; free on Supabase/Neon free tiers.

Trade-off: dedicated vector DBs (Pinecone, Qdrant, Weaviate, Milvus) scale
more gracefully past ~10M vectors with heavy QPS. We'll cross that bridge if
we ever reach it.

## Install the extension

Once per database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Managed Postgres (Supabase, Neon, RDS, Cloud SQL) ships pgvector — usually a
checkbox or a single SQL command.

Local dev with Docker:

```bash
docker run -d --name pg \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

## Schema

Own your schema. Don't let LangChain's `PGVectorStore.initialize` create
tables for you in production — you want explicit migrations and the freedom
to add app columns and foreign keys.

```sql
-- migrations/001_init.sql

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
```

Two non-obvious rules:

1. **`VECTOR(1536)` must match your embedding model's output dim.** Mismatch
   fails at insert, not at schema creation. Pin the model name in code.
2. **The index `vector_cosine_ops` ↔ the `<=>` operator at query time must
   match.** If you index with `vector_l2_ops` and query with `<=>`, the index
   is unused and you do a full scan.

## Indexes — HNSW vs IVFFlat

Choose one:

**HNSW** (recommended)
- Better recall/latency. Higher memory, slower to build.
- Good defaults: `m = 16`, `ef_construction = 64`.
- Tune at query time: `SET hnsw.ef_search = 40;` — higher = better recall,
  more latency.

**IVFFlat**
- Faster build, lower memory, slightly worse recall.
- Defaults: `lists ≈ rows/1000` for small tables, `sqrt(rows)` for larger.
- Tune: `SET ivfflat.probes = 10;` — higher = better recall, more latency.

Use HNSW unless you have a specific reason. The build cost difference doesn't
matter at 500 chunks (or 500k).

## Ingest with LangChain

Wraps the schema with a clean adapter:

```ts
// src/ingest/store.ts
import { OpenAIEmbeddings } from "@langchain/openai";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { Document } from "langchain/document";

export const embeddings = new OpenAIEmbeddings({ model: "text-embedding-3-small" });

export async function getStore() {
  return PGVectorStore.initialize(embeddings, {
    postgresConnectionOptions: { connectionString: process.env.DATABASE_URL! },
    tableName: "transcript_chunks",
    columns: {
      idColumnName: "id",
      vectorColumnName: "embedding",
      contentColumnName: "content",
      metadataColumnName: "metadata",
    },
    distanceStrategy: "cosine",
  });
}
```

```ts
// src/ingest/ingestVideo.ts
import { Document } from "langchain/document";
import { getStore } from "./store.js";
import { chunkTranscript } from "./chunkTranscript.js";

export async function ingestVideo(transcript) {
  const store = await getStore();
  const chunks = chunkTranscript(transcript, { chunkTokens: 400, overlapTokens: 60 });

  const docs = chunks.map((c, i) => new Document({
    pageContent: c.pageContent,
    metadata: { ...c.metadata, chunkIndex: i },
  }));
  const ids = chunks.map((_, i) => `${transcript.videoId}::${i}`);

  // Re-ingest safety: wipe old chunks for this video first.
  // Better: wrap both in a transaction with a raw client.
  await store.delete({ filter: { videoId: transcript.videoId } });
  await store.addDocuments(docs, { ids });
}
```

## Query

LangChain wrapper for the common case:

```ts
const hits = await store.similaritySearch(
  "how do I update state in react?",
  20,                                     // over-retrieve for the reranker
  { courseId: "course-101" }              // → WHERE metadata @> '{"courseId":"course-101"}'
);
```

The raw SQL it generates is essentially:

```sql
SELECT id, content, metadata,
       1 - (embedding <=> $1) AS similarity
FROM transcript_chunks
WHERE metadata @> $2::jsonb
ORDER BY embedding <=> $1
LIMIT $3;
```

## Drop to raw SQL when you need to

Hybrid search (vector + BM25), custom scoring, or joining to app tables:

```ts
// src/retrieve/hybridSearch.ts
import pg from "pg";
import { embeddings } from "../ingest/store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function hybridSearch(query: string, courseId: string, k = 20) {
  const queryVec = await embeddings.embedQuery(query);

  const { rows } = await pool.query(
    `
    SELECT c.id, c.content, c.metadata, v.title,
           1 - (c.embedding <=> $1::vector) AS vec_score,
           ts_rank_cd(to_tsvector('english', c.content),
                      plainto_tsquery('english', $2)) AS bm25_score
    FROM transcript_chunks c
    JOIN videos v ON v.video_id = c.video_id
    WHERE v.course_id = $3
    ORDER BY (0.6 * (1 - (c.embedding <=> $1::vector))
           +  0.4 * ts_rank_cd(to_tsvector('english', c.content),
                               plainto_tsquery('english', $2))) DESC
    LIMIT $4;
    `,
    [`[${queryVec.join(",")}]`, query, courseId, k]
  );
  return rows;
}
```

Vector search + full-text + a metadata join, one round-trip. Exactly the thing
you can't do when vectors live in a separate service.

## Operational gotchas

- **Build the HNSW index after a bulk load**, not before. Building incrementally
  on every insert is much slower than one big build at the end. For our small
  corpus this doesn't matter; for million-row loads it really does.
- **Use a connection pool.** `pgbouncer` or your framework's pool. Don't open
  a fresh connection per request.
- **Dimension mismatches fail at insert.** First insert after a model change
  surfaces the bug. Pin the model name and dimension together.
- **Back up like any other table.** `pg_dump` works; vectors are just rows.
- **At query time, set HNSW search parameter per session if needed**:
  `SET LOCAL hnsw.ef_search = 60;` for higher recall on demanding queries.

## Two conceptual things to remember

**Reranking does not write to Postgres.** Query-time operations (similarity
search, rerank) read embeddings and metadata. Nothing is mutated. The only
write path is ingestion. See `05-retrieval-and-rerank.md`.

**Embeddings are a one-way transform.** You can't reconstruct text from a
vector. Always store the original `content` alongside the `embedding` —
that's what gets sent to the LLM at generation time.
