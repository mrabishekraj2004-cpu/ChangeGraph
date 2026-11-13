import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listEvaluations, seedIfNeeded } from "@/lib/db";
import { identityRepository } from "@/lib/identity-repository";
import { runEvaluation } from "@/lib/evaluations";
import { mutationGuard } from "@/lib/security";

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "evaluations:run", { limit: 6, windowMs: 60_000 });
  if (blocked) return blocked;
  seedIfNeeded();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  let body: { evaluationId?: string };
  try { body = await request.json() as { evaluationId?: string }; } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const evaluation = listEvaluations(user.workspace.id).find((item) => item.id === body.evaluationId);
  if (!evaluation) return NextResponse.json({ error: "Evaluation not found." }, { status: 404 });
  const result = runEvaluation(user.workspace.id, evaluation.id);
  if (!result) return NextResponse.json({ error: "Evaluation is not available in this workspace." }, { status: 404 });
  await identityRepository.recordAuditEvent({
    workspaceId: user.workspace.id,
    actorUserId: user.id,
    action: "evaluation.replayed",
    entityType: "evaluation_run",
    entityId: result.runId,
    metadata: { evaluationId: evaluation.id, passRate: result.passRate, metrics: result.metrics },
  });
  return NextResponse.json(result);
}
