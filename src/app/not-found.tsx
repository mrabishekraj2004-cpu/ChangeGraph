import Link from "next/link";
import { ArrowLeft, SearchX } from "lucide-react";

export default function NotFound() { return <div className="auth-screen"><div className="auth-card panel empty"><SearchX size={25} /><h3>That view does not exist</h3><p>The link may be stale or the record may belong to another workspace.</p><Link className="button primary small" href="/"><ArrowLeft /> Back to ChangeGraph</Link></div></div>; }
