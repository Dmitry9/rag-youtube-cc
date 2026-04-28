# 07 — Evaluation

How to actually know whether the system is working, and how to tune it.

This doc is the most important one in the repo. Without an eval set, every
chunk-size argument is a vibes contest. With one, every change is measurable.

## The goal

> "For my content and my users, what configuration gives me the best
> retrieval and answer quality?"

Answer it by:
1. Building an eval set (questions with known-correct chunks).
2. Running the pipeline at multiple configurations.
3. Measuring `recall@k`, `MRR`, and groundedness.
4. Picking the winner. Re-running on every change.

## The eval set

50–100 question/answer pairs where you know the ground truth. Three ways to
build it, from best to fastest:

**(a) Mine real user questions.** When you have user logs, sample 50
across difficulty levels. Manually find the source chunk for each. Gold
standard — reflects real usage.

**(b) Domain expert writes them.** Someone who knows the content writes 50
varied questions and points to the source. Good signal, slow to produce.

**(c) Synthetic.** For each chunk, prompt an LLM: "Write a question this
passage answers." Get free pairs. Filter with a second LLM pass. Lowest
quality, fastest to produce.

Pragmatic mix: generate 100 synthetic, manually clean to 50, add real
questions as they come in.

### Eval set shape

```json
[
  {
    "id": "q001",
    "question": "How do I update the value of a state variable in React?",
    "groundTruth": {
      "videoId": "course-101-lesson-4",
      "startTime": 47.3,
      "endTime": 78.0
    },
    "referenceAnswer": "Call the setter function returned by useState with the new value."
  }
]
```

The `groundTruth` window doesn't need to be exact — within ~30 seconds is
fine. The `referenceAnswer` is optional but useful for end-to-end eval.

## What "correct retrieval" means

A retrieved chunk is a "hit" if its `[startTime, endTime]` window overlaps
with the ground-truth window for the same `videoId`:

```ts
// src/eval/metrics.ts
export function isHit(chunk, gt) {
  if (chunk.metadata.videoId !== gt.videoId) return false;
  return (
    chunk.metadata.startTime <= gt.endTime &&
    chunk.metadata.endTime >= gt.startTime
  );
}
```

Simple, deterministic, no LLM cost. Good enough for chunk-size and
retrieval tuning.

For evaluating answer text (not just retrieval), use **LLM-as-judge** —
covered later in this doc.

## The metrics

**Recall@k** — does any retrieved top-k chunk contain the answer?

```
recall@k = (questions where a hit appears in top k) / total
```

Use **k=5** since that's usually what feeds the LLM.

**MRR (Mean Reciprocal Rank)** — when there's a hit, how high?

```
RR = 1 / rank-of-first-hit (1, 0.5, 0.33, 0.25, 0.2, ..., or 0 if no hit)
MRR = mean(RR over all questions)
```

`recall@5` answers "are we finding it?"
`MRR` answers "are we finding it near the top?"

Use both. They diverge when retrieval is recalling fine but ranking poorly —
a sign you need a reranker or a different embedding model.

**nDCG@k** — like MRR but handles multiple relevant chunks per question.
Skip until you care.

## The tuning harness

```ts
// src/eval/runEval.ts
import { OpenAIEmbeddings } from "@langchain/openai";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { Document } from "langchain/document";
import { chunkTranscript } from "../ingest/chunkTranscript.js";
import { retrieveWithRerank } from "../retrieve/retrieveWithRerank.js";
import { isHit } from "./metrics.js";
import evalSet from "./eval-set.json" assert { type: "json" };
import transcripts from "../../data/transcripts.json" assert { type: "json" };

const embeddings = new OpenAIEmbeddings({ model: "text-embedding-3-small" });

interface Config {
  chunkTokens: number;
  overlapTokens: number;
  tableName: string;
  useRerank: boolean;
  initialK: number;
  finalK: number;
}

async function evaluate(cfg: Config) {
  // 1. Re-ingest at this config (fresh table per config)
  const store = await PGVectorStore.initialize(embeddings, {
    postgresConnectionOptions: { connectionString: process.env.DATABASE_URL! },
    tableName: cfg.tableName,
    distanceStrategy: "cosine",
  });
  await store.delete({ filter: {} });

  for (const t of transcripts) {
    const chunks = chunkTranscript(t, {
      chunkTokens: cfg.chunkTokens,
      overlapTokens: cfg.overlapTokens,
    });
    const docs = chunks.map((c, i) => new Document({
      pageContent: c.pageContent,
      metadata: { ...c.metadata, chunkIndex: i },
    }));
    const ids = chunks.map((_, i) => `${t.videoId}::${i}`);
    await store.addDocuments(docs, { ids });
  }

  // 2. Run every eval question
  let hits = 0;
  let mrrSum = 0;
  const perQuestion = [];

  for (const q of evalSet) {
    const results = cfg.useRerank
      ? await retrieveWithRerank(q.question, {
          initialK: cfg.initialK,
          finalK: cfg.finalK,
        })
      : await store.similaritySearch(q.question, cfg.finalK);

    const rank = results.findIndex(r => isHit(r, q.groundTruth));
    const hit = rank !== -1;
    if (hit) hits++;
    mrrSum += hit ? 1 / (rank + 1) : 0;
    perQuestion.push({ id: q.id, rank, hit });
  }

  return {
    cfg,
    recallAtK: hits / evalSet.length,
    mrr: mrrSum / evalSet.length,
    perQuestion,
  };
}

// Sweep
const configs: Config[] = [
  { chunkTokens: 200, overlapTokens: 30,  tableName: "chunks_200", useRerank: false, initialK: 5,  finalK: 5 },
  { chunkTokens: 300, overlapTokens: 50,  tableName: "chunks_300", useRerank: false, initialK: 5,  finalK: 5 },
  { chunkTokens: 400, overlapTokens: 60,  tableName: "chunks_400", useRerank: false, initialK: 5,  finalK: 5 },
  { chunkTokens: 500, overlapTokens: 75,  tableName: "chunks_500", useRerank: false, initialK: 5,  finalK: 5 },
  { chunkTokens: 700, overlapTokens: 100, tableName: "chunks_700", useRerank: false, initialK: 5,  finalK: 5 },
  // Then re-run the winner with rerank on:
  { chunkTokens: 400, overlapTokens: 60,  tableName: "chunks_400", useRerank: true,  initialK: 20, finalK: 5 },
];

for (const cfg of configs) {
  const r = await evaluate(cfg);
  console.log(
    `chunk=${cfg.chunkTokens} rerank=${cfg.useRerank} ` +
    `recall@${cfg.finalK}=${r.recallAtK.toFixed(3)} mrr=${r.mrr.toFixed(3)}`
  );
}
```

