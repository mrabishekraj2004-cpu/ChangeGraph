import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { ingestEvent, processEvent } from "@/lib/event-processing";
import { getWorkspaceById, seedIfNeeded } from "@/lib/db";
import { markIntegrationStatus } from "@/lib/integrations";
import { mutationGuard } from "@/lib/security";

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value ? value : fallback;
}

function record(value: unknown) {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function eventIdFor(idempotencyKey: string) {
  return `evt_${crypto.createHash("sha256").update(`github:${idempotencyKey}`).digest("hex").slice(0, 20)}`;
}

function buildEvents(payload: Record<string, unknown>, eventName: string, delivery: string, workspaceId: string) {
  const repositoryData = record(payload.repository);
  const repository = stringValue(repositoryData.full_name, "unknown/repository");
  const repositoryUrl = stringValue(repositoryData.html_url);
  if (eventName === "push") {
    const commits = Array.isArray(payload.commits) && payload.commits.length ? payload.commits : payload.head_commit ? [payload.head_commit] : [];
    return commits.map((rawCommit) => {
      const commit = record(rawCommit);
      const commitAuthor = record(commit.author);
      const sender = record(payload.sender);
      const sha = stringValue(commit.id, stringValue(payload.after, delivery));
      const idempotencyKey = `push:${repository}:${sha}`;
      return {
        schemaVersion: 1 as const,
        eventId: eventIdFor(idempotencyKey),
        eventType: "source.change.v1" as const,
        source: "github",
        externalId: sha,
        idempotencyKey,
        workspaceId,
        occurredAt: stringValue(commit.timestamp, new Date().toISOString()),
        payload: {
          sha,
          title: stringValue(commit.message, "GitHub change").split("\n")[0].slice(0, 500),
          author: stringValue(commitAuthor.name, stringValue(sender.login, "Unknown")),
          repository,
          url: stringValue(commit.url) || (repositoryUrl ? `${repositoryUrl}/commit/${sha}` : undefined),
          createdAt: stringValue(commit.timestamp, new Date().toISOString()),
        },
      };
    });
  }
  if (eventName === "deployment" || eventName === "deployment_status") {
    const deployment = record(payload.deployment || payload);
    const deploymentStatus = record(payload.deployment_status);
    const deploymentPayload = record(deployment.payload);
    const sender = record(payload.sender);
    const status = eventName === "deployment_status" ? stringValue(deploymentStatus.state, "pending") : "started";
    const deploymentId = stringValue(deployment.id, delivery);
    const idempotencyKey = `deployment:${repository}:${deploymentId}:${status}`;
    const serviceSlug = stringValue(deploymentPayload.service_slug, stringValue(deploymentPayload.service, repository.split("/").pop() || "github-service"));
    return [{
      schemaVersion: 1 as const,
      eventId: eventIdFor(idempotencyKey),
      eventType: "deployment.v1" as const,
      source: "github",
      externalId: deploymentId,
      idempotencyKey,
      workspaceId,
      occurredAt: stringValue(deploymentStatus.created_at, stringValue(deployment.created_at, new Date().toISOString())),
      payload: {
        serviceSlug,
        serviceName: serviceSlug,
        version: stringValue(deployment.ref, stringValue(deployment.sha, deploymentId)),
        environment: stringValue(deployment.environment, "production"),
        status,
        startedAt: stringValue(deployment.created_at, new Date().toISOString()),
        completedAt: stringValue(deploymentStatus.updated_at) || undefined,
        url: stringValue(deploymentStatus.target_url, stringValue(deployment.url, repositoryUrl || undefined)),
        changeSha: stringValue(deployment.sha) || undefined,
        changeTitle: stringValue(deployment.description) || undefined,
        repository,
        author: stringValue(record(deployment.creator).login, stringValue(sender.login, "Unknown")),
      },
    }];
  }
  return [];
}

export async function POST(request: Request) {
  const blocked = mutationGuard(request, "github:webhook", { limit: 600, windowMs: 60_000 });
  if (blocked) return blocked;
  seedIfNeeded();
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "GitHub webhook secret is not configured." }, { status: 503 });
  const signature = request.headers.get("x-hub-signature-256");
  const raw = await request.text();
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
  if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  const configuredWorkspaceId = process.env.GITHUB_WORKSPACE_ID;
  const requestedWorkspaceId = request.headers.get("x-changegraph-workspace-id");
  if (!configuredWorkspaceId) return NextResponse.json({ error: "GITHUB_WORKSPACE_ID is not configured." }, { status: 503 });
  if (requestedWorkspaceId && requestedWorkspaceId !== configuredWorkspaceId) return NextResponse.json({ error: "GitHub workspace does not match the configured integration workspace." }, { status: 403 });
  const workspaceId = configuredWorkspaceId;
  if (!getWorkspaceById(workspaceId)) return NextResponse.json({ error: "Configured GitHub workspace was not found." }, { status: 404 });
  const eventName = request.headers.get("x-github-event") || "unknown";
  const delivery = request.headers.get("x-github-delivery") || crypto.randomUUID();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    markIntegrationStatus(workspaceId, "github", "misconfigured", "GitHub payload was not valid JSON.");
    return NextResponse.json({ error: "GitHub payload must be valid JSON." }, { status: 400 });
  }
  const events = buildEvents(payload, eventName, delivery, workspaceId);
  const results = events.map((event) => {
    const accepted = ingestEvent(event, { "x-github-event": eventName, "x-github-delivery": delivery });
    const processed = processEvent(accepted.eventId);
    return { ...accepted, processed };
  });
  if (results.length === 0) {
    markIntegrationStatus(workspaceId, "github", "pending");
  } else if (results.every((result) => result.processed.status === "processed")) {
    markIntegrationStatus(workspaceId, "github", "connected");
  } else if (results.some((result) => result.processed.status === "dead_letter")) {
    const failed = results.find((result) => result.processed.status === "dead_letter");
    const error = failed && "error" in failed.processed && typeof failed.processed.error === "string" ? failed.processed.error : "GitHub event moved to the dead-letter queue.";
    markIntegrationStatus(workspaceId, "github", "misconfigured", error);
  } else {
    markIntegrationStatus(workspaceId, "github", "pending");
  }
  return NextResponse.json({ accepted: true, event: eventName, delivery, normalized: results.length, results }, { status: 202 });
}
