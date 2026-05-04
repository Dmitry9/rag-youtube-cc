import { getStore } from "../ingest/store.js";

export interface ChunkMetadata {
  videoId: string;
  courseId: string;
  startTime: number;
  endTime: number;
  chunkIndex: number;
}

export interface SearchHit {
  pageContent: string;
  metadata: ChunkMetadata;
  similarity: number;
}

export interface SearchOptions {
  courseId?: string;
}

export async function similaritySearch(
  query: string,
  k: number = 5,
  { courseId }: SearchOptions = {},
): Promise<SearchHit[]> {
  const store = await getStore();
  const filter = courseId ? { courseId } : undefined;

  const results = await store.similaritySearchWithScore(query, k, filter);

  return results.map(([doc, distance]) => ({
    pageContent: doc.pageContent,
    metadata: doc.metadata as ChunkMetadata,
    similarity: 1 - distance,
  }));
}
