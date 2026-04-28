import "dotenv/config";
import { Client } from "pg";

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query("SELECT '[1,2,3]'::vector AS v");
  console.log("vector type works:", rows[0].v);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
