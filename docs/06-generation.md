# 06 — Generation

Turning retrieved chunks into a grounded answer with citations.

## What this stage does

```
question + retrieved chunks → prompt → LLM → answer with timestamps
```

Two things matter most:

1. **The model stays in the provided context.** No hallucination, no
   "general knowledge."
2. **Every claim cites a source.** With a `videoId` + `startTime` so the UI
   can render "▶ Watch at 0:47" deep-links.

Get those right and the rest is polish.

## Model choice

The generator dominates cost — typically ~85% of per-query spend (see
`08-cost-model.md`). Pick deliberately.

| Model | Input $/1M | Output $/1M | Use for |
|---|---|---|---|
| Claude Haiku 4.5 | $1 | $5 | Cheap workhorse, simple Q&A |
| **Claude Sonnet 4.6** | **$3** | **$15** | **Default — price/quality sweet spot** |
| GPT-5-mini | ~$0.25 | ~$2 | Cheapest tier on OpenAI |
| GPT-5 | ~$1.25 | ~$10 | Strong reasoning |
| Claude Opus 4.7 | $15 | $75 | Premium quality, hard questions |

What to optimize for:
- **Instruction-following.** Will it actually stay in context? Claude
  consistently top-tier here.
- **Long-context performance.** Can it handle 5–10 chunks at 400 tokens each
  without losing focus? Test on your eval set.
- **Cost.** This runs on every query.

Default: **Claude Sonnet 4.6**. Considered swapping if eval says Haiku is
sufficient, or if a query class needs Opus quality.

## Tiered routing (optional)

When questions vary in difficulty, route them:

```ts
async function route(question: string): Promise<"haiku" | "sonnet" | "opus"> {
  // Simple heuristic, refine with eval data:
  if (question.length < 30) return "haiku";              // factoid
  if (/why|how does|compare|what is the difference/i.test(question)) return "sonnet";
  return "haiku";
}
```

Or use a cheap classifier LLM. Don't bother until you've measured a tier
distribution that makes the savings worth the complexity.

## Prompt template

The prompt does most of the heavy lifting. Be explicit:

```ts
// src/generate/promptTemplate.ts
export function buildPrompt(question: string, chunks: RetrievedChunk[]) {
  const context = chunks
    .map((c, i) => {
      const t = c.metadata.startTime.toFixed(1);
      return `[${i + 1}] (${c.metadata.videoId} @ ${t}s)\n${c.pageContent}`;
    })
    .join("\n\n");

  return [
    {
      role: "system" as const,
      content: `You are a course assistant. Answer the user's question using ONLY
the transcript excerpts below. Each excerpt is numbered and tagged with its
video ID and timestamp.

Rules:
- Answer ONLY from the provided excerpts. Do not use outside knowledge.
- Cite every factual claim with the excerpt number, like [1] or [2].
- For each citation, also include the timestamp (e.g., "[1] at 0:47").
- If the excerpts don't fully answer the question, say so plainly. Don't guess.
- Keep answers concise. Don't restate the question.
- If the question is off-topic for the course, decline politely.`,
    },
    {
      role: "user" as const,
      content: `Excerpts:\n\n${context}\n\nQuestion: ${question}`,
    },
  ];
}
```

Why each line is there:
- "ONLY from the provided excerpts" — the anti-hallucination clause.
- Numbered citations + timestamps — turns into clickable UI.
- "If the excerpts don't fully answer" — explicit abstention permission.
- "Don't restate the question" — saves output tokens.
- Off-topic decline — protects against prompt-injection-ish queries.

## The generation call

