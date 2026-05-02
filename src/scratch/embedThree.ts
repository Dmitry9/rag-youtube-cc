import "dotenv/config";
import { embeddings } from "../embeddings/index.js";

function dot(a: number[], b: number[]): number {
  // sum a[i] * b[i] for all i
  return a.reduce(
    (sum, ai, i) => (ai * b[i]!) + sum,
    0
  );
}

function magnitude(v: number[]): number {
  // sqrt of sum of v[i]^2
  return Math.sqrt(
    v.reduce((sum, vi) => (vi * vi) + sum, 0)
  );
}

function cosine(a: number[], b: number[]): number {
  // dot(a, b) divided by (magnitude(a) * magnitude(b))
  return dot(a, b) / (magnitude(a) * magnitude(b));
}

const words = ["dog", "puppy", "car"];
const vecs = await embeddings.embedDocuments(words);

const [dog, puppy, car] = vecs;

console.log("cosine(dog, puppy) =", cosine(dog!, puppy!));
console.log("cosine(dog, car)   =", cosine(dog!, car!));

// // bonus: confirm OpenAI vectors are unit-length
console.log("||dog|| =", magnitude(dog!));

//   `dot` and `magnitude` aren't transposed. (Answers: `1` and `0` respectively.)
console.log(cosine([1, 0, 0], [1, 0, 0]));
console.log(cosine([1, 0], [0, 1]));
