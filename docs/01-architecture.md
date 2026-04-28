# 01 — Architecture

End-to-end view of every stage and every model in the pipeline. Each stage links
to the doc that covers it in depth.

## The full pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                      INGESTION (one-time per video)             │
└─────────────────────────────────────────────────────────────────┘

  Video file / YouTube URL
        │
        ▼
  ┌──────────────┐
  │ Transcribe   │  Whisper API, AssemblyAI, or YouTube captions
  │              │  Output: segments with start/end timestamps
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │ Chunk        │  Merge segments → ~400-token windows w/ 60-token overlap
  │              │  CRITICAL: preserve startTime/endTime on every chunk
  └──────┬───────┘  See: 02-chunking.md
         │
         ▼
  ┌──────────────┐
  │ Embed        │  text-embedding-3-small → 1536-dim vector per chunk
  │              │  Batched (one API call for many chunks)
  └──────┬───────┘  See: 03-embeddings.md
         │
         ▼
  ┌──────────────┐
  │ Upsert into  │  pgvector table with metadata (videoId, courseId,
  │ pgvector     │  startTime, endTime, chunkIndex)
  └──────────────┘  See: 04-pgvector-setup.md


┌─────────────────────────────────────────────────────────────────┐
│                        QUERY (per request)                      │
└─────────────────────────────────────────────────────────────────┘

  User question
        │
        ▼
  ┌──────────────┐
  │ Rewrite      │  (optional) Resolve "what about the second one?"
  │ query        │  Claude Haiku 4.5 — small, fast, cheap
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │ Embed query  │  Same model used at ingest time
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │ Vector       │  similaritySearch top-20, filtered by courseId
  │ search       │  pgvector with HNSW index, cosine distance
  └──────┬───────┘  See: 05-retrieval-and-rerank.md
         │
         ▼
  ┌──────────────┐
  │ Rerank       │  Cohere Rerank 3.5 → true top-5
  │              │  Cross-encoder, calibrated relevance scores
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │ Generate     │  Claude Sonnet 4.6 with strict prompt:
  │ answer       │  "answer only from context, cite timestamps"
  └──────┬───────┘  See: 06-generation.md
         │
         ▼
  Answer + "▶ Watch at 0:47" deep-links
```

## Models used, by stage

| Stage | Model | Cost order | Notes |
|---|---|---|---|
| Transcription | OpenAI Whisper | one-time | Skip if YouTube captions exist |
| Embedding (ingest + query) | `text-embedding-3-small` | tiny | Same model both times — non-negotiable |
| Query rewriting | Claude Haiku 4.5 | tiny | Optional; skip until eval says it helps |
| Vector search | (none — Postgres) | infra only | HNSW index, sub-50ms |
| Reranking | Cohere Rerank 3.5 | small | $2/1k searches; biggest quality lever |
| Generation | Claude Sonnet 4.6 | dominant | ~85% of per-query cost |
| Judge (eval only) | GPT-5 or Claude Opus | offline | Different family from generator |
| Synthetic Q gen (bootstrap) | GPT-5-mini or Haiku | one-time | Used only to build initial eval set |

See `08-cost-model.md` for the per-query math.

## Why this shape

A few decisions worth defending:

**Why over-retrieve then rerank.** Embeddings are fast and cheap but
imprecise — they compute query and doc vectors independently. Rerankers are
slower but read query and doc together, scoring them as a pair. Best of both:
embeddings find the candidate pool (top 20–50), reranker picks the real top 5.
Recall@5 typically jumps 10–15 points with a reranker added.

**Why preserve timestamps from segment-level all the way through.** If the
chunk that answers the question came from 0:47–1:02 of `lesson-4.mp4`, the user
should be able to click and watch *that* moment. Char-level chunking loses this.
You can reconstruct timestamps with offset math, but it's fragile — chunk at the
segment level from the start.

**Why pgvector over Pinecone.** The product already runs on Postgres. One
database means transactional ingestion, SQL joins to app tables, and `WHERE
courseId = ?` combined with vector search in a single query. Pinecone scales
better past tens of millions of vectors; we're at 500. See `04-pgvector-setup.md`.

**Why LangChain.js, sparingly.** Useful for: provider-agnostic interfaces
(`ChatOpenAI` ↔ `ChatAnthropic`), document loaders, the retriever abstraction,
LangSmith tracing. Not useful for: anything custom or anything we want to debug
quickly. We drop to raw SDKs when LangChain's abstractions get in the way.

## What this architecture deliberately doesn't include

- **No agents.** Linear pipeline; no tool-calling loops.
- **No memory / chat history.** Single-turn Q&A for v1. Add it when product needs it.
- **No streaming UI yet.** Generation streams from the LLM but the API can return after completion. Streaming end-to-end is a v1.1 feature.
- **No re-embedding on the fly.** Embeddings are written once at ingest. Query-time operations (search, rerank) are read-only against pgvector.
- **No multi-modal.** We work with transcripts, not video frames or audio embeddings.
