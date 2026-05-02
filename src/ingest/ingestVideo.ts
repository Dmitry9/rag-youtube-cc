import { Document } from "@langchain/core/documents";
import { getStore } from "./store.js";
import { chunkTranscript, type Transcript } from "./chunkTranscript.js";

export async function ingestVideo(transcript: Transcript) {
  const store = await getStore();
  const chunks = chunkTranscript(transcript, { chunkTokens: 400, overlapTokens: 60 });

  const docs = chunks.map((c, i) => new Document({
    pageContent: c.pageContent,
    metadata: { ...c.metadata, chunkIndex: i },
  }));
  const ids = chunks.map((_, i) => `${transcript.videoId}::${i}`);

  // Re-ingest safety: wipe old chunks for this video first.
  // Better: wrap both in a transaction with a raw client.
  await store.delete({ filter: { videoId: transcript.videoId } });
  await store.addDocuments(docs, { ids });
}