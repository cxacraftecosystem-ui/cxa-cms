import type { Role } from "@prisma/client";

/**
 * The permission ladder — the SINGLE source of comparison for "is this person allowed to".
 *
 * Mirrored from the Field Repository's `backend/app/core/deps.py` (skill §14.2). Two rules carried
 * over verbatim because both were bugs there first:
 *
 *   1. **A second hand-rolled rank test that disagrees with the first is how a rule silently stops
 *      matching.** Every comparison in this codebase goes through `roleRank` / `hasRank`. If you
 *      find yourself writing `role === "EDITOR" || role === "ADMINISTRATOR"`, you are writing the
 *      second test.
 *   2. **A failing check renders NOTHING, never a disabled control** (§7.5). An ungated button that
 *      lands on a refusal invites every tier to press it.
 *
 * Per-user grants (`canPublish`, `canManageMedia`) only ever WIDEN. They are OR-ed into the rank
 * test, so a demotion takes effect the moment the role column changes and a grant can never be used
 * to construct a narrower permission than the role already implies.
 */

export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 10,
  AUTHOR: 20,
  MEDIA_MANAGER: 30,
  RESEARCHER: 40,
  EDITOR: 50,
  ADMINISTRATOR: 60,
  MASTER_ADMIN: 70
};

export const ROLE_LABELS: Record<Role, string> = {
  VIEWER: "Viewer",
  AUTHOR: "Author",
  MEDIA_MANAGER: "Media manager",
  RESEARCHER: "Researcher",
  EDITOR: "Editor",
  ADMINISTRATOR: "Administrator",
  MASTER_ADMIN: "Master administrator"
};

/** One plain sentence per tier, shown beside the role picker so a choice is never a guess. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  VIEWER: "Can sign in and read everything in the CMS. Changes nothing.",
  AUTHOR: "Writes and edits their own drafts. Cannot publish.",
  MEDIA_MANAGER: "Everything an author can do, plus the full media library and file store.",
  RESEARCHER: "Manages research areas, projects and publications, and publishes their own work.",
  EDITOR: "Publishes anything and edits anyone's content across the whole site.",
  ADMINISTRATOR: "Everything, plus people, settings, navigation, the recycle bin and the audit log.",
  MASTER_ADMIN:
    "Decides who may sign in at all, and can see the full history of who changed what. The only role " +
    "that can add somebody to the studio's access list."
};

/** Order for pickers and tables: highest authority first, so the consequential choice reads first. */
export const ROLES_DESCENDING: Role[] = [
  "MASTER_ADMIN",
  "ADMINISTRATOR",
  "EDITOR",
  "RESEARCHER",
  "MEDIA_MANAGER",
  "AUTHOR",
  "VIEWER"
];

/** The minimum shape every predicate accepts. Keeps them usable against a session, not just a row. */
export interface PermissionSubject {
  id: string;
  role: Role;
  canPublish?: boolean | null;
  canManageMedia?: boolean | null;
}

/** Rank of a subject or a bare role string. An unknown role ranks LOWEST, never highest. */
export function roleRank(subject: PermissionSubject | Role | string | null | undefined): number {
  if (!subject) return 0;
  const role = typeof subject === "string" ? subject : subject.role;
  return ROLE_RANK[role as Role] ?? 0;
}

export function hasRank(subject: PermissionSubject | null | undefined, role: Role): boolean {
  return roleRank(subject) >= ROLE_RANK[role];
}

// ── Capability predicates ───────────────────────────────────────────────────
// Each answers exactly one question, and the UI and the API route BOTH call the same one. A client
// guard that only hides a control is not a guard (§13); the server predicate is the boundary.

export function canAccessStudio(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "VIEWER");
}

/** Draft content of one's own. The floor for any write at all. */
export function canAuthor(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "AUTHOR");
}

/** Publish, schedule, unpublish — for anything, anyone's. */
export function canPublish(subject: PermissionSubject | null | undefined): boolean {
  if (!subject) return false;
  return hasRank(subject, "EDITOR") || Boolean(subject.canPublish);
}

/**
 * Edit content someone else authored.
 *
 * RESEARCHER is deliberately NOT enough: a researcher owns the research tables (below) but must not
 * rewrite another author's news article. Widening this to RESEARCHER once made "my draft changed
 * overnight" a support ticket nobody could explain from the audit log alone.
 */
export function canEditOthersContent(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "EDITOR");
}

