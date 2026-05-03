import "dotenv/config";
import { Pool } from "pg";
import { embeddings } from "../embeddings/index.js";

const query = process.argv[2] ?? "how do I get started";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const [vec] = await embeddings.embedDocuments([query]);

const { rows } = await pool.query(
  `SELECT id, content, metadata,
          1 - (embedding <=> $1::vector) AS similarity
   FROM transcript_chunks
   ORDER BY embedding <=> $1::vector
   LIMIT 5`,
  [JSON.stringify(vec)],
);

console.log(`Query: ${query}\n`);
for (const row of rows) {
  const sim = Number(row.similarity).toFixed(3);
  const preview = row.content.replace(/\s+/g, " ").slice(0, 120);
  console.log(`[${sim}] ${row.id}`);
  console.log(`  ${preview}...\n`);
}

await pool.end();