```ts
// src/generate/answer.ts
import { ChatAnthropic } from "@langchain/anthropic";
import { buildPrompt } from "./promptTemplate.js";
import { retrieveWithRerank } from "../retrieve/retrieveWithRerank.js";

const llm = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  temperature: 0.1,        // low — we want grounded, not creative
  maxTokens: 600,
});

export async function answer(question: string, courseId: string) {
  const chunks = await retrieveWithRerank(question, { courseId, finalK: 5 });
  if (chunks.length === 0) {
    return {
      answer: "I don't have information on that in the course content.",
      citations: [],
    };
  }

  const messages = buildPrompt(question, chunks);
  const res = await llm.invoke(messages);
  const text = typeof res.content === "string" ? res.content : "";

  return {
    answer: text,
    citations: chunks.map((c, i) => ({
      n: i + 1,
      videoId: c.metadata.videoId,
      startTime: c.metadata.startTime,
      endTime: c.metadata.endTime,
      score: c.relevanceScore,
    })),
  };
}
```

## Streaming

User-facing UIs should stream tokens. Anthropic and OpenAI SDKs both support
streaming; LangChain exposes it via `.stream()`:

```ts
const stream = await llm.stream(messages);
for await (const chunk of stream) {
  process.stdout.write(chunk.content as string);
}
```

Wire that to a server-sent-events endpoint or a WebSocket. First-token
latency drops to ~500ms even for long answers, which is the user-perceived
metric that matters.

## Temperature and other knobs

- **`temperature: 0.1`** — low. RAG wants determinism, not creativity. Don't
  go to 0 (some models behave oddly); 0.1 is safe.
- **`maxTokens: 600`** — generous for our use case but not wasteful. Tune
  down if answers consistently come back shorter; tune up if they get cut off.
- **`top_p: 1`** (default). Don't touch unless you have a reason.

## Citations: rendering on the frontend

The model produces text like:

> useState returns an array with the current state and a setter function
> [1] at 0:47. Calling the setter with a new value triggers a re-render
> [2] at 1:12.

The `citations` array we returned alongside the answer carries the
`videoId` + `startTime` for each numbered marker. The frontend post-processes:

```tsx
// pseudo-React
function renderAnswer({ answer, citations }) {
  return answer.replace(/\[(\d+)\]/g, (_, n) => {
    const c = citations[Number(n) - 1];
    return `<a href="/watch/${c.videoId}?t=${c.startTime}">▶ ${formatTime(c.startTime)}</a>`;
  });
}
```

## Anti-hallucination — defense in depth

The system prompt is the first line of defense, not the only one.

1. **Prompt instruction** — "answer only from context."
2. **Low temperature** — reduces drift.
3. **Reranker abstention** — if no chunk clears `minScore`, return "I don't
   know" without calling the LLM at all.
4. **Citation requirement** — claims without citations are a smell.
5. **Offline groundedness eval** — judge LLM scores answers on a labeled set
   (see `07-evaluation.md`). Catches regressions on every PR.
6. **Optional online sample** — judge ~1% of production answers; alert on
   groundedness drops.

Don't rely on any single layer.

## Failure modes to watch

- **The model uses outside knowledge.** Tighten the system prompt; consider
  a different model (Claude is generally better at staying in context than
  GPT).
- **Citations point to the wrong chunk.** The model is hallucinating numbers.
  Check the rendered prompt — sometimes context is malformed (numbering off,
  chunks too long for context window). Validate that every `[n]` in the
  output corresponds to a real chunk index.
- **Answers are wrong but plausible.** Either retrieval missed the right
  chunk (raise `initialK` or check the reranker), or the right chunk was
  ambiguous (revisit chunking strategy).
- **Answers are too long / too short.** Adjust the system prompt and
  `maxTokens`.

## What an interviewer should hear

> Generation uses Claude Sonnet 4.6 with a system prompt that requires
> answers be drawn only from the retrieved excerpts and that every claim be
> cited with its excerpt number and timestamp. Temperature is 0.1 for
> determinism. We abstain explicitly when reranker scores fall below a
> threshold rather than forcing an answer. Groundedness is measured on
> every PR by an LLM-as-judge over a 50-question eval set, using a model
> from a different family than the generator.
