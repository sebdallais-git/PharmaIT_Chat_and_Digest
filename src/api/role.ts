// The user's role over HTTP, for Hermes (Telegram). The web chat reaches the
// same conversation through /api/chat.
//
//   GET  /api/role           the active role, every saved role, whether an onboarding is open
//   POST /api/role/message   {message} -> {reply}: one turn of the role conversation

import { Router } from "express";
import type { Request, Response } from "express";
import { activeRole, openRoleStore, type Role, type RoleState } from "../services/role-store.js";
import { defaultExtract, handleRoleMessage, type RoleDeps } from "../services/role-dialogue.js";

const router = Router();

export interface RoleStatus {
  active: Role | null;
  roles: Role[];
  onboarding: boolean;
}

export function roleStatus(state: RoleState): RoleStatus {
  return { active: activeRole(state), roles: state.roles, onboarding: state.draft !== null };
}

const NOT_A_ROLE_MESSAGE =
  'That did not read as a change to your role. Tell me who you are (e.g. "I am the Dell GAM for Roche, Novartis and Sandoz"), ' +
  'switch to a saved role ("switch to my Everpure role"), or change one ("add Lonza to my accounts").';

// Hermes only calls this when the user is talking about their role, so unlike
// the web chat there is no keyword pre-check, and "not a role message" gets a
// hint instead of falling through to a normal answer.
export async function roleMessageReply(message: unknown, deps: RoleDeps): Promise<{ status: number; body: object }> {
  if (typeof message !== "string" || message.trim() === "") {
    return { status: 400, body: { error: "The 'message' field is required" } };
  }
  const reply = await handleRoleMessage(message, deps);
  return { status: 200, body: { reply: reply ?? NOT_A_ROLE_MESSAGE } };
}

router.get("/", (_req: Request, res: Response): void => {
  res.json(roleStatus(openRoleStore().read()));
});

router.post("/message", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as { message?: unknown } | undefined;
  const { status, body: payload } = await roleMessageReply(body?.message, {
    store: openRoleStore(),
    extract: defaultExtract,
    now: () => new Date(),
  });
  res.status(status).json(payload);
});

export default router;
