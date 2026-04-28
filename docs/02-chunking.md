# 02 — Chunking

How transcripts become retrieval units. This is where most RAG systems quietly
fail — and where the timestamp-preserving design earns its keep.

## What input we're working with

Transcription tools (Whisper, AssemblyAI, YouTube captions) return short timed
segments, not paragraphs:

```js
[
  { text: "welcome back to the channel",            start: 0.0,  duration: 2.8 },
  { text: "today we're talking about react hooks",   start: 2.8,  duration: 2.5 },
  { text: "specifically useState",                    start: 5.3,  duration: 1.4 },
  { text: "useState is a function",                   start: 6.7,  duration: 1.9 },
  { text: "that lets you add state to a component",   start: 8.6,  duration: 2.3 },
  // ...
]
```

Properties to know:
- Auto-generated captions usually lack punctuation and capitalization.
- Each segment is tiny — 3–8 words. Useless alone as a retrieval unit.
- Timing is per-segment. Lose this and you lose the deep-link feature.

## What a good chunk looks like

After processing:

```js
{
  pageContent:
    "useState is a function that lets you add state to a component you call " +
    "it with an initial value and it returns an array with two things the " +
    "current value and a setter function you use the setter to update the value",
  metadata: {
    videoId: "course-101-lesson-4",
    courseId: "course-101",
    startTime: 6.7,    // first segment's start
    endTime: 31.4,     // last segment's start + duration
    chunkIndex: 2
  }
}
```

One coherent block of ~400 tokens, with the merged timestamp window of every
segment that contributed.

## The chunking algorithm

```js
// src/ingest/chunkTranscript.ts
import { encoding_for_model } from "tiktoken";

const enc = encoding_for_model("text-embedding-3-small");
const tokenCount = (s: string) => enc.encode(s).length;

interface Segment { text: string; start: number; duration: number; }
interface Chunk {
  pageContent: string;
  metadata: { videoId: string; courseId: string; startTime: number; endTime: number; };
}

export function chunkTranscript(
  transcript: { videoId: string; courseId: string; segments: Segment[] },
  { chunkTokens = 400, overlapTokens = 60 } = {}
): Chunk[] {
  const { videoId, courseId, segments } = transcript;
  const chunks: Chunk[] = [];
  let buffer: Segment[] = [];
  let bufferTokens = 0;

  const flush = () => {
    if (!buffer.length) return;
    const last = buffer[buffer.length - 1];
    chunks.push({
      pageContent: buffer.map(s => s.text).join(" "),
      metadata: {
        videoId,
        courseId,
        startTime: buffer[0].start,
        endTime: last.start + last.duration,
      },
    });
  };

  for (const seg of segments) {
    const segTokens = tokenCount(seg.text);
    if (bufferTokens + segTokens > chunkTokens && buffer.length) {
      flush();
      // Carry tail segments as overlap so an idea split across the boundary
      // appears in both adjacent chunks.
      const overlap: Segment[] = [];
      let overlapSize = 0;
      for (let i = buffer.length - 1; i >= 0 && overlapSize < overlapTokens; i--) {
        overlap.unshift(buffer[i]);
        overlapSize += tokenCount(buffer[i].text);
      }
      buffer = overlap;
      bufferTokens = overlapSize;
    }
    buffer.push(seg);
    bufferTokens += segTokens;
  }
  flush();
  return chunks;
}
```

## Why segment-level chunking, not character-level

The LangChain default is `RecursiveCharacterTextSplitter` on a joined string.
Tempting because it's one line. Don't do it for transcripts.

Reasons:
- **Timestamps are gone.** Joining segments to a string drops the per-segment
  timing. Reconstructing it via character offsets is fragile and breaks on
  encoding edge cases.
- **Char counts ≠ token counts.** Same character budget produces wildly
  different token counts depending on language and speaking style. `tiktoken`
  is the right ruler.
- **Fixed-size windows cut mid-word.** Semantic merging at segment boundaries
  produces cleaner chunks.

Chunk at the segment level. Always.

## Sizing — the trade-off

Two failure modes you're navigating between:

**Too small (e.g. 100 tokens):**
- Embeddings are precise but ideas span multiple chunks.
- Top-5 retrieval misses pieces of the answer.
- More chunks → more storage, slower ingest.

**Too large (e.g. 1500 tokens):**
- Embeddings get diluted — vector represents the average of many topics.
- Chunks score medium for every query, high for none.
- Retrieved context wastes prompt tokens.

The goal: **one chunk ≈ one idea**, sized so retrieval is precise and ideas are
self-contained.

## Defaults by content type

| Content type | Target tokens | Overlap | Why |
|---|---|---|---|
| Course/lecture video | **400** | 60 | Ideas develop over ~1 minute |
| Conversational podcast | 500–700 | 80 | Ideas meander, more context needed |
| Tutorial w/ code demos | 300 | 50 | Steps are discrete; precision matters |
| Short-form (<3 min) | don't chunk | — | Embed whole transcript |
| News / interview | 400 | 60 | Q&A turnover roughly each minute |

Mental ruler: **400 tokens ≈ 60 seconds of speech** at 150 wpm. Useful for
sanity-checking.

## Overlap

Without overlap, ideas split across boundaries get lost:

```
Chunk A: "...you call useState with an initial value and it returns"
Chunk B: "an array with the current value and a setter..."
```

Query "what does useState return" matches neither well. With ~60-token overlap,
either chunk satisfies the query.

Rule: **overlap ≈ 10–20% of chunk size**. More is wasteful (re-embedding the
same text); less risks boundary problems.

## Don't pick the number — measure it

The 400-token default is a starting point, not a deliverable. Build the eval
harness in `07-evaluation.md`, sweep [200, 300, 400, 500, 700], pick the size
where recall@5 plateaus.

Typical results on video content:

```
chunk=200  recall@5=0.62  mrr=0.41
chunk=300  recall@5=0.74  mrr=0.52
chunk=400  recall@5=0.83  mrr=0.61   ← plateau starts
chunk=500  recall@5=0.84  mrr=0.60
chunk=700  recall@5=0.81  mrr=0.55   ← dilution
```

Pick the smallest size where recall plateaus. Going bigger doesn't help and
hurts on cost and precision.

## Smarter chunking, when defaults aren't enough

If fixed-size windows underperform, in order of effort:

1. **Semantic chunking.** Embed each sentence, walk forward merging while
   consecutive similarity stays high, start a new chunk on topic shift.
   Libraries: LlamaIndex `SemanticSplitterNodeParser`, LangChain
   `SemanticChunker`.
2. **Speaker/pause boundaries.** If diarization or pause markers exist, use
   them — natural topic boundaries.
3. **Parent-child chunking.** Embed *small* chunks (precise retrieval), return
   the *parent* (full context to LLM). LangChain `ParentDocumentRetriever`.
4. **LLM-summarized chunks.** Have a small LLM split a window into topical
   sections with one-line summaries; embed `[summary + section]` together.
   Expensive; helps on meandering content.

Don't reach for these until fixed-size + good overlap has been measured and
failed.

## Pitfalls that burn teams

1. **Chunking on character count, not tokens.** Variable density burns you.
2. **Joining segments first, then splitting.** Throws away timestamps.
3. **Re-ingesting without deleting old chunks.** Use stable IDs like
   `videoId::chunkIndex` so upserts overwrite. Or `DELETE WHERE videoId = ?`
   first, then insert — wrap both in a transaction.
4. **Different chunk size for new content than old.** Means your index is
   inconsistent. Re-ingest the whole corpus when changing chunk size.
