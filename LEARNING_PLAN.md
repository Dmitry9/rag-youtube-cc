# Learning Plan — Mastering RAG by Building This System

A hands-on curriculum that turns the design docs in [docs/](docs/) into a
build-as-you-learn path. The goal is **mastery**, not speed: by the end you
should be able to explain every stage of the pipeline in your own words, defend
every model and parameter choice, and diagnose retrieval failures from the
numbers.

## How to use this plan

- One step per sitting. Don't skip ahead — each step builds on the previous.
- For every step:
  1. **Read** the listed doc sections first.
  2. **Build** the exercise. Type the code; don't copy-paste.
  3. Hit the **Checkpoint** before moving on — it's a concrete, observable
     outcome (a number, a row in a table, a working command).
  4. Answer the **Self-test** questions out loud or in writing. If you can't,
     re-read.
  5. Skim the **Pitfalls** so you know what to watch for.
- When you get stuck, the relevant doc has the answer. Cross-references below
  point to the exact section.

You'll build a working RAG system in [src/](src/) and a small corpus in
[data/](data/). Nothing is scaffolded yet — that's deliberate, you build it.

## Prerequisites

- Comfortable with TypeScript/Node basics (`npm`, `import`, async/await).
- Familiar with SQL (`SELECT`, `WHERE`, `JOIN`, `CREATE INDEX`).
- API keys: OpenAI, Cohere, Anthropic. (Free tiers / a few dollars are plenty
  for the whole curriculum — see [docs/08-cost-model.md](docs/08-cost-model.md).)
- Patience for failure analysis. RAG mastery comes from staring at why
  retrieval missed, not from getting it right first try.

---

## Step 0 — Environment

**Read:** [docs/09-environment-setup.md](docs/09-environment-setup.md) (full)

