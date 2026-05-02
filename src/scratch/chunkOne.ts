import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chunkTranscript } from '../ingest/chunkTranscript.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const transcript = JSON.parse(
  readFileSync(join(__dirname, '../../data/transcripts/LPZh9BOjkQs.json'), 'utf8')
);


const chunkTokens = Number(process.argv[2] ?? 400);
const chunks = chunkTranscript(transcript, { chunkTokens, overlapTokens: 60 });
console.log(chunks);

for (let i = 1; i < chunks.length; i++) {
  const prev = chunks[i - 1]!.pageContent;
  const curr = chunks[i]!.pageContent;
  // longest prefix of curr that is also a suffix of prev
  let n = Math.min(prev.length, curr.length);
  while (n > 0 && !prev.endsWith(curr.slice(0, n))) n--;
  console.log(`overlap[${i - 1}→${i}]: ${n} chars`);
}

// npx tsx src/scratch/chunkOne.ts 100  > probe-100.log
// npx tsx src/scratch/chunkOne.ts 400  > probe-400.log
// npx tsx src/scratch/chunkOne.ts 1500 > probe-1500.log