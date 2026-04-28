# 08 — Cost Model

What this system actually costs. Two very different numbers: one-time
ingestion, and per-query.

All prices below are 2026-current; recheck provider pricing pages before
relying on these numbers in a budget.

## The corpus

100 videos × 10 minutes = 1,000 minutes of content.

At ~150 wpm and ~1.3 tokens/word:

```
1000 min × 150 wpm × 1.3 tokens/word ≈ 195,000 tokens
```

Round to **~200,000 tokens** of transcript text. ~500 chunks at 400 tokens
each. By RAG standards, this is tiny — the scary cost numbers online assume
millions of documents.

## One-time ingestion cost

Happens once per video, plus whenever a video is re-transcribed or replaced.

### Transcription

| Source | Cost |
|---|---|
| YouTube captions (already exist) | **$0** |
| OpenAI Whisper API ($0.006/min) | $6 |
| Groq Whisper Turbo (~$0.04/hr) | ~$0.67 |

If videos are on YouTube with creator-uploaded captions, just pull them with
the `youtube-transcript` npm package. Free, and creator captions are usually
better than auto-ASR.

### Embedding the corpus

200,000 tokens with `text-embedding-3-small` at $0.02/1M:

```
200,000 × $0.02 / 1,000,000 = $0.004
```

**~$0.004.** Less than half a cent. Not a typo.

With `text-embedding-3-large` ($0.13/1M): **~$0.026**.

### Storage

500 chunks × 1536 dims × 4 bytes ≈ 3 MB. On any managed Postgres, this is a
rounding error. **$0/month effectively.**

### Total one-time ingestion

**Under $1** with YouTube captions, **~$6** if transcribing from scratch.
Not where the money goes.

## Per-query cost — what actually matters

A single question runs through this pipeline:

```
query → [rewrite] → [embed] → [pgvector] → [rerank] → [LLM]
```

Stage by stage:

### 1. Query rewriting (optional)

Claude Haiku 4.5 with ~120 input tokens and ~30 output tokens:
- Input: 120 × $1/1M = $0.00012
- Output: 30 × $5/1M = $0.00015
- **~$0.0003 per query**

Skip until eval says it helps. Most simple Q&A doesn't need it.

### 2. Embedding the query

20 tokens × $0.02/1M = **~$0.0000004 per query**. Effectively zero.

### 3. Vector search in pgvector

Self-hosted compute, no per-query API charge. On a small managed Postgres
(Supabase/Neon free or $25/month tier), call it **~$0.0001 per query**
amortized.

### 4. Reranking with Cohere Rerank 3.5

$2 per 1,000 searches → **$0.002 per query**.

Same price whether you rerank 10 candidates or 50.

### 5. Answer generation — the dominant cost

Typical request:
- System prompt: ~400 tokens
- 5 retrieved chunks × 400 tokens = 2,000 tokens
- User question: ~30 tokens
- **Total input: ~2,500 tokens**
- **Generated answer: ~400 tokens**

| Model | Input $/1M | Output $/1M | Per query |
|---|---|---|---|
| Claude Haiku 4.5 | $1 | $5 | $0.0025 + $0.002 = **$0.0045** |
| GPT-5-mini | ~$0.25 | ~$2 | ~**$0.0014** |
| **Claude Sonnet 4.6** | **$3** | **$15** | **$0.0075 + $0.006 = $0.0135** |
| GPT-5 | ~$1.25 | ~$10 | ~$0.0031 + $0.004 = **$0.0071** |
| Claude Opus 4.7 | $15 | $75 | $0.0375 + $0.03 = **$0.0675** |

## Total per-query cost

| Stack | Rewrite | Embed | Search | Rerank | Generate | **Total** |
|---|---|---|---|---|---|---|
| Budget (Haiku, no rewrite, no rerank) | — | <$0.0001 | $0.0001 | — | $0.0045 | **~$0.005** |
| **Balanced** (Sonnet + rerank, no rewrite) | — | <$0.0001 | $0.0001 | $0.002 | $0.0135 | **~$0.016** |
| Premium (Opus + rewrite + rerank) | $0.0003 | <$0.0001 | $0.0001 | $0.002 | $0.0675 | **~$0.070** |

**Headline numbers for this corpus:**
- Rock-bottom: **~$0.005/query** (half a cent)
- Balanced default: **~$0.015/query** (1.5¢)
- Premium: **~$0.07/query** (7¢)

## Where the money goes

Stacking up the balanced config:

```
Generation       ~85%
Reranking        ~12%
Infrastructure    ~3%
Embeddings       <1%
```

Two levers that move the bill:

1. **Generator model choice.** Sonnet → Haiku cuts generation cost ~3×.
   Opus → Sonnet cuts it ~5×. Pick the cheapest model your eval allows.
2. **Caching.** If 20% of student questions are duplicates ("what is
   useState?" asked 50 times), cache by question hash. Free for repeats.
   Real-world educational RAG sees 30–60% cache hit rates.

## Scaling

Per-query cost is roughly invariant in corpus size. 100 videos vs 10,000
videos doesn't change generation cost meaningfully — you still feed the LLM
5 chunks. What changes:

- One-time embedding cost (still pennies → dollars at corpus of millions).
- Postgres instance size (negligible at our scale).

Monthly cost by query volume, balanced stack:

| Questions/month | Cost |
|---|---|
| 1,000 | ~$16 |
| 10,000 | ~$160 |
| 100,000 | ~$1,600 |
| 1,000,000 | ~$16,000 |

Add ~$25/month for managed Postgres and you have the full operational
picture.

## Budget choices when scaling matters

If query volume gets large enough that the bill stings:

1. **Cache aggressively.** Question-hash caching is the single biggest lever.
2. **Tiered routing.** Cheap model for simple queries, expensive for hard
   ones. A small classifier LLM picks the tier.
3. **Skip rerank for high-confidence vector hits.** If top vector score is
   already >0.85, you can skip the reranker call. Test on eval first.
4. **Self-host the reranker.** `bge-reranker-v2-m3` on a GPU or CPU box.
   Eliminates the Cohere bill. Worth it past ~100k queries/month; not before.
5. **Move embeddings to a cheaper provider** if cost matters at ingest time
   (it almost certainly doesn't).

## What an interviewer should hear

> Per query in the balanced config (Sonnet 4.6 + Cohere Rerank + pgvector)
> costs about 1.5 cents. ~85% of that is generation; reranking is ~12%;
> infrastructure and embeddings are rounding errors. One-time ingestion of
> the entire 100-video corpus is under $10. The biggest cost levers are
> generator model choice and answer caching — caching alone typically cuts
> real-world educational RAG cost by 30–60% because student questions have
> heavy long-tail duplicates.
