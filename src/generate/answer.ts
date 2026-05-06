import { ChatOpenAI } from "@langchain/openai";
import { buildPrompt } from "./promptTemplate.js";
import { retrieveWithRerank } from "../retrieve/retrieveWithRerank.js";

const llm = new ChatOpenAI({
  model: "gpt-4o-mini",
  temperature: 0.1,  // low — we want grounded, not creative
  maxTokens: 600,
});

export async function answer(question: string, courseId?: string) {
  const chunks = await retrieveWithRerank(question, {
    ...(courseId ? { courseId } : {}),
    finalK: 5,
  });
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