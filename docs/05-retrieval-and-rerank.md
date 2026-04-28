# 05 — Retrieval and Rerank

How a question becomes a list of relevant chunks. Two stages: vector search
(broad and fast) followed by reranking (narrow and accurate).

## The pattern: over-retrieve then rerank

```
query → embed → pgvector top-20 → Cohere Rerank → top-5 → LLM
```

Why two stages:
- **Embeddings are fast but imprecise.** Query and chunk are embedded
  independently, then compared. Misses subtle relevance.
- **Cross-encoder rerankers are slower but accurate.** They look at query and
  chunk *together*, scoring them as a pair.
- Combining them: embeddings find the candidate pool cheaply; reranker picks
  the real top 5.

Adding a reranker typically bumps recall@5 by 10–15 points. It's the single
biggest cheap win after good chunking.

## Why ~20 candidates, not 5

If you only retrieve 5 from pgvector and then rerank, the reranker can't
improve anything — it's just reordering what you already had. Pull 20–30 so
the reranker has room to find chunks the embeddings ranked too low.

Past ~50, marginal quality flattens and reranker latency climbs. **20–30 is
the sweet spot.**

## The reranking call is read-only

Important mental model: `cohere.rerank()` is a pure function on an in-memory
JS array. It does not touch Postgres. The flow:

```ts
// 1. READ from Postgres — 20 rows pulled into JS objects.
const candidates = await store.similaritySearch(query, 20, filter);

// 2. Cohere receives query + 20 strings. Returns reordered indexes + scores.
//    Cohere has no knowledge of, and no access to, your database.
const rerank = await cohere.rerank({ ... });

// 3. Reorder the in-memory JS array. Pure data manipulation.
const final = rerank.results.map(r => candidates[r.index]);
```

What changes: the order of an array in memory, for this request.
What doesn't change: anything in Postgres, ever.

This is by design — reranking is query-dependent (different questions need
different orderings of the same chunks), so storing reranked order in the DB
would be wrong.

## Code

```ts
// src/retrieve/retrieveWithRerank.ts
import { CohereClientV2 } from "cohere-ai";
import { getStore } from "../ingest/store.js";

const cohere = new CohereClientV2({ token: process.env.COHERE_API_KEY! });

export interface RetrieveOptions {
  courseId?: string;
  initialK?: number;   // candidates pulled from pgvector
  finalK?: number;     // chunks returned to caller
  minScore?: number;   // drop reranked candidates below this
}

export async function retrieveWithRerank(
  query: string,
  {
    courseId,
    initialK = 20,
    finalK = 5,
    minScore = 0.2,
  }: RetrieveOptions = {}
) {
  const store = await getStore();

  // Stage 1: vector search
  const candidates = await store.similaritySearch(
    query,
    initialK,
    courseId ? { courseId } : undefined
  );
  if (candidates.length === 0) return [];

  // Stage 2: rerank
  const rerank = await cohere.rerank({
    model: "rerank-v3.5",
    query,
    documents: candidates.map(c => c.pageContent),
    topN: finalK,
  });

  // Stage 3: map indexes back to documents (with metadata intact)
  return rerank.results
    .filter(r => r.relevanceScore >= minScore)
    .map(r => ({
      ...candidates[r.index],
      relevanceScore: r.relevanceScore,
    }));
}
```

Usage:

```ts
const chunks = await retrieveWithRerank("how do I update state in react?", {
  courseId: "course-101",
  initialK: 20,
  finalK: 5,
});

// chunks[0] = {
//   pageContent: "The setter from useState triggers a re-render...",
//   metadata: { videoId: "...", startTime: 47.3, endTime: 62.1, ... },
//   relevanceScore: 0.94
// }
```

## Cohere Rerank — what to know

- Model name: **`rerank-v3.5`** (multilingual; English-only and v3.0 also
  available).
- **Returns indexes back into your input array**, not the documents themselves.
  You do the lookup.
- **`relevanceScore` is calibrated 0–1.** Unlike cosine similarity, you can
  use thresholds across queries. ~0.2–0.3 is a sensible "abstain" threshold.
- **Billing is per search**, not per document. ~$2 per 1k searches at the
  time of writing. Whether you rerank 10 or 50 candidates is the same price.
- **Latency:** ~200–500ms typical. Worth it almost always.
- **Document length cap:** ~4096 tokens per document. Our chunks are 400.
  Truncate if you ever go larger.

## LangChain wrapper, if you prefer that style

```ts
import { CohereRerank } from "@langchain/cohere";
import { ContextualCompressionRetriever } from "langchain/retrievers/contextual_compression";

const compressor = new CohereRerank({
  apiKey: process.env.COHERE_API_KEY!,
  model: "rerank-v3.5",
  topN: 5,
});

const retriever = new ContextualCompressionRetriever({
  baseCompressor: compressor,
  baseRetriever: store.asRetriever({
    k: 20,
    filter: { courseId: "course-101" },
  }),
});

const chunks = await retriever.invoke("how do I update state in react?");
```

Same behavior. The raw version (above) is clearer when debugging or when you
want to do anything custom (hybrid search, multi-query, custom thresholds).

## Abstention — when nothing is good enough

If after reranking, the top score is below threshold, return no chunks rather
than feeding garbage to the LLM:

```ts
const chunks = await retrieveWithRerank(query, { courseId, minScore: 0.25 });
if (chunks.length === 0) {
  return "I don't have information on that in the course content.";
}
```

This is the cheap version of "I don't know." Cheaper than letting the LLM
hallucinate from low-relevance chunks and then catching it downstream.

## Other improvements, in priority order

If reranker + good chunking still underperforms on eval:

1. **Hybrid search** — combine vector and BM25 with reciprocal rank fusion.
   Helps queries with exact terms ("useState", error codes, names).
2. **Query rewriting** — small LLM resolves "what about the second one?"
   against chat history before embedding.
3. **Multi-query expansion** — LLM generates 3 variations of the query;
   retrieve for each; merge top-k. Good for vague queries.
4. **Parent-child retrieval** — embed small chunks (precise), return parent
   chunk (more context to LLM). LangChain `ParentDocumentRetriever`.
5. **Larger embedding model** — `text-embedding-3-large` for harder content.
6. **Embedding fine-tuning** — last resort. Requires labeled
   query→chunk pairs.

Don't add these blindly. Each one has cost and complexity. Add only what your
eval set says is worth it.

## What an interviewer should hear

> Retrieval over-fetches with embeddings (top-20 from pgvector) and then
> reranks with a cross-encoder (Cohere Rerank 3.5) to top-5. Embeddings are
> cheap and broad; rerankers are accurate but slower, so we use them on a
> small candidate pool. The reranker is read-only — it reorders an in-memory
> array, never touches the database. We use a calibrated relevance threshold
> (~0.25) for abstention rather than always forcing an answer.
