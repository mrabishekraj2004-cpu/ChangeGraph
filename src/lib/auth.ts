import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { identityRepository } from "./identity-repository";

const SESSION_COOKIE = "changegraph_session";
function getSecret() {
  const configured = process.env.AUTH_SECRET;
  if (!configured) throw new Error("AUTH_SECRET must be configured before using authentication.");
  return new TextEncoder().encode(configured);
}

async function signSession(sessionId: string, expiresAt: string) {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(new Date(expiresAt))
    .sign(getSecret());
}

async function readSessionId() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const verified = await jwtVerify<{ sid: string }>(token, getSecret());
    return verified.payload.sid;
  } catch {
    return null;
  }
}

export async function startSession(userId: string, workspaceId: string) {
  const session = await identityRepository.createSession(userId, workspaceId);
  const token = await signSession(session.id, session.expiresAt);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(session.expiresAt),
  });
}

export async function endSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      const verified = await jwtVerify<{ sid: string }>(token, getSecret());
      await identityRepository.removeSession(verified.payload.sid);
    } catch {
      // Expired or malformed cookies are safe to discard.
    }
  }
  store.delete(SESSION_COOKIE);
}

export async function getCurrentUser() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const verified = await jwtVerify<{ sid: string }>(token, getSecret());
    const session = await identityRepository.findSession(verified.payload.sid);
    if (!session || new Date(session.expires_at).getTime() < Date.now()) return null;
    return {
      id: session.user_id,
      email: session.email,
      name: session.name,
      verifiedAt: session.verified_at,
      role: session.role,
      workspace: {
        id: session.workspace_id,
        name: session.workspace_name,
        slug: session.workspace_slug,
        mode: session.workspace_mode,
      },
      workspaces: await identityRepository.getUserWorkspaces(session.user_id),
    };
  } catch {
    return null;
  }
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function switchCurrentWorkspace(workspaceId: string) {
  const sessionId = await readSessionId();
  if (!sessionId) return false;
  const session = await identityRepository.findSession(sessionId);
  if (!session) return false;
  return identityRepository.switchSessionWorkspace(sessionId, session.user_id, workspaceId);
}
