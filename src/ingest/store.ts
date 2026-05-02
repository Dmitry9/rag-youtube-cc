import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { embeddings } from "../embeddings/index.js";

export async function getStore() {
  return PGVectorStore.initialize(embeddings, {
    postgresConnectionOptions: {
      connectionString: process.env.DATABASE_URL!,
    },
    tableName: "transcript_chunks",
    columns: {
      idColumnName: "id",
      vectorColumnName: "embedding",
      contentColumnName: "content",
      metadataColumnName: "metadata",
    },
    distanceStrategy: "cosine",
  });
}