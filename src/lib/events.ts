import { z } from "zod";

const baseEvent = {
  schemaVersion: z.literal(1),
  eventId: z.string().min(1).max(200),
  source: z.string().min(1).max(80),
  externalId: z.string().min(1).max(300),
  idempotencyKey: z.string().min(1).max(300),
  workspaceId: z.string().min(1).max(120),
  occurredAt: z.string().min(1).max(80),
};

const sourceChangePayload = z.object({
  sha: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  author: z.string().min(1).max(200),
  repository: z.string().min(1).max(300),
  url: z.string().url().optional(),
  riskLabel: z.string().max(80).optional(),
  createdAt: z.string().max(80).optional(),
});

const deploymentPayload = z.object({
  serviceSlug: z.string().min(1).max(200),
  serviceName: z.string().min(1).max(200).optional(),
  version: z.string().min(1).max(300),
  environment: z.string().min(1).max(100),
  status: z.string().min(1).max(80),
  startedAt: z.string().min(1).max(80),
  completedAt: z.string().max(80).optional(),
  url: z.string().url().optional(),
  changeSha: z.string().max(200).optional(),
  changeTitle: z.string().max(500).optional(),
  repository: z.string().max(300).optional(),
  author: z.string().max(200).optional(),
});

const serviceMetadataPayload = z.object({
  slug: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  owner: z.string().min(1).max(200),
  status: z.string().max(80).optional(),
  healthScore: z.number().int().min(0).max(100).optional(),
  dependencies: z.array(z.string().min(1).max(200)).max(100).optional(),
});

const telemetryReferencePayload = z.object({
  signalKind: z.enum(["trace", "metric", "log"]),
  serviceName: z.string().min(1).max(200),
  externalRef: z.string().min(1).max(500),
  observedAt: z.string().min(1).max(80),
  summary: z.string().min(1).max(1000),
  sourceUrl: z.string().url().optional(),
  incidentId: z.string().max(120).optional(),
  payload: z.unknown().optional(),
});

export const changeEventSchema = z.object({
  ...baseEvent,
  eventType: z.literal("source.change.v1"),
  payload: sourceChangePayload,
});

export const deploymentEventSchema = z.object({
  ...baseEvent,
  eventType: z.literal("deployment.v1"),
  payload: deploymentPayload,
});

export const serviceMetadataEventSchema = z.object({
  ...baseEvent,
  eventType: z.literal("service.metadata.v1"),
  payload: serviceMetadataPayload,
});

export const telemetryReferenceEventSchema = z.object({
  ...baseEvent,
  eventType: z.literal("telemetry.reference.v1"),
  payload: telemetryReferencePayload,
});

export const changeGraphEventSchema = z.discriminatedUnion("eventType", [
  changeEventSchema,
  deploymentEventSchema,
  serviceMetadataEventSchema,
  telemetryReferenceEventSchema,
]);

export type ChangeGraphEvent = z.infer<typeof changeGraphEventSchema>;
export type EventType = ChangeGraphEvent["eventType"];
export type TelemetrySignalKind = z.infer<typeof telemetryReferencePayload>["signalKind"];

export function parseChangeGraphEvent(input: unknown) {
  return changeGraphEventSchema.safeParse(input);
}

export function eventTimestamp(value: string, fallback = new Date()) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}
