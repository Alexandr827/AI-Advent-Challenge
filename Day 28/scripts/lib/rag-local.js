export function runFlags(run) {
  return {
    expectHit: Boolean(run?.expectHit),
    sourceHit: Boolean(run?.sourceHit),
    quotesOk: Boolean(run?.quotesOk),
  };
}

export function flagsMatch(left, right) {
  const a = runFlags(left);
  const b = runFlags(right);
  return a.expectHit === b.expectHit && a.sourceHit === b.sourceHit && a.quotesOk === b.quotesOk;
}

export function median(values) {
  const nums = (values ?? []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2) return nums[mid];
  return (nums[mid - 1] + nums[mid]) / 2;
}

function countLocal(questions) {
  const first = (questions ?? []).map((item) => item.runs?.[0]).filter(Boolean);
  return {
    questions: first.length,
    expect: first.filter((run) => run.expectHit).length,
    article: first.filter((run) => run.sourceHit).length,
    sources: first.filter((run) => run.sourcesOk).length,
    quotes: first.filter((run) => run.quotesOk).length,
    aligned: first.filter((run) => run.aligned).length,
    abstained: first.filter((run) => run.abstained).length,
  };
}

function countCloud(report) {
  const rows = report?.questions ?? [];
  if (!rows.length) return null;
  const filtered = rows.map((row) => row.filtered).filter(Boolean);
  return {
    model: report.model ?? null,
    runtime: report.runtime ?? null,
    questions: rows.length,
    sources: filtered.filter((run) => run.sourcesOk).length,
    quotes: filtered.filter((run) => run.quotesOk).length,
    aligned: filtered.filter((run) => run.aligned).length,
    abstained: filtered.filter((run) => run.abstained).length,
  };
}

export function summarizeLocalBenchmark(questions, cloudReport = null) {
  const list = questions ?? [];
  let stable = 0;
  const latencies = [];
  for (const item of list) {
    const runs = item.runs ?? [];
    if (runs.length >= 2 && !runs[0]?.error && !runs[1]?.error && flagsMatch(runs[0], runs[1])) {
      stable += 1;
    }
    for (const run of runs) {
      if (!run || run.error || run.abstained) continue;
      if (Number.isFinite(run.latencyMs)) latencies.push(run.latencyMs);
    }
  }
  return {
    questions: list.length,
    local: countLocal(list),
    cloud: cloudReport ? countCloud(cloudReport) : null,
    speed: {
      medianMs: median(latencies),
      maxMs: latencies.length ? Math.max(...latencies) : null,
      samples: latencies.length,
    },
    stability: {
      stable,
      questions: list.length,
    },
  };
}
