import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const REPO_ROOT = root;
export const FIXTURES_DIR = path.join(root, "fixtures");
export const WORKSPACE_DIR = path.join(root, "workspace");
export const BASELINE_DIR = path.join(root, ".baseline");
export const SOURCE_FILE = path.join(root, ".source.json");
