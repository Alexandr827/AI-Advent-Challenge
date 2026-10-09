export function compareStrategies(chunks, { chars = 0 } = {}) {
  const groups = {
    fixed: chunks.filter((chunk) => chunk.strategy === "fixed"),
    structural: chunks.filter((chunk) => chunk.strategy === "structural"),
  };
  return {
    documents: new Set(chunks.map((chunk) => chunk.file)).size,
    chars,
    strategies: {
      fixed: summarize(groups.fixed),
      structural: summarize(groups.structural),
    },
  };
}

export function formatComparison(report) {
  const lines = [
    "# Сравнение стратегий чанкинга",
    "",
    `Документов: ${report.documents}. Символов в корпусе: ${report.chars}.`,
    "",
    "| Стратегия | Чанков | min | median | avg | max | С секцией | С границы раздела |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const name of ["fixed", "structural"]) {
    const row = report.strategies[name];
    lines.push(
      `| ${name} | ${row.count} | ${row.min} | ${row.median} | ${row.avg} | ${row.max} | ${pct(row.sectionRate)} | ${pct(row.boundaryRate)} |`,
    );
  }
  lines.push(
    "",
    "fixed держит длину окна. structural начинает чанк с заголовка, раздела или файла и сохраняет имя секции при дорезке.",
    "",
  );
  return lines.join("\n");
}

function summarize(chunks) {
  const lengths = chunks.map((chunk) => chunk.text.length).sort((a, b) => a - b);
  const count = lengths.length;
  const sum = lengths.reduce((total, length) => total + length, 0);
  return {
    count,
    min: count ? lengths[0] : 0,
    median: count ? lengths[Math.floor((count - 1) / 2)] : 0,
    avg: count ? Math.round(sum / count) : 0,
    max: count ? lengths[count - 1] : 0,
    sectionRate: count
      ? chunks.filter((chunk) => String(chunk.section ?? "").trim()).length / count
      : 0,
    boundaryRate: count ? chunks.filter((chunk) => chunk.boundary).length / count : 0,
  };
}

function pct(rate) {
  return `${Math.round(rate * 100)}%`;
}
