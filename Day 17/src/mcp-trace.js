export function emptyToolLog() {
  return { offered: [], calls: [], runId: null };
}

function blockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (block.text && typeof block.text === "object" && typeof block.text.text === "string") {
    return block.text.text;
  }
  return "";
}

export function extractToolText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);

  if (Array.isArray(result.content)) {
    return result.content.map(blockText).filter((part) => part.length > 0).join("\n");
  }

  if (result.value != null && result.value !== result) {
    const nested = extractToolText(result.value);
    if (nested) return nested;
  }
  if (typeof result.text === "string") return result.text;
  if (typeof result.output === "string") return result.output;
  return "";
}

function toolArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  if (typeof args.toolName === "string") {
    const inner = args.args;
    return inner && typeof inner === "object" && !Array.isArray(inner) ? inner : {};
  }
  return args;
}

export function normalizeToolEvent(event) {
  const args = event?.args && typeof event.args === "object" ? event.args : {};
  const tool =
    (typeof args.toolName === "string" && args.toolName) ||
    (typeof args.name === "string" && args.name) ||
    event?.name ||
    "";
  const result = event?.result;
  const isError = Boolean(
    event?.status === "error" ||
      result?.isError ||
      result?.value?.isError ||
      result?.status === "error",
  );
  return {
    callId: event?.call_id ?? null,
    name: event?.name ?? "",
    tool,
    arguments: toolArguments(args),
    status: event?.status ?? "",
    resultText: extractToolText(result),
    isError,
  };
}

export function toolMatches(call, name) {
  if (!call || !name) return false;
  return call.tool === name || call.name === name;
}

export function formatToolTrace(call) {
  const tool = call?.tool || call?.name || "tool";
  const status = call?.status || (call?.isError ? "error" : "completed");
  const text = String(call?.resultText ?? "").trim();
  const head = `MCP ${tool} ${status}`;
  return text ? `${head} → ${text}` : head;
}

export function foldRunEvent(state, event) {
  if (!state || !event || typeof event !== "object") return state;
  if (event.run_id) state.runId = event.run_id;
  if (event.type === "system" && Array.isArray(event.tools)) {
    state.offered = event.tools;
    return state;
  }
  if (event.type !== "tool_call") return state;

  const normalized = normalizeToolEvent(event);
  const index = state.calls.findIndex(
    (call) => call.callId && call.callId === normalized.callId,
  );
  if (index === -1) {
    state.calls.push(normalized);
    return state;
  }

  const previous = state.calls[index];
  state.calls[index] = {
    ...previous,
    ...normalized,
    arguments: Object.keys(normalized.arguments).length
      ? normalized.arguments
      : previous.arguments,
    resultText: normalized.resultText || previous.resultText,
  };
  return state;
}

export async function collectRunEvents(run) {
  const state = emptyToolLog();
  if (!run || typeof run.stream !== "function") return state;
  if (typeof run.supports === "function" && !run.supports("stream")) return state;
  if (run.id) state.runId = run.id;
  for await (const event of run.stream()) {
    foldRunEvent(state, event);
  }
  return state;
}
