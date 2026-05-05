import { CohereClientV2 } from "cohere-ai";
import { getStore } from "../ingest/store.js";
import type { ChunkMetadata } from "./vectorSearch.js";

const cohere = new CohereClientV2({ token: process.env.COHERE_API_KEY! });

export interface RetrieveOptions {
  courseId?: string;
  initialK?: number;   // candidates pulled from pgvector
  finalK?: number;     // chunks returned to caller
  minScore?: number;   // drop reranked candidates below this
}

export interface RerankHit {
  pageContent: string;
  metadata: ChunkMetadata;
  relevanceScore: number;
}

export async function retrieveWithRerank(query: string, {
  courseId,
  initialK = 20,
  finalK = 5,
  minScore = 0.2,
}: RetrieveOptions = {}): Promise<RerankHit[]> {
  const store = await getStore();

  // Stage 1: vector search
  const candidates = await store.similaritySearch(
    query,
    initialK,
    courseId ? { courseId } : undefined
  );

  if (candidates.length === 0) return [];

  // Stage 2: rerank
  const rerank = await cohere.rerank({
    model: "rerank-v3.5",
    query,
    documents: candidates.map(c => c.pageContent),
    topN: finalK,
  });

  // Stage 3: map indexes back to documents (with metadata intact).
  // r.index is an index into the documents array we just sent, so the lookup
  // is always defined — assertion is safe.
  return rerank.results
    .filter(r => r.relevanceScore >= minScore)
    .map(r => {
      const doc = candidates[r.index]!;
      return {
        pageContent: doc.pageContent,
        metadata: doc.metadata as ChunkMetadata,
        relevanceScore: r.relevanceScore,
      };
    });
}