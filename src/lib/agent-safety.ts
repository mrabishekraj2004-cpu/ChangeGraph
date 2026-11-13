const secretPatterns: Array<[RegExp, string]> = [
  [/\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [REDACTED]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|token)=)[^&#\s]+/gi, "$1[REDACTED]"],
  [/((?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]"],
  [/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[REDACTED]@"],
];

export function redactSensitiveText(value: string) {
  return secretPatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

const referenceKeys = new Set(["id", "ref", "evidenceref", "evidence_ref", "external_ref"]);
const importantKeys = new Set(["id", "ref", "evidenceref", "evidence_ref", "external_ref", "title", "summary", "service_name"]);

/** Redact and bound tool/incident data before it is stored or passed to a model. */
export function sanitizeEvidencePayload(value: unknown) {
  const budget = { remaining: 32_000 };

  const visit = (item: unknown, key: string, depth: number): unknown => {
    if (typeof item === "string") {
      const redacted = redactSensitiveText(item);
      const normalizedKey = key.toLowerCase();
      const isReference = referenceKeys.has(normalizedKey);
      const fieldLimit = isReference ? 300 : /content|message|summary|description|error|stack|log/i.test(key) ? 1_600 : 500;
      const available = isReference ? fieldLimit : Math.max(0, Math.min(fieldLimit, budget.remaining));
      if (available === 0 && redacted.length > 0) return "[omitted: evidence context limit]";
      const clipped = redacted.slice(0, available);
      if (!isReference) budget.remaining -= clipped.length;
      return redacted.length > available ? `${clipped}…[truncated]` : clipped;
    }
    if (item === null || typeof item === "number" || typeof item === "boolean") return item;
    if (depth >= 8) return "[omitted: nesting limit]";
    if (Array.isArray(item)) {
      const selected = item.slice(0, 20).map((child) => visit(child, key, depth + 1));
      if (item.length > selected.length) selected.push({ _truncatedItems: item.length - selected.length });
      return selected;
    }
    if (typeof item === "object") {
      const entries = Object.entries(item as Record<string, unknown>);
      entries.sort(([left], [right]) => Number(importantKeys.has(right.toLowerCase())) - Number(importantKeys.has(left.toLowerCase())));
      const selected = entries.slice(0, 64);
      const result: Record<string, unknown> = {};
      for (const [childKey, child] of selected) result[childKey] = visit(child, childKey, depth + 1);
      if (entries.length > selected.length) result._truncatedKeys = entries.length - selected.length;
      return result;
    }
    return null;
  };

  return visit(value, "", 0);
}
