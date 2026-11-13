"use client";

import Link from "next/link";
import { Activity, CheckCircle2, LoaderCircle, Play, TriangleAlert } from "lucide-react";
import { useState } from "react";

type DetectionResult = { baselines: number; anomalies: number; createdIncidentIds: string[]; hypotheses: number };

export function DetectionRunner() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/detection/run", { method: "POST" });
      const data = await response.json() as DetectionResult & { error?: string };
      if (!response.ok) throw new Error(data.error || "Detection could not be completed.");
      setResult(data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Detection could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel detection-panel" aria-labelledby="detection-title">
    <div className="panel-header">
      <div><div className="eyebrow">Deterministic health pass</div><h2 id="detection-title">Check the service graph</h2><p>Recompute baselines, flag meaningful changes, and rank evidence-linked cause candidates.</p></div>
      <Activity size={18} color="var(--cyan)" aria-hidden="true" />
    </div>
    <div className="panel-body">
      <button type="button" className="button primary" onClick={run} disabled={busy}>
        {busy ? <><LoaderCircle className="spin" /> Checking…</> : <><Play /> Run health detection</>}
      </button>
      {error && <div className="notice error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
      {result && <div className="detection-result" role="status">
        <CheckCircle2 size={15} color="var(--green)" aria-hidden="true" />
        <span>{result.baselines} baselines · {result.anomalies} anomalies · {result.hypotheses} ranked hypotheses</span>
        {result.createdIncidentIds.length > 0 && <Link href="/incidents" className="panel-link"><TriangleAlert size={12} /> {result.createdIncidentIds.length} incident{result.createdIncidentIds.length === 1 ? "" : "s"} opened</Link>}
      </div>}
    </div>
  </section>;
}
