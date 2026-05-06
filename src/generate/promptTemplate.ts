import type { RerankHit } from "../retrieve/retrieveWithRerank.js";

export function buildPrompt(question: string, chunks: RerankHit[]) {
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