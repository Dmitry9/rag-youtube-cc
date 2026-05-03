import { Document } from "@langchain/core/documents";
import { Pool } from "pg";
import { getStore } from "./store.js";
import { chunkTranscript, type Transcript } from "./chunkTranscript.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function ingestVideo(transcript: Transcript) {
  await pool.query(
    `INSERT INTO videos (video_id, course_id) VALUES ($1, $2)
     ON CONFLICT (video_id) DO UPDATE SET course_id = EXCLUDED.course_id`,
    [transcript.videoId, transcript.courseId],
  );

  const store = await getStore();
  const chunks = chunkTranscript(transcript, { chunkTokens: 400, overlapTokens: 60 });

  const docs = chunks.map((c) => new Document({
    pageContent: c.pageContent,
    metadata: c.metadata,
  }));
  const ids = chunks.map((_, i) => `${transcript.videoId}::${i}`);

  // Re-ingest safety: wipe old chunks for this video first.
  // Better: wrap both in a transaction with a raw client.
  await store.delete({ filter: { videoId: transcript.videoId } });
  await store.addDocuments(docs, { ids });
}