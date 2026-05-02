import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encoding_for_model } from "tiktoken";
import { chunkTranscript } from "../ingest/chunkTranscript.js";
import { embeddings } from "../embeddings/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const videoId = process.argv[2] ?? "LPZh9BOjkQs";
const file = `../../data/transcripts/${videoId}.json`;
const transcript = JSON.parse(
  readFileSync(join(__dirname, file), "utf8"),
);

const chunks = chunkTranscript(transcript);
const texts = chunks.map((c) => c.pageContent);

const enc = encoding_for_model("text-embedding-3-small");
const tokens = texts
  .reduce((sum, t) => sum + enc.encode(t).length, 0);
enc.free();

console.log(`video:  ${videoId}`);
console.log(`chunks: ${chunks.length}`);
console.log(`tokens: ${tokens}`);

const t0 = Date.now();
const vecs = await embeddings.embedDocuments(texts);
const elapsedMs = Date.now() - t0;

console.log(vecs.slice(0, 5));
console.log(`embedded: ${vecs.length} vectors × ${vecs[0]!.length} dims`);
console.log(`elapsed:  ${elapsedMs} ms (one API round-trip for all ${chunks.length} chunks)`);

const cost = (tokens * 0.02) / 1_000_000;
console.log(`cost:     $${cost.toFixed(8)}  (= ${tokens} tokens × $0.02 / 1M)`);
