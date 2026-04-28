# 03 — Embeddings

What embeddings are, why they work, and what to actually pick.

## The one-line definition

An embedding is a list of numbers (a vector) that represents the meaning of a
piece of text, such that texts with similar meaning land as nearby points in a
high-dimensional space.

## A concrete example

```
"dog"   → [0.21, -0.53, 0.88, ..., 0.04]   (1536 numbers)
"puppy" → [0.19, -0.49, 0.91, ..., 0.07]
"car"   → [-0.62, 0.11, -0.34, ..., 0.77]

similarity(dog, puppy) ≈ 0.92   (very close)
similarity(dog, car)   ≈ 0.15   (far apart)
```

Nobody hand-coded "dogs are like puppies." The model learned it from billions
of sentences where "dog" and "puppy" appear in similar contexts (the
distributional hypothesis). Modern embedding models (transformers) extend this
from words to full sentences and paragraphs.

## Why this is the foundation of RAG

Keyword search fails on:

> Q: "How do I update the value of a state variable?"
> Source: "You call the setter function returned by useState to change the value."

Zero meaningful word overlap. But the embeddings of these two sentences are
close, because the model has seen enough React content to know "update state"
and "call the setter from useState" describe the same thing.

That's the unlock: **semantic search instead of lexical search**.

## Measuring similarity: cosine

Standard distance metric is **cosine similarity** — the cosine of the angle
between two vectors:

```
similarity = (A · B) / (||A|| × ||B||)
```

- `1.0` → same direction (very similar meaning)
- `0.0` → perpendicular (unrelated)
- `-1.0` → opposite (rare for text)

We use cosine because direction encodes meaning, while length often encodes
noise (text length, emphasis). Cosine ignores length.

In pgvector this is the `<=>` operator. The other operators (`<->` L2,
`<#>` inner product) rank text results almost identically — cosine is the safe
default for normalized text embeddings.

## What embedding models DON'T do

Common misunderstandings:

- **They don't understand — they correlate.** No reasoning, just statistical
  similarity. Good enough for retrieval, not for inference.
- **They're not reversible.** You can't recover original text from a vector.
- **They're not portable across models.** OpenAI embeddings and Cohere
  embeddings of the same sentence live in different spaces. **Pick one model
  per index and stick with it. Switching = re-ingest.**
- **They have an input limit, and quality drops before you hit it.** Don't
  feed huge documents in; chunk first.
- **They're weak on negation.** "Effective" and "not effective" embed close
  together. Embeddings capture topic, not truth value.

## Choosing a model

Three things you're really picking between:

**Dimension size.** 384 / 768 / 1536 / 3072. Higher dims → more nuance, more
storage, slower search. **1536 is the right default.** Reach for 3072 only if
your eval shows the smaller model plateauing at unacceptable recall.

**Context window.** How much text per call. OpenAI's is 8191 tokens — far
more than any chunk we'd send. Don't conflate "fits" with "embeds well."

**Language / domain coverage.** Multilingual content → multilingual model.
Domain-heavy text (legal, biomedical, code) → consider a domain model only if
general-purpose underperforms on eval.

## Recommended models (2026)

| Model | Dims | Cost / 1M tok | When |
|---|---|---|---|
| **`text-embedding-3-small`** (OpenAI) | 1536 | $0.02 | Default. Fast, cheap, solid. |
| `text-embedding-3-large` (OpenAI) | 3072 | $0.13 | When small plateaus on eval. |
| `voyage-3-large` (Voyage AI) | 1024 | premium | Often tops MTEB; technical content. |
| `embed-v4` (Cohere) | 1024 | competitive | Strong multilingual; int8 variants. |
| `bge-m3` / `bge-large-en-v1.5` (open) | 1024 | self-host | Free; competitive quality. |
| `nomic-embed-text-v1.5` (open) | 768 | self-host | Variable dims; good self-hosted option. |

Our default: **`text-embedding-3-small`**. Justified because:
- 1536 dims is plenty for ~500 chunks of course content.
- $0.02/1M tokens is negligible: full corpus embedding ≈ $0.004.
- API is reliable, no infra burden.

## Code

Embedding with LangChain:

```ts
// src/embeddings/index.ts
import { OpenAIEmbeddings } from "@langchain/openai";

export const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small",
  // batchSize defaults to 512, which is fine for ingest
});

// Single query (used at retrieval time)
const vec = await embeddings.embedQuery("how do I update state?");
// → number[1536]

// Batch of documents (used at ingest time — uses one API call for many texts)
const vecs = await embeddings.embedDocuments(chunks.map(c => c.pageContent));
// → number[][]
```

Or raw OpenAI SDK if you want to avoid LangChain entirely:

```ts
import OpenAI from "openai";
const openai = new OpenAI();

const res = await openai.embeddings.create({
  model: "text-embedding-3-small",
  input: chunks.map(c => c.pageContent),  // batch in one call
});
const vecs = res.data.map(d => d.embedding);
```

Either way: **batch your embeds at ingest time**. Per-chunk API calls are 100×
slower and chew through rate limits.

## The same model on both sides

Critical rule: the model that embeds your chunks at ingest time MUST be the
same model that embeds the user's query at retrieval time. Different models
produce vectors in different spaces; cosine similarity between them is
meaningless.

Pin the model name in code. Pin the version when the provider exposes it. If
you ever change the model, re-embed the entire corpus in a new table, swap the
read path atomically, drop the old table.

## When to upgrade

Stay on `text-embedding-3-small` until your eval set says it's the bottleneck.
Diagnostic: if recall@5 keeps climbing as you grow chunk size and add
reranking but plateaus well below 0.85, the embedding model is suspect.
Measure with the harness in `07-evaluation.md`.

The usual upgrade path: small → add reranker → large embeddings → fine-tune.
Most teams stop at "small + reranker" and never need the rest.
