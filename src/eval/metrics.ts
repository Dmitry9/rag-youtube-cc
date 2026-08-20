import type { SearchHit } from "../retrieve/vectorSearch.js";

export interface GroundTruth {
  videoId: string;
  startTime: number;
  endTime: number;
}

export interface EvalQuestion {
  id: string;
  question: string;
  groundTruth: GroundTruth;
  referenceAnswer?: string;
}

// A retrieved chunk is a "hit" if its [startTime, endTime] window overlaps
// the ground-truth window for the same videoId (docs/07-evaluation.md).
export function isHit(chunk: SearchHit, gt: GroundTruth): boolean {
  if (chunk.metadata.videoId !== gt.videoId) return false;
  return (
    chunk.metadata.startTime <= gt.endTime &&
    chunk.metadata.endTime >= gt.startTime
  );
}