/** The media library and the file store. */
export function canManageMedia(subject: PermissionSubject | null | undefined): boolean {
  if (!subject) return false;
  return hasRank(subject, "MEDIA_MANAGER") || Boolean(subject.canManageMedia);
}

/** Research areas, projects, publications, crafts. */
export function canManageResearch(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "RESEARCHER");
}

/** People, events, the newsroom's taxonomy, the gallery. */
export function canManageContent(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "EDITOR");
}

/** Page structure, the homepage builder and navigation — anything that changes the site's shape. */
export function canManageStructure(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "EDITOR");
}

export function canManageSettings(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "ADMINISTRATOR");
}

export function canManageUsers(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "ADMINISTRATOR");
}

/** The top of the ladder. Kept as a named predicate so no call site compares the string itself. */
export function isMasterAdmin(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "MASTER_ADMIN");
}

/**
 * Who may add somebody to the studio access list, or take them off it.
 *
 * MASTER ADMIN ONLY, and deliberately NOT an administrator. An administrator runs the site; a master
 * admin decides who is allowed near it. Keeping the two apart means the account that is used every day —
 * and is therefore the one most likely to be phished — cannot widen the circle of people who can sign
 * in. It is the difference between "somebody defaced a page" and "somebody let themselves in".
 */
export function canManageStudioAccess(subject: PermissionSubject | null | undefined): boolean {
  return isMasterAdmin(subject);
}

/**
 * Who may open the provenance console — the full, cross-entity history of who changed what.
 *
 * Master admin only. The audit screen an administrator already has answers "what happened to this
 * page?"; the console answers "what has this PERSON done, everywhere, and from which addresses?", which
 * is a different and more sensitive question — it is a record of colleagues' activity, not of content.
 */
export function canViewProvenance(subject: PermissionSubject | null | undefined): boolean {
  return isMasterAdmin(subject);
}

export function canViewAuditLog(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "ADMINISTRATOR");
}

/**
 * Restore from the recycle bin, and permanently purge.
 *
 * **Deleting is stricter than editing** — carried over verbatim from §14.2. Restoring is an
 * administrator act because a restore can resurrect content an editor deliberately retired.
 */
export function canRestoreDeleted(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "ADMINISTRATOR");
}

export function canPurge(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "ADMINISTRATOR");
}

/** Contact inbox: triage is an editor job, because a reply speaks for the institution. */
export function canManageInquiries(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "EDITOR");
}

export function canViewAnalytics(subject: PermissionSubject | null | undefined): boolean {
  return hasRank(subject, "EDITOR");
}

/**
 * May `actor` edit a record `authorId` created?
 *
 * Own content always; anyone else's only with `canEditOthersContent`. An unowned record (author
 * deleted, or content imported without one) is treated as SOMEONE ELSE'S — the safe direction: it
 * requires an editor rather than falling open to whoever happens to be logged in.
 */
export function canEditRecord(
  actor: PermissionSubject | null | undefined,
  authorId: string | null | undefined
): boolean {
  if (!actor) return false;
  if (authorId && authorId === actor.id) return canAuthor(actor);
  return canEditOthersContent(actor);
}

/**
 * May `actor` assign `target` the role `nextRole`?
 *
 * Three rules, all mirroring the Field Repository's promotion ladder (§16):
 *   • only an administrator manages users at all;
 *   • you may assign a role AT OR BELOW your own tier — nobody promotes above themselves;
 *   • you may only manage a user ranked STRICTLY BELOW you, with one exception: yourself. Editing
 *     your own profile is not a privilege escalation, and blocking it strands the sole administrator
 *     of a fresh installation.
 *
 * The "strictly below" rule is what stops two administrators demoting each other in a loop.
 */
export function canAssignRole(
  actor: PermissionSubject | null | undefined,
  target: PermissionSubject,
  nextRole: Role
): boolean {
  if (!canManageUsers(actor) || !actor) return false;
  if (ROLE_RANK[nextRole] > roleRank(actor)) return false;
  if (target.id === actor.id) {
    // Self-demotion is allowed; self-promotion is not (the rank check above already refused it).
    return true;
  }
  return roleRank(target) < roleRank(actor);
}

/**
 * May `actor` deactivate or delete `target`?
 *
 * Never yourself: an administrator who deletes their own account while being the only one locks
 * everybody out of the CMS with no in-app way back.
 */
export function canManageUser(
  actor: PermissionSubject | null | undefined,
  target: PermissionSubject
): boolean {
  if (!canManageUsers(actor) || !actor) return false;
  if (target.id === actor.id) return false;
  return roleRank(target) < roleRank(actor);
}
