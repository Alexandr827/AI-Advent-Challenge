import { resolve } from "node:path";
import { requireConnection } from "../src/connection.js";
import { formatProjectIndex, indexProjectDocs } from "../src/rag/project.js";

const root = process.argv[2] ? resolve(process.argv[2]) : requireConnection();
const result = await indexProjectDocs(root);
console.log(formatProjectIndex(result));
