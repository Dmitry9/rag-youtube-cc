# Course Content RAG — Knowledge Base

A production-grade Retrieval-Augmented Generation system for querying a library
of video course transcripts. Built on Node.js + LangChain.js + Postgres/pgvector.

## What it does

Given ~100 video transcripts (10 min average), a user asks a natural-language
question and gets back a grounded answer with deep-links to the exact moment in
the source video.

**Status:** steps 0–6 of the curriculum are built and working — the `ingest`,
`search`, and `ask` CLIs run the full pipeline below. Steps 7–10 (the eval
harness: recall@5, MRR, LLM-as-judge, cost telemetry) are in progress.

```
User question
   │
   ▼
[query rewriter]   (optional, small LLM)
   │
   ▼
[embedding model]  text → vector
   │
   ▼
[pgvector search]  top-20 candidates by cosine similarity
   │
   ▼
[reranker]         Cohere Rerank 3.5 → top-5
   │
   ▼
[generator LLM]    grounded answer + timestamp citations
   │
   ▼
Answer with "▶ Watch at 0:47" deep-links
```

## Learning by building

If you're using this repo to learn RAG, follow [`LEARNING_PLAN.md`](LEARNING_PLAN.md)
— a 10-step build-as-you-learn curriculum with exercises, checkpoints, and
self-test questions tied to each doc below.

## Documents in this folder

Read in order if you're new to the project:

1. [`01-architecture.md`](docs/01-architecture.md) — end-to-end pipeline, every stage, every model
2. [`02-chunking.md`](docs/02-chunking.md) — how transcripts become retrieval units, why timestamps matter
3. [`03-embeddings.md`](docs/03-embeddings.md) — what embeddings are, model choice, dimensions
4. [`04-pgvector-setup.md`](docs/04-pgvector-setup.md) — schema, indexes, why pgvector over Pinecone
5. [`05-retrieval-and-rerank.md`](docs/05-retrieval-and-rerank.md) — vector search + Cohere Rerank in code
6. [`06-generation.md`](docs/06-generation.md) — prompt template, model choice, citations, abstention
7. [`07-evaluation.md`](docs/07-evaluation.md) — eval set, recall@k, MRR, the tuning loop
8. [`08-cost-model.md`](docs/08-cost-model.md) — what one query actually costs, where the money goes
9. [`09-environment-setup.md`](docs/09-environment-setup.md) — Windows/WSL2 setup, Postgres install, common gotchas

## Stack at a glance

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js + TypeScript | Same as surrounding product |
| Glue | LangChain.js (sparingly) | Adapters over providers; we drop to raw SDKs when it gets in the way |
| Embeddings | OpenAI `text-embedding-3-small` | 1536 dims, $0.02/1M tokens, plenty for course content |
| Vector store | Postgres + pgvector | Already in the stack; metadata filters + vector search in one query |
| Reranker | Cohere Rerank 3.5 | Biggest quality bump per dollar; ~$2/1k searches |
| Generator | Claude Sonnet 4.6 (default) | Strong instruction-following; price/quality sweet spot |
| Eval | Custom harness + LLM-as-judge | Run on every PR that touches retrieval or prompts |

## What we deliberately are NOT doing

- **Not using LangChain agents.** The pipeline is linear and stable.
- **Not using a separate vector DB.** Postgres is enough at our scale.
- **Not fine-tuning the embedding model.** General-purpose is plenty until eval says otherwise.
- **Not skipping reranking.** It's the single biggest cheap win after chunking.
- **Not skipping the eval set.** Tuning without measurement is guessing.

## Quickstart

```bash
npm install
cp .env.example .env             # add OPENAI_API_KEY, COHERE_API_KEY, ANTHROPIC_API_KEY, DATABASE_URL
npm run check                    # verify DB connectivity + pgvector (schema: docs/04-pgvector-setup.md)
npm run ingest                   # chunk + embed + insert data/transcripts/*.json
npm run search -- "react state" --rerank   # retrieval only: vector search + Cohere rerank
npm run ask -- "how do I update state in react?"
```

The eval harness (`docs/07-evaluation.md`) is the next step being built.
