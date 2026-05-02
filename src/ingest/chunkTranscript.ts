import { encoding_for_model } from "tiktoken";

const enc = encoding_for_model("text-embedding-3-small");
const tokenCount = (s: string) => enc.encode(s).length;

export interface Segment { text: string; start: number; duration: number; }
export interface Transcript { videoId: string; courseId: string; segments: Segment[]; }
interface Chunk {
  pageContent: string;
  metadata: { videoId: string; courseId: string; startTime: number; endTime: number; chunkIndex: number; };
}

export function chunkTranscript(
  transcript: Transcript,
  { chunkTokens = 400, overlapTokens = 60 } = {}
): Chunk[] {
  const { videoId, courseId, segments } = transcript;
  const chunks: Chunk[] = [];
  let buffer: Segment[] = [];
  let bufferTokens = 0;

  const flush = () => {
    const first = buffer[0];
    const last = buffer.at(-1);
    if (!first || !last) return;
    chunks.push({
      pageContent: buffer.map(s => s.text).join(" "),
      metadata: {
        videoId,
        courseId,
        startTime: first.start,
        endTime: last.start + last.duration,
        chunkIndex: chunks.length,
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
        const tail = buffer[i]!;
        overlap.unshift(tail);
        overlapSize += tokenCount(tail.text);
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