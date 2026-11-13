"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function AuthError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <div className="auth-screen"><div className="auth-card panel empty"><AlertTriangle size={24} /><h3>Authentication view unavailable</h3><p>Try loading this page again.</p><button className="button primary small" onClick={() => reset()}><RotateCcw /> Try again</button></div></div>;
}
