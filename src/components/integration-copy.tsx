"use client";

import { Check, Copy } from "lucide-react";
import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";

export function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    setError("");
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setError("Clipboard access is unavailable. Select and copy the value manually.");
    }
  }
  return <span className="copy-control"><button type="button" className="button small" onClick={copy} aria-label={`Copy ${value}`}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? "Copied" : "Copy"}</button>{error && <span className="form-help" role="status">{error}</span>}</span>;
}

export function RefreshStatusButton() {
  const router = useRouter();
  const [busy, startRefresh] = useTransition();
  function refresh() {
    startRefresh(() => router.refresh());
  }
  return <button type="button" className="button small" onClick={refresh} disabled={busy} aria-busy={busy}>{busy ? <RefreshCw className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />} {busy ? "Refreshing…" : "Refresh status"}</button>;
}
