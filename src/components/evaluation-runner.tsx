"use client";

import { useState } from "react";
import { CheckCircle2, LoaderCircle, Play, TriangleAlert } from "lucide-react";

export function EvaluationRunner({ evaluationId, initialRate }: { evaluationId: string; initialRate: number | null }) {
  const [rate, setRate] = useState<number | null>(initialRate);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function run() {
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch("/api/evaluations/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ evaluationId }) });
      const data = await response.json() as { passRate?: number; cases?: unknown[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Replay failed; no benchmark result was recorded.");
      setRate(data.passRate ?? null);
      setMessage(`${data.cases?.length ?? 0} seeded cases replayed; metrics are recorded from this run.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Replay failed; no benchmark result was recorded.");
    } finally {
      setBusy(false);
    }
  }
  return <div style={{ display: "flex", alignItems: "center", gap: 12 }}><div><div className="metric-big-value" style={{ fontSize: 30 }}>{rate === null ? "—" : `${Math.round(rate * 100)}%`}</div><div className="muted" style={{ fontSize: 10 }}>{rate === null ? "not run yet" : "current pass rate"}</div></div><div><button type="button" className="button primary small" onClick={run} disabled={busy}>{busy ? <><LoaderCircle className="spin" aria-hidden="true" /> Running…</> : <><Play aria-hidden="true" /> Replay suite</>}</button>{message && <div style={{ color: "var(--green)", fontSize: 10, marginTop: 7 }} role="status"><CheckCircle2 size={11} style={{ verticalAlign: "-2px" }} aria-hidden="true" /> {message}</div>}{error && <div className="form-help error-text" style={{ marginTop: 7 }} role="alert"><TriangleAlert size={11} style={{ verticalAlign: "-2px" }} aria-hidden="true" /> {error}</div>}</div></div>;
}