## What good output looks like

```
chunk=200 rerank=false  recall@5=0.62  mrr=0.41
chunk=300 rerank=false  recall@5=0.74  mrr=0.52
chunk=400 rerank=false  recall@5=0.83  mrr=0.61   ← plateau
chunk=500 rerank=false  recall@5=0.84  mrr=0.60
chunk=700 rerank=false  recall@5=0.81  mrr=0.55   ← dilution
chunk=400 rerank=true   recall@5=0.92  mrr=0.78   ← reranker adds 9 pts
```

How to read it:

- **Pick the smallest chunk size where `recall@5` plateaus.** Going bigger
  doesn't help retrieval and hurts on cost and precision.
- **Watch MRR.** If `recall@5` holds but MRR drops at larger sizes, embeddings
  are getting diluted (right answer in top-5 but ranked lower).
- **Reranking should bump both.** If it doesn't, something's wrong (chunks
  too short for the reranker to score well, or eval set too small).
- **If everything is flat and bad (~0.5 across the board), chunk size isn't
  your problem.** Look at the embedding model, ingestion quality, or the
  eval set itself.

## Failure analysis

Numbers alone don't teach you anything. Dump the failures:

```ts
const worst = result.perQuestion.filter(q => !q.hit);
console.table(worst);
```

Patterns to look for:

- **Short-factoid questions fail at large chunk sizes.** "What year did X
  launch?" → answer is one sentence, lost in dilution. Smaller chunks win.
- **Multi-hop questions fail at small chunk sizes.** "How does X relate to
  Y?" → X and Y are 30 seconds apart, split into different chunks. Larger
  chunks or parent-child retrieval wins.
- **No vocabulary overlap.** Query and source share no words. Hybrid search
  (BM25 + vector) helps. Query rewriting helps.
- **Wrong video entirely.** Metadata filtering isn't being applied. Fix
  the retrieval call.

Each failure pattern points to a different fix. Chunk size only fixes some.

## Beyond retrieval — judging answer quality

Once retrieval is tuned, evaluate the generated answer too. Use an
**LLM-as-judge** for two things:

**Groundedness:** every claim in the answer is supported by the retrieved
context. (Catches hallucinations.)

**Answer relevance:** the answer addresses the question.

Critical rule: judge model must be from a different family than the
generator. Generator = Claude → judge = GPT (or vice versa). Same-family
judging is biased — models tend to be over-charitable to their own output.

Sketch:

```ts
// src/eval/judgeGroundedness.ts
import OpenAI from "openai";
const openai = new OpenAI();

export async function judgeGroundedness(
  question: string,
  retrievedContext: string,
  answer: string
) {
  const res = await openai.chat.completions.create({
    model: "gpt-5",
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `You are a strict grader. Given a question, a context, and an
answer, judge whether every claim in the answer is supported by the context.
Reply with strict JSON: {"grounded": "yes" | "partial" | "no", "reason": "<1 sentence>"}.`,
      },
      {
        role: "user",
        content: `Question: ${question}\n\nContext:\n${retrievedContext}\n\nAnswer:\n${answer}`,
      },
    ],
    response_format: { type: "json_object" },
  });
  return JSON.parse(res.choices[0].message.content!);
}
```

Run this over every eval question after generation. Track `% grounded = yes`.
Alert on regressions.

Frameworks that bake this in: **Ragas**, **DeepEval**, **Promptfoo**,
**LangSmith** (paid). For our scale, a hand-rolled harness is fine.

## Run it on every PR

Treat the eval set like a regression test suite:

```yaml
# .github/workflows/eval.yml (sketch)
- name: Run RAG eval
  run: npm run eval -- --baseline=main
- name: Fail if recall drops
  run: node scripts/check-eval-regression.js --threshold=0.03
```

Alert if `recall@5` or MRR drops by >3 points. Catches retrieval and
prompt regressions before they ship.

## Grow the eval set with reality

Every user-reported bad answer becomes a test case. Workflow:

1. User reports "wrong answer to X."
2. Add `{ question: "X", groundTruth: {...}, ... }` to `eval-set.json`.
3. Re-run eval — current pipeline fails this question.
4. Fix the pipeline. Re-run. It passes.
5. The test stays. Future regressions on this class of question break the build.

This compounding loop is how RAG quality actually improves over time.

## What an interviewer should hear

> We have a 50-question eval set with timestamped ground-truth windows. On
> every PR we re-run the harness and measure `recall@5` and MRR; alerts
> trigger if either drops by >3 points. Chunk size, embedding model, k, and
> reranker on/off were each picked by sweeping the harness, not by intuition.
> Answer quality is judged offline by a separate LLM (different family from
> the generator) for groundedness and relevance. User-reported bad answers
> become new eval cases — quality compounds.
