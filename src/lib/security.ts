import { NextResponse } from "next/server";
import { isIP } from "node:net";
import { db } from "./db";

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
};

let nextCleanupAt = 0;

function clientKey(request: Request) {
  const trustedProxyHops = Number(process.env.CHANGEGRAPH_TRUSTED_PROXY_HOPS || 0);
  if (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops < 1) return "untrusted-client";

  const forwarded = request.headers.get("x-forwarded-for")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (forwarded.length < trustedProxyHops) return "untrusted-client";

  // Proxies append the address they observed. Walk from the right by the configured
  // number of trusted hops so caller-supplied values to the left cannot pick a bucket.
  const candidate = forwarded[forwarded.length - trustedProxyHops];
  return candidate && isIP(candidate) ? candidate.toLowerCase() : "untrusted-client";
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const requestOrigin = new URL(request.url).origin;
    const configuredOrigin = process.env.APP_URL?.trim();
    return origin === requestOrigin || (!!configuredOrigin && origin === new URL(configuredOrigin).origin);
  } catch {
    return false;
  }
}

export function mutationGuard(request: Request, bucket: string, options: RateLimitOptions) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  const now = Date.now();
  const key = `${bucket}:${clientKey(request)}`;
  if (nextCleanupAt <= now) {
    db.prepare("DELETE FROM rate_limit_buckets WHERE reset_at <= ?").run(now);
    nextCleanupAt = now + 60_000;
  }

  const entry = db.prepare(
    `INSERT INTO rate_limit_buckets (bucket_key, count, reset_at, updated_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET
       count = CASE WHEN rate_limit_buckets.reset_at <= excluded.updated_at THEN 1 ELSE rate_limit_buckets.count + 1 END,
       reset_at = CASE WHEN rate_limit_buckets.reset_at <= excluded.updated_at THEN excluded.reset_at ELSE rate_limit_buckets.reset_at END,
       updated_at = excluded.updated_at
     RETURNING count, reset_at`,
  ).get(key, now + options.windowMs, now) as { count: number; reset_at: number };

  if (entry.count > options.limit) {
    return NextResponse.json(
      { error: "Too many requests. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((entry.reset_at - now) / 1000))) } },
    );
  }
  return null;
}

export const authRateLimit = { limit: 12, windowMs: 60_000 };
export const sensitiveAuthRateLimit = { limit: 6, windowMs: 60_000 };
export const mutationRateLimit = { limit: 60, windowMs: 60_000 };
