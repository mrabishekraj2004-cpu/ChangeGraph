import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth";
import { seedIfNeeded } from "@/lib/db";

export default async function ProtectedLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  seedIfNeeded();
  const user = await requireUser();
  return <AppShell user={user}>{children}</AppShell>;
}