**Build:**
1. WSL2 Ubuntu (you're already in it — verify with `uname -a`).
2. Postgres + pgvector via Docker (Option B in the doc — easier to reset).
3. `nvm install 20`, then `npm init -y` in this repo and add `typescript`,
   `tsx`, `@types/node`, `dotenv` as dev deps.
4. Create `.env` with `DATABASE_URL=postgresql://rag:rag@localhost:5432/rag`.
5. Write a tiny `src/check.ts` that connects with `pg` and runs
   `SELECT '[1,2,3]'::vector;`.

**Checkpoint:** `npx tsx src/check.ts` prints the vector. If you see
`type "vector" does not exist`, the extension isn't installed in your DB —
go back and run `CREATE EXTENSION vector;`.

**Self-test:**
- Why is the project in `~/repo/...` and not `/mnt/c/...`?
- Why does `VECTOR(1536)` need to match the embedding model dimension?
- What's the difference between IVFFlat and HNSW, and why are we using HNSW?

**Pitfalls:**
- Putting the project on `/mnt/c/` — 5–10× slower `npm install`.
- Forgetting `CREATE EXTENSION vector` per database (not per server).

---

## Step 1 — Get a corpus and chunk it

**Read:** [docs/02-chunking.md](docs/02-chunking.md) (full)

**Build:**
1. Pick 3–5 short YouTube videos on one topic (React, Python basics — anything
   with creator captions). Pull captions with the `youtube-transcript` npm
   package. Save raw `{videoId, courseId, segments[]}` JSON to
   `data/transcripts/`.
2. Implement [src/ingest/chunkTranscript.ts](src/ingest/chunkTranscript.ts)
   exactly as in doc 02 — segment-level merging, tiktoken for token counting,
   timestamp preservation, overlap.
3. Write a tiny script that loads one transcript, chunks it at 400 tokens with
   60-token overlap, and prints each chunk: `[chunkIndex] start=Xs end=Ys
   tokens=N | first 80 chars...`.

**Checkpoint:** Inspect the output by hand. For at least one chunk:
- The text should read as one coherent thought.
- `endTime - startTime` should be roughly 60 seconds.
- Adjacent chunks should share ~60 tokens of overlap (verify by eye).

Now run the same transcript at `chunkTokens=100` and `chunkTokens=1500` and
compare. You should *feel* the trade-off described in the doc.

**Self-test:**
- Why segment-level chunking instead of `RecursiveCharacterTextSplitter`?
- What breaks if you embed a 1500-token chunk?
- What breaks if you embed a 100-token chunk?
- How would you re-ingest a video that's been re-recorded? (Hint: stable IDs.)

**Pitfalls:**
- Chunking on character count — you'll get inconsistent token counts.
- Joining all segments into a string first — timestamps are gone forever.

---

## Step 2 — Embeddings: from text to vectors

**Read:** [docs/03-embeddings.md](docs/03-embeddings.md) (full)

**Build:**
1. [src/embeddings/index.ts](src/embeddings/index.ts) — wire up
   `OpenAIEmbeddings` with `text-embedding-3-small`.
2. Embed three short strings: `"dog"`, `"puppy"`, `"car"`. Print the first 8
   numbers of each vector and the vector length.
3. Write a `cosine(a, b)` helper. Compute `cosine(dog, puppy)` and
   `cosine(dog, car)`. They should match the doc's example
   (~0.92 vs ~0.15).
4. Embed all chunks from one transcript using `embedDocuments` (batched, one
   API call). Print the cost: `tokens × $0.02 / 1_000_000`.

**Checkpoint:** Cosine similarity ranks `(dog, puppy) > (dog, car)`. The full
transcript embeds in one API call and costs less than $0.001.

**Self-test:**
- Why does cosine ignore vector length?
- Why must the *same* model embed at ingest time and query time?
- What's wrong with feeding a 5,000-token chunk to the embedding model even
  though its context window is 8,191?
- "Effective" and "not effective" embed close together. Why is that a problem
  for retrieval, and what stage of the pipeline can compensate?

**Pitfalls:**
- Calling `embedQuery` per chunk in a loop — 100× slower than one
  `embedDocuments` batch.
- Mixing two embedding models in one index — vectors are no longer comparable.

---

## Step 3 — pgvector: schema, indexes, ingest

**Read:** [docs/04-pgvector-setup.md](docs/04-pgvector-setup.md) (full)

**Build:**
1. [migrations/001_init.sql](migrations/001_init.sql) — copy the schema from
   the doc. Apply it to your DB.
2. [src/ingest/store.ts](src/ingest/store.ts) and
   [src/ingest/ingestVideo.ts](src/ingest/ingestVideo.ts) — copy from the doc.
3. Add an `npm run ingest` script that loops over `data/transcripts/*.json`
   and calls `ingestVideo`.
4. After ingestion, in `psql`, run:
   ```sql
   SELECT video_id, COUNT(*) FROM transcript_chunks GROUP BY video_id;
   SELECT id, metadata->>'startTime' FROM transcript_chunks LIMIT 3;
   ```
5. Run a raw vector query against your DB (the SQL the LangChain wrapper
   generates — see doc 04). Embed `"how do I get started"` in a quick script,
   plug the vector in, and inspect the top 5 results by hand.

**Checkpoint:** Counts match `chunkTranscript` output. The metadata JSONB has
`startTime`, `endTime`, `videoId`, `courseId`, `chunkIndex`. The raw SQL
query returns plausible top-5 chunks for your test query.

**Self-test:**
- Why is `vector_cosine_ops` indexed but you query with `<=>`? What if you
  used `<->` instead?
- Why store the original `content` alongside `embedding`?
- What does `ON DELETE CASCADE` give you when you re-ingest a video?
- Why one Postgres instead of Pinecone at this scale?

**Pitfalls:**
- Schema dimension mismatch (`VECTOR(768)` vs 1536 model output) — fails at
  insert, not migration.
- Forgetting the GIN index on `metadata` — `WHERE metadata @> '{...}'`
  filters do a full scan.

---

## Step 4 — Vector search (no reranker yet)

**Read:** [docs/05-retrieval-and-rerank.md](docs/05-retrieval-and-rerank.md)
sections "The pattern", "Why ~20 candidates", up to "Code".

**Build:**
1. [src/retrieve/vectorSearch.ts](src/retrieve/vectorSearch.ts) —
   `similaritySearch(query, k, { courseId })` returning top-k chunks.
2. CLI: `npm run search -- "your question"` prints top-5 with similarity
   scores, video IDs, and timestamps.
3. Try 5 questions about your corpus. For each, eyeball: is the right chunk
   in the top 5? In what position?

**Checkpoint:** You have a working semantic search. For at least 3 of 5
questions the right chunk is in the top 5. (If it's worse than that, your
chunking is probably bad — go back to step 1.)

**Self-test:**
- Why retrieve 20 (not 5) when only 5 will go to the LLM later?
- A query has zero word overlap with the source chunk yet retrieves it
  correctly. Why does that work?
- What does "embeddings are imprecise" actually mean?

**Pitfalls:**
- Skipping the `courseId` filter — retrieval pulls from all courses and
  noise creeps in.
- Not normalizing — for OpenAI embeddings this is already done; for some
  others it isn't and cosine math breaks.

---

## Step 5 — Add the reranker

**Read:** [docs/05-retrieval-and-rerank.md](docs/05-retrieval-and-rerank.md)
"Code" through end.

**Build:**
1. [src/retrieve/retrieveWithRerank.ts](src/retrieve/retrieveWithRerank.ts) —
   copy from the doc. Pull 20 from pgvector, rerank with Cohere, return top 5.
2. Add `--rerank` flag to your `npm run search` CLI. For each of your 5
   questions, run with and without rerank. Compare the order.

**Checkpoint:** Reranker reorders the candidates. On at least 1 of your 5
questions, rerank promotes a chunk that vector search ranked low. You can
explain *why* in plain English (the chunk had the right meaning but the
embeddings missed it).

**Self-test:**
- Embeddings are query-doc-independent. Cross-encoders read query and doc
  *together*. Why does that improve quality?
- Cohere's `relevanceScore` is calibrated 0–1. Cosine similarity isn't
  calibrated. What does that let you do?
- The reranker doesn't write to Postgres. Why is that the right design? What
  would go wrong if it did?
- Why is reranking 10 candidates the same price as reranking 50?

**Pitfalls:**
- Forgetting that Cohere returns *indexes back into your input array*, not
  documents. Map back carefully or you'll cite the wrong chunks.
- Reranking only 5 candidates — the reranker can't improve what it didn't
  receive.

---

## Step 6 — Generation with citations

**Read:** [docs/06-generation.md](docs/06-generation.md) (full)

**Build:**
1. [src/generate/promptTemplate.ts](src/generate/promptTemplate.ts) — copy
   from the doc.
2. [src/generate/answer.ts](src/generate/answer.ts) — wire retrieval +
   prompt + Claude Sonnet 4.6, return `{ answer, citations[] }`.
3. CLI: `npm run ask -- "question"` prints the answer and the citations.
4. Try to break it. Ask:
   - A question your corpus answers well (sanity).
   - A question your corpus partially answers (does it abstain or
     hallucinate?).
   - A completely off-topic question (does it decline?).
   - A leading question that pushes outside knowledge ("Wasn't React
     invented at Meta?" when your corpus only covers hooks). Watch for
     fabrication.

**Checkpoint:** Answers cite chunks like `[1]` or `[2]` with timestamps. The
abstention case returns "I don't have information…" instead of inventing.
Off-topic gets declined politely.

**Self-test:**
- Why `temperature: 0.1` and not 0 or 0.7?
- Name the 6 anti-hallucination defenses listed in the doc. Which is
  cheapest? Which is most reliable?
- The prompt says "answer ONLY from the provided excerpts." Why is that not
  enough on its own?
- Why is the judge model in eval required to be a *different family* than
  the generator?

**Pitfalls:**
- Letting the model emit citations like `[1]` for a chunk that doesn't
  exist — verify every `[n]` resolves to a real candidate.
- High `maxTokens` so generation rambles — keep it tight.

---

## Step 7 — Build the eval set

**Read:** [docs/07-evaluation.md](docs/07-evaluation.md) sections through
"What 'correct retrieval' means".

**Build:**
1. Create `data/eval-set.json` with **20 questions** for your corpus (start
   small; grow later). For each: `id`, `question`, `groundTruth: { videoId,
   startTime, endTime }`, optional `referenceAnswer`.
   - Mix: 5 simple factoids, 5 conceptual ("why"/"how"), 5 multi-hop, 5
     edge cases (vague queries, off-topic).
   - For ground truth, watch the video and write down the timestamp range.
2. [src/eval/metrics.ts](src/eval/metrics.ts) — `isHit(chunk, gt)` (timestamp
   overlap, same `videoId`).

**Checkpoint:** 20 question/groundTruth pairs exist. `isHit` returns `true`
for a hand-crafted hit and `false` for a hand-crafted miss.

**Self-test:**
- Why is timestamp-overlap a sufficient definition of "hit"?
- Why 50–100 questions and not 1,000?
- What's the failure mode of synthetic eval sets, and how do you mitigate it?

**Pitfalls:**
- Tightening `groundTruth` to a 2-second window — it's too strict and your
  eval will look worse than it is. ~30s window is fine.
- Writing only easy questions — eval sets that don't fail are useless.

---

## Step 8 — Run the harness; sweep configurations

**Read:** [docs/07-evaluation.md](docs/07-evaluation.md) "The metrics"
through "What good output looks like".

**Build:**
1. [src/eval/runEval.ts](src/eval/runEval.ts) — implement `evaluate(cfg)`.
   For each config: re-ingest into a separate table (`chunks_200`,
   `chunks_400`, …), run every eval question, compute `recall@5` and `MRR`.
2. Run the sweep from the doc: chunk sizes 200/300/400/500/700, then the
   winner with rerank on.

**Checkpoint:** A table of `{chunkTokens, useRerank, recall@5, MRR}`. You
should see a recall plateau (probably around 300–400 tokens for short videos)
and a clear bump from rerank.

Then **dump the failures** for the worst config:
```ts
const worst = result.perQuestion.filter(q => !q.hit);
console.table(worst);
```
Read each failed question. Categorize: factoid / multi-hop / no overlap /
wrong-video. This is where you actually learn RAG.

**Self-test:**
- `recall@5` and `MRR` diverge — recall is fine, MRR drops at large chunk
  sizes. What's happening?
- Everything is flat at ~0.5 across all configs. What does that tell you?
- Why is "pick the smallest chunk size where recall plateaus" the rule, not
  "pick the largest recall"?
- Why re-ingest into a fresh table per config instead of overwriting?

**Pitfalls:**
- Tuning by intuition instead of by the table. The whole point is to escape
  vibes-based decisions.
- Eval set too small (<20) — noise dominates and you'll chase phantom
  improvements.

---

## Step 9 — LLM-as-judge for groundedness

**Read:** [docs/07-evaluation.md](docs/07-evaluation.md) "Beyond retrieval"
through end. Plus [docs/06-generation.md](docs/06-generation.md)
"Anti-hallucination — defense in depth".

**Build:**
1. [src/eval/judgeGroundedness.ts](src/eval/judgeGroundedness.ts) — copy from
   the doc. Use GPT-5 (different family from your Claude generator).
2. Extend the harness: after generation, judge groundedness. Track
   `% grounded = yes` alongside recall and MRR.
3. Find one question where the answer is wrong. Manually craft a *bad*
   answer (use outside knowledge). Confirm the judge marks it `"no"`.

**Checkpoint:** A groundedness % over your 20 eval questions. The judge
catches the hand-crafted bad answer.

**Self-test:**
- Same-family judging (Claude judging Claude) is biased toward over-charity.
  Why?
- Why is groundedness alone insufficient? (Hint: grounded ≠ relevant.)
- The reranker abstention threshold and the groundedness judge both protect
  against hallucination. Which is cheaper? Which is more thorough?

**Pitfalls:**
- Using the same model for generation and judging. The number will lie.
- Free-form judge output instead of strict JSON — flaky parsing breaks the
  harness.

---

## Step 10 — Cost telemetry and the dollar reality

**Read:** [docs/08-cost-model.md](docs/08-cost-model.md) (full)

**Build:**
1. Add token counting to every API call in your pipeline (most SDKs return
   `usage`). Compute and log per-query cost: rewrite + embed + rerank +
   generate.
2. Run 50 queries through your pipeline. Log: total cost, mean per query,
   95th percentile.
3. Swap the generator from Sonnet → Haiku. Re-run. Compare cost AND
   groundedness from step 9. Did quality drop? By how much?

**Checkpoint:** You have a real per-query number for *your* corpus and *your*
queries — not a doc estimate. You can defend your choice of generator with
a cost-vs-quality trade-off, not a guess.

**Self-test:**
- Where does ~85% of per-query cost actually go in your numbers?
- Caching by question hash gets 30–60% hit rates in real educational RAG.
  Why is that ratio higher for education than for, say, customer support?
- Per-query cost is roughly invariant in corpus size. Why?

**Pitfalls:**
- Trusting the doc's numbers. Provider pricing changes — verify against
  your usage dashboard.
- Optimizing cost before quality is acceptable. Cheap and wrong is worse
  than expensive and right.

---

## After mastery — things to try

Once you've finished step 10, the foundations are solid. To go deeper, pick
one of these and treat it as a mini-project (read-build-measure):

1. **Hybrid search** ([docs/04-pgvector-setup.md](docs/04-pgvector-setup.md)
   "Drop to raw SQL"). Vector + BM25 with reciprocal rank fusion. Re-run
   your eval. Does it help on factoid questions?
2. **Query rewriting** ([docs/01-architecture.md](docs/01-architecture.md)).
   Small LLM resolves "what about the second one?" against history. Worth it
   only if you add multi-turn.
3. **Streaming generation** ([docs/06-generation.md](docs/06-generation.md)
   "Streaming"). Wire to a tiny Next.js or Express route + SSE.
4. **Caching** ([docs/08-cost-model.md](docs/08-cost-model.md)
   "Budget choices"). Hash question + courseId, cache for 24h. Measure your
   actual hit rate.
5. **Tiered routing** ([docs/06-generation.md](docs/06-generation.md)
   "Tiered routing"). Cheap model for short questions, expensive for
   "why/how/compare". Measure cost AND quality regression.
6. **Failure analysis loop** ([docs/07-evaluation.md](docs/07-evaluation.md)
   "Grow the eval set with reality"). Each time *you* get a bad answer
   from your own system, add it as an eval case. Watch the eval set
   compound into a regression suite.

## Definition of "mastered"

You can sit down with someone unfamiliar with RAG and, without notes:

- Draw the full pipeline (ingest + query) and name every model and why.
- Defend chunk size, k, rerank thresholds, and generator choice with
  numbers from your eval, not opinion.
- Diagnose a failing question by reading retrieval + judge output.
- Explain what each layer of anti-hallucination defense does and why no
  single layer is enough.
- Quote per-query cost ±50% and name the dominant line item.

If the answer to "why?" is ever "because the doc said so", you haven't
mastered that piece yet. Go back, run an experiment, and let the numbers
teach you.
