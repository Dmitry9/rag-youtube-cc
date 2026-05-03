import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ingestVideo } from "./ingestVideo.js";
import type { Transcript } from "./chunkTranscript.js";

const TRANSCRIPTS_DIR = "data/transcripts";

const files = (await readdir(TRANSCRIPTS_DIR)).filter((f) => f.endsWith(".json"));

console.log(`Found ${files.length} transcript(s) in ${TRANSCRIPTS_DIR}`);

for (const file of files) {
  const transcript = JSON.parse(
    await readFile(join(TRANSCRIPTS_DIR, file), "utf8"),
  ) as Transcript;
  console.log(`  ingesting ${transcript.videoId} (${transcript.segments.length} segments)`);
  await ingestVideo(transcript);
}

console.log("Done.");
process.exit(0);
