import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIndexLoadArgs } from "../src/cli.js";
import { formatIndexRun, indexCorpus, indexLaw } from "../src/doc-index/pipeline.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args[0] === "load") {
  const loaded = parseIndexLoadArgs(args.slice(1));
  const result = await indexCorpus(root, loaded.paths, {
    source: loaded.source,
    title: loaded.title,
    strategy: loaded.strategy,
  });
  console.log(formatIndexRun(result));
} else if (args.length === 0) {
  const result = indexLaw(root);
  const { fixed, structural } = result.report.strategies;
  console.log(`Индекс: ${result.dbPath}`);
  console.log(`Сравнение: ${result.comparisonPath}`);
  console.log(
    `fixed: ${fixed.count} чанков, avg ${fixed.avg}, с границы ${Math.round(fixed.boundaryRate * 100)}%`,
  );
  console.log(
    `structural: ${structural.count} чанков, avg ${structural.avg}, с границы ${Math.round(structural.boundaryRate * 100)}%`,
  );
} else {
  console.error(
    "Использование: npm run index:docs -- load <файл> [--source S] [--title T] [--strategy fixed|structural|both]",
  );
  process.exit(1);
}
