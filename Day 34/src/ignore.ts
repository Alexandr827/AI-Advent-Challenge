const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".baseline",
  ".turbo",
  "out",
]);

export function shouldSkip(relativePath: string): boolean {
  const parts = relativePath.split(/[/\\]/).filter(Boolean);
  for (const part of parts) {
    if (SKIP_DIRS.has(part) || part === ".DS_Store") {
      return true;
    }
  }
  const base = parts[parts.length - 1] ?? "";
  if (base === ".env") {
    return true;
  }
  if (base.startsWith(".env.") && base !== ".env.example") {
    return true;
  }
  return false;
}
