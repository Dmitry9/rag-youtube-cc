# Indexes — pgvector + Postgres

## IVFFlat vs HNSW

Both are **approximate nearest neighbor** (ANN) indexes — exact search over millions of vectors is too slow, so we accept "very close to top-k" instead of "exact top-k." They differ in *how* they approximate.

### IVFFlat — Inverted File with Flat compression
- **Build:** k-means clusters the vectors into `lists` partitions. Each vector knows its cluster.
- **Query:** find the `probes` nearest cluster centroids, then exhaustively compare against vectors in those clusters only. Skip everything else.
- Cheap to build, cheap on memory. Recall depends on `lists` (build) and `probes` (query) — too few probes and you miss; too many and you've defeated the purpose.

### HNSW — Hierarchical Navigable Small World
- **Build:** builds a multi-layer graph. Top layer is sparse with long-range links; bottom layer is dense with local links. Each vector is a node.
- **Query:** start at top layer's entry point, greedily walk toward your query vector, descend a layer, repeat. Like zooming in on a map.
- Slower build, more memory, but **better recall at lower latency** in practice.

### Why HNSW for us
[doc 04 lines 108–109](../docs/04-pgvector-setup.md#L108-L109): "Use HNSW unless you have a specific reason. The build cost difference doesn't matter at 500 chunks (or 500k)." We're never going to be in a regime where IVFFlat's faster build matters; we just want better retrieval quality and lower query latency.

### Tunable knobs (don't tune yet)
- **Build:** `m` (graph connectivity), `ef_construction` (build-time search width)
- **Query:** `hnsw.ef_search` (query-time search width — higher = better recall, slower). Set per session: `SET LOCAL hnsw.ef_search = 60;`

---

## Two different questions

| Question                                   | How to answer                                     |
|--------------------------------------------|---------------------------------------------------|
| What indexes **exist**?                    | Catalog queries (`\di`, `\d table`, `pg_indexes`) |
| Is an index actually **used** by my query? | `EXPLAIN ANALYZE`                                 |
| Has it **ever** been used?                 | `pg_stat_user_indexes`                            |

The planner *chooses* whether to use an index. An index can exist and still be skipped — sequential scan is faster on tiny tables. Existence ≠ usage.

---

## Inspect — what exists?

```bash
# All tables
docker exec pg psql -U rag -d rag -c "\dt"

# All indexes
docker exec pg psql -U rag -d rag -c "\di"

# One table — columns + indexes + constraints in one view
docker exec pg psql -U rag -d rag -c "\d transcript_chunks"

# Full CREATE INDEX DDL for every index
docker exec pg psql -U rag -d rag -c "
  SELECT tablename, indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public';"
```

`\d table_name` is the most useful — shows table definition and every index on it (btree / hnsw / gin / etc.) in one view.

---

## Inspect — is it used?

```sql
EXPLAIN ANALYZE
SELECT * FROM transcript_chunks
ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 5;
```

Look for in the output:
- `Index Scan using transcript_chunks_embedding_idx` ✓ — using HNSW
- `Seq Scan on transcript_chunks` ✗ — full table scan, index ignored

### Common reasons an index is skipped
- **Operator mismatch.** Indexed with `vector_cosine_ops` but queried with `<->` (L2 distance, not cosine). [doc 04 lines 89–92](../docs/04-pgvector-setup.md#L89-L92).
- **Too few rows.** Postgres correctly decides seq scan beats the index. Not a bug.
- **Stale stats.** `ANALYZE transcript_chunks;` refreshes planner statistics.

---

## Inspect — cumulative usage

After running the eval harness for a while, check whether each index earned its keep:

```sql
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public';
```

`idx_scan = 0` after real workload → dead index, drop or fix the query.

---

## What Step 3 will create

From [docs/04-pgvector-setup.md](../docs/04-pgvector-setup.md) lines 71–83:

| Index                             | Type              | Purpose                             |
|-----------------------------------|-------------------|-------------------------------------|
| `transcript_chunks_pkey`          | btree             | implicit, on `id` PK                |
| `transcript_chunks_embedding_idx` | **hnsw** (cosine) | vector similarity search            |
| `transcript_chunks_video_id_idx`  | btree             | `WHERE videoId = ?` filters         |
| `transcript_chunks_metadata_idx`  | **gin**           | `WHERE metadata @> '{...}'` filters |

Three different index types for three different access patterns. After Step 3, run `\d transcript_chunks` and the output should make sense without help.

---

## Operator ↔ index op-class cheat sheet

The index op-class and the query operator must match, or the index is unused:

| Distance       | Operator | Index op-class      |
|----------------|----------|---------------------|
| Cosine         | `<=>`    | `vector_cosine_ops` |
| L2 (Euclidean) | `<->`    | `vector_l2_ops`     |
| Inner product  | `<#>`    | `vector_ip_ops`     |

We use cosine throughout because OpenAI embeddings are L2-normalized — cosine and dot-product give identical rankings, and cosine is the convention.
