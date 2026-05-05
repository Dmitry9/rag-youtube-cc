import "dotenv/config";
import { similaritySearch } from "./vectorSearch.js";
import { retrieveWithRerank } from "./retrieveWithRerank.js";

interface CliArgs {
  query: string | undefined;
  courseId: string | undefined;
  k: number;
  rerank: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let query: string | undefined;
  let courseId: string | undefined;
  let k = 5;
  let rerank = false;
  for (const a of args) {
    if (a.startsWith("--course=")) courseId = a.slice("--course=".length);
    else if (a.startsWith("--k=")) k = Number(a.slice("--k=".length));
    else if (a === "--rerank") rerank = true;
    else if (!query) query = a;
  }
  return { query, courseId, k, rerank };
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

const { query, courseId, k, rerank } = parseArgs(process.argv);

if (!query) {
  console.error('Usage: npm run search -- "your question" [--course=<id>] [--k=5] [--rerank]');
  process.exit(1);
}

const label = rerank ? "rerank" : "sim";

const hits = rerank
  ? (await retrieveWithRerank(query, { ...(courseId ? { courseId } : {}), finalK: k })).map(h => ({
      pageContent: h.pageContent,
      metadata: h.metadata,
      score: h.relevanceScore,
    }))
  : (await similaritySearch(query, k, courseId ? { courseId } : {})).map(h => ({
      pageContent: h.pageContent,
      metadata: h.metadata,
      score: h.similarity,
    }));

console.log(`Query: ${query}`);
if (courseId) console.log(`Course: ${courseId}`);
console.log(`Mode: ${rerank ? "vector→rerank (top-20 → top-" + k + ")" : "vector only"}`);
console.log(`Returned: ${hits.length}\n`);

if (hits.length === 0) {
  console.log("No results.");
  process.exit(0);
}

for (const [i, hit] of hits.entries()) {
  const score = hit.score.toFixed(3);
  const { videoId, startTime, endTime } = hit.metadata;
  const preview = hit.pageContent.replace(/\s+/g, " ").slice(0, 160);
  console.log(`#${i + 1}  ${label}=${score}  ${videoId}  [${formatTime(startTime)}–${formatTime(endTime)}]`);
  console.log(`   ${preview}…\n`);
}

process.exit(0);
