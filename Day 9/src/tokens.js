export const DEFAULT_CONTEXT_WINDOW = 128000;

export const MODEL_CONTEXT_WINDOWS = {
  "composer-2.5": 200000,
  "gpt-5.4-nano": 128000,
  "gpt-5.4": 128000,
  "gpt-5.4-mini": 128000,
  "gpt-5.5": 128000,
};

export class ContextOverflowError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "ContextOverflowError";
    this.requestTokens = extra.requestTokens;
    this.limit = extra.limit;
  }
}

export function estimateTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

export function modelContextWindow(model) {
  const id = String(model ?? "").trim();
  return MODEL_CONTEXT_WINDOWS[id] ?? DEFAULT_CONTEXT_WINDOW;
}

export function parseContextLimit(raw, flag = "--limit") {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} должен быть целым числом >= 1`);
  }
  return n;
}

export function normalizeContextLimit(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function envContextLimit() {
  const raw = process.env.CURSOR_CONTEXT_LIMIT?.trim();
  if (!raw) return null;
  return normalizeContextLimit(raw);
}

export function contextLimit(model, override) {
  const custom = normalizeContextLimit(override);
  if (custom != null) return custom;
  return envContextLimit() ?? modelContextWindow(model);
}

export function contextLimitLabel(model, override) {
  if (normalizeContextLimit(override) != null) return "лимит агента";
  if (envContextLimit() != null) return "CURSOR_CONTEXT_LIMIT";
  return `окно модели ${model}`;
}

export function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
  };
}

export function addUsage(a, b) {
  const left = a ?? emptyUsage();
  const right = b ?? emptyUsage();
  return {
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
    cacheWriteTokens: (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0),
    totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0),
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
  };
}

export function fromSdkUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.inputTokens) || 0;
  const outputTokens = Number(usage.outputTokens) || 0;
  const cacheReadTokens = Number(usage.cacheReadTokens) || 0;
  const cacheWriteTokens = Number(usage.cacheWriteTokens) || 0;
  const reasoningTokens = Number(usage.reasoningTokens) || 0;
  const totalTokens =
    Number(usage.totalTokens) || inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    reasoningTokens,
  };
}

export function normalizeUsage(row) {
  const usage = fromSdkUsage(row);
  return usage ?? emptyUsage();
}

export function normalizeLastTurn(row) {
  if (!row || typeof row !== "object") return null;
  const requestEstimated = Number(row.requestEstimated);
  const responseEstimated = Number(row.responseEstimated);
  if (!Number.isFinite(requestEstimated) && !Number.isFinite(responseEstimated)) {
    return null;
  }
  return {
    requestEstimated: Number.isFinite(requestEstimated) ? requestEstimated : 0,
    requestBilled: Number.isFinite(Number(row.requestBilled))
      ? Number(row.requestBilled)
      : null,
    responseEstimated: Number.isFinite(responseEstimated) ? responseEstimated : 0,
    responseBilled: Number.isFinite(Number(row.responseBilled))
      ? Number(row.responseBilled)
      : null,
    billedReported: Boolean(row.billedReported),
  };
}

export function isContextOverflowMessage(message) {
  return /context (length|window|limit)|maximum context|too many tokens|token.?limit|prompt is too long|overflow/i.test(
    String(message ?? ""),
  );
}

export function occupancyPercent(used, limit) {
  if (!limit) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

function formatPair(estimated, billed) {
  if (billed == null) return `~${estimated}`;
  return `~${estimated} (billed ${billed})`;
}

export function formatAskTokenLine(report) {
  const last = report.last;
  const req = last
    ? formatPair(last.requestEstimated, last.requestBilled)
    : "~0";
  const res = last
    ? formatPair(last.responseEstimated, last.responseBilled)
    : "~0";
  const total = report.usage?.totalTokens ?? 0;
  return `токены: запрос ${req} | ответ ${res} | сумма ${total} | контекст ~${report.occupancy}/${report.contextLimit} (${report.percent}%)`;
}

function formatCost(cost) {
  if (!cost) return "";
  const charged = Number(cost.chargedCents);
  const raw = Number(cost.rawCostCents);
  const parts = [];
  if (Number.isFinite(raw)) parts.push(`raw=${raw.toFixed(4)}¢`);
  if (Number.isFinite(charged)) parts.push(`charged=${charged.toFixed(4)}¢`);
  return parts.length ? `  cost ${parts.join(" ")}` : "";
}

export function formatTokensCommand(report, sdkUsage) {
  const last = report.last;
  const lines = [
    `Агент ${report.name} (#${report.id})  model=${report.model}`,
    `История: ~${report.historyEstimated} токенов (${report.messageCount} сообщ.` +
      (report.compress && report.summarizedCount
        ? `, summary ${report.summarizedCount}, в запросе ${report.promptMessageCount}`
        : "") +
      `)`,
    `Сжатие: ${report.compress ? `вкл, каждые ${report.compressEvery} сообщ.` : "выкл"}`,
    `Контекст: ${report.occupancy} / ${report.contextLimit} (${report.percent}%)`,
    `Затрачено всего: in=${report.usage.inputTokens} out=${report.usage.outputTokens} total=${report.usage.totalTokens}`,
  ];
  if (report.usage.reasoningTokens) {
    lines.push(`Reasoning: ${report.usage.reasoningTokens}`);
  }
  if (last) {
    lines.push(`Последний запрос: ${formatPair(last.requestEstimated, last.requestBilled)}`);
    lines.push(`Последний ответ: ${formatPair(last.responseEstimated, last.responseBilled)}`);
  } else {
    lines.push("Последний ход: нет");
  }
  if (sdkUsage?.usage) {
    const u = sdkUsage.usage;
    lines.push(
      `SDK getUsage: in=${u.inputTokens} out=${u.outputTokens} total=${u.totalTokens}${formatCost(sdkUsage.cost)}`,
    );
  }
  return lines.join("\n");
}
