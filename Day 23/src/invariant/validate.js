export const MAX_INVARIANT_RETRIES = 1;

export function validateResponse(response, invariants = []) {
  const items = Array.isArray(invariants) ? invariants : invariants?.items ?? [];
  const violations = items
    .filter((item) => typeof item.check === "function" && !item.check(response))
    .map((item) => ({
      id: item.id,
      type: item.type,
      description: item.description,
    }));
  if (!violations.length) {
    return { ok: true, status: "pass", response, violations: [] };
  }
  return { ok: false, status: "fail", response, violations };
}

export function formatRefusal(violations) {
  const list = Array.isArray(violations) ? violations : [];
  if (!list.length) {
    return "Нарушение инварианта. Предложенное решение отклонено.";
  }
  return list
    .map((item) => {
      const label = item.description ?? item;
      if (item.kind === "stage") {
        const state = item.state ? String(item.state).toUpperCase() : "задачи";
        return `Нарушение этапа ${state}. ${label}. Такое решение предлагать нельзя. Вернитесь к допустимому переходу.`;
      }
      return `Нарушение инварианта ${label}. Такое решение предлагать нельзя. Если запрос требует нарушения — откажитесь и предложите совместимый вариант.`;
    })
    .join("\n");
}

function violationKind(item) {
  return item?.kind === "stage" ? "stage" : "invariant";
}

export async function runInvariantPipeline({
  invariants = [],
  extraValidate,
  generate,
  buildPrompt,
  query,
  maxRetries = MAX_INVARIANT_RETRIES,
}) {
  if (typeof generate !== "function") {
    throw new Error("Invariant pipeline: нужен generate()");
  }
  if (typeof buildPrompt !== "function") {
    throw new Error("Invariant pipeline: нужен buildPrompt()");
  }
  const items = Array.isArray(invariants) ? invariants : invariants?.items ?? [];
  let violations = [];
  let attempts = 0;
  let response = "";
  const retryKinds = new Set();
  const limit = Math.max(0, Number(maxRetries) || 0);

  while (attempts <= limit) {
    const prompt = buildPrompt({ query, violations, attempt: attempts });
    response = String((await generate(prompt)) ?? "");
    attempts += 1;
    const result = validateResponse(response, items);
    const extra =
      typeof extraValidate === "function"
        ? extraValidate(response)
        : { ok: true, violations: [] };
    const extraViolations = Array.isArray(extra?.violations)
      ? extra.violations
      : [];
    const combined = [...result.violations, ...extraViolations];
    if (result.ok && extra?.ok !== false && !extraViolations.length) {
      return {
        ok: true,
        status: "pass",
        response,
        attempts,
        refused: false,
        violations: [],
        retryKinds: [...retryKinds],
      };
    }
    violations = combined;
    for (const item of combined) retryKinds.add(violationKind(item));
    if (attempts > limit) break;
  }

  return {
    ok: false,
    status: "fail",
    response: formatRefusal(violations),
    attempts,
    refused: true,
    violations,
    retryKinds: [...retryKinds],
  };
}
