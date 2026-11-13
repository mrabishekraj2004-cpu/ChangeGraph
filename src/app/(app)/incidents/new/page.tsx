import { requireUser } from "@/lib/auth";
import { listServices } from "@/lib/db";
import { NewIncidentForm } from "@/components/new-incident-form";

export default async function NewIncidentPage() {
  const user = await requireUser();
  const services = listServices(user.workspace.id);
  return <div className="content" style={{ maxWidth: 940 }}><div className="page-heading"><div><div className="eyebrow">New record</div><h1>Open an incident</h1><p>Start with the user impact and affected service. ChangeGraph will attach signals as they arrive.</p></div></div><NewIncidentForm services={services} /></div>;
}
