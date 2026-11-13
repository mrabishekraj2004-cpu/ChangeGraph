"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <div className="content"><div className="panel empty"><AlertTriangle size={25} /><h3>Workspace view unavailable</h3><p>ChangeGraph could not load this view. Your session is still safe; try again or return to the overview.</p><button className="button primary small" onClick={() => reset()}><RotateCcw /> Try again</button></div></div>;
}
