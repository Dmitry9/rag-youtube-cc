import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { YoutubeTranscript } from "youtube-transcript";

const COURSE_ID = "3b1b-llm";

const VIDEOS = [
  { videoId: "LPZh9BOjkQs", title: "Large Language Models explained briefly" },
  { videoId: "wjZofJX0v4M", title: "Transformers, the tech behind LLMs (Ch. 5)" },
  { videoId: "eMlx5fFNoYc", title: "Attention in transformers, step-by-step (Ch. 6)" },
  { videoId: "9-Jl0dxWQs8", title: "How might LLMs store facts (Ch. 7)" },
];

const OUT_DIR = path.resolve("data/transcripts");

interface RawSegment { text: string; offset: number; duration: number; lang?: string; }
interface Segment { text: string; start: number; duration: number; }

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  for (const { videoId, title } of VIDEOS) {
    const raw = (await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" })) as RawSegment[];

    const segments: Segment[] = raw.map((s) => ({
      text: s.text,
      start: s.offset / 1000,
      duration: s.duration / 1000,
    }));

    const out = { videoId, courseId: COURSE_ID, segments };
    const file = path.join(OUT_DIR, `${videoId}.json`);
    await writeFile(file, JSON.stringify(out, null, 2));

    const last = segments[segments.length - 1]!;
    const minutes = ((last.start + last.duration) / 60).toFixed(1);
    console.log(`${videoId} (${title}): ${segments.length} segments, ≈ ${minutes} min`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
