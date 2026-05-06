import "dotenv/config";
import { answer } from "./answer.js";

interface CliArgs {
  question: string | undefined;
  courseId: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let question: string | undefined;
  let courseId: string | undefined;
  for (const a of args) {
    if (a.startsWith("--course=")) courseId = a.slice("--course=".length);
    else if (!question) question = a;
  }
  return { question, courseId };
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

const { question, courseId } = parseArgs(process.argv);

if (!question) {
  console.error('Usage: npm run ask -- "your question" [--course=<id>]');
  process.exit(1);
}

const result = await answer(question, courseId);

console.log(`Q: ${question}`);
if (courseId) console.log(`Course: ${courseId}`);
console.log();
console.log(`A: ${result.answer}`);
console.log();

if (result.citations.length === 0) {
  console.log("(no citations — abstained)");
} else {
  console.log("Citations:");
  for (const c of result.citations) {
    const range = `[${formatTime(c.startTime)}–${formatTime(c.endTime)}]`;
    console.log(`  [${c.n}] ${c.videoId}  ${range}  score=${c.score.toFixed(3)}`);
  }
}

process.exit(0);
