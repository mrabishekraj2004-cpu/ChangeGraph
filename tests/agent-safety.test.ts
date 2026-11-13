import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText, sanitizeEvidencePayload } from "../src/lib/agent-safety";

test("redacts common credential forms from evidence text", () => {
  const raw = "Authorization: Bearer abcdefghijklmnop api_key=private-value https://user:password@example.com AKIAIOSFODNN7EXAMPLE";
  const safe = redactSensitiveText(raw);
  assert.doesNotMatch(safe, /abcdefghijklmnop|private-value|user:password|AKIAIOSFODNN7EXAMPLE/);
  assert.match(safe, /REDACTED/);
});

test("bounds tool evidence while preserving references and redacting nested strings", () => {
  const source = Array.from({ length: 24 }, (_, index) => ({
    evidenceRef: `trace:span-${index}`,
    message: `token=private-${index} ${"x".repeat(2_000)}`,
  }));
  const safe = sanitizeEvidencePayload(source) as Array<Record<string, unknown>>;
  assert.equal(safe.length, 21);
  assert.equal(safe[0].evidenceRef, "trace:span-0");
  assert.doesNotMatch(String(safe[0].message), /private-0/);
  assert.ok(String(safe[0].message).length < 1_700);
  assert.deepEqual(safe[20], { _truncatedItems: 4 });
});
