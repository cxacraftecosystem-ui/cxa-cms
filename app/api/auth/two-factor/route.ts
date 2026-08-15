import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  assertSameOrigin,
  badRequest,
  clientIp,
  conflict,
  forbidden,
  ok,
  parseJson,
  route,
  userAgent
} from "@/lib/api";
import { siteName } from "@/lib/env";
import { requireUser } from "@/lib/auth/current-user";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { canonicalRecoveryCode, encryptSecret, generateRecoveryCodes, generateTotpSecret, totpUri, verifyTotp } from "@/lib/auth/totp";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";

/**
 * Enrol in, or withdraw from, two-step verification. Three actions on one route because they are
 * three steps of one conversation and splitting them would spread the same guard over three files.
 *
 * `begin` STORES NOTHING. The secret is generated, shown once and held only by the browser until the
 * reader proves they have added it to an authenticator app. Writing it at `begin` would leave every
 * abandoned enrolment as a half-armed account: `twoFactorSecret` set for a device nobody scanned.
 *
 * `enable` requires a working code FOR THE SUBMITTED SECRET, which is what makes the round trip
 * meaningful — it proves the app and the server agree before the account starts depending on them.
 *
 * `disable` requires the password, because a session is not proof of presence. Someone who walks up
 * to an unlocked laptop must not be able to remove the very control that exists to stop them.
 */

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin") }),
  z.object({
    action: z.literal("enable"),
    /**
     * Exactly what `generateTotpSecret` emits: 20 random bytes as 32 unpadded base32 characters.
     * Pinning the shape stops a short or malformed secret — which an authenticator would accept and
     * a weak one would make guessable — from being stored at all.
     */
    secret: z
      .string()
      .trim()
      .regex(/^[A-Z2-7]{32}$/, "That setup code is not one this site issued. Start the setup again."),
    code: z
      .string()
      .trim()
      .regex(/^[0-9]{6}$/, "Enter the six digits shown in your authenticator app.")
  }),
  z.object({
    action: z.literal("disable"),
    password: z.string().min(1, "Enter your password to confirm.").max(200)
  })
]);

const ALREADY_ON =
  "Two-step verification is already switched on for this account. Turn it off first if you need to move it to a new device.";

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);
  const user = await requireUser();
  const body = await parseJson(request, Body);

  const context: AuditContext = {
    actor: { id: user.id, email: user.email },
    ipAddress: clientIp(request),
    userAgent: userAgent(request)
  };

  if (body.action === "begin") {
    if (user.twoFactorEnabled) throw conflict(ALREADY_ON);
    const secret = generateTotpSecret();
    return ok({
      secret,
      // The account name is the address the reader recognises; the issuer is what their app lists it
      // under. Both are shown beside the QR code so a manual entry is possible when a camera is not.
      uri: totpUri({ secret, accountName: user.email, issuer: siteName() })
    });
  }

  if (body.action === "enable") {
    if (user.twoFactorEnabled) throw conflict(ALREADY_ON);

    if (!verifyTotp(body.secret, body.code)) {
      throw badRequest(
        "That code does not match the setup code on screen. Codes last thirty seconds, so enter the current one — and check the clock on your phone is set automatically."
      );
    }

    // Hashed at the same cost as a password (bcrypt 12), so the ten of them take a couple of
    // seconds. That is deliberate and the screen should say it is working: a recovery code is a
    // password that bypasses the second factor, and storing it any cheaper than a password would
    // make the weakest credential on the account the one nobody thinks about.
    const recoveryCodes = generateRecoveryCodes();
    const hashedCodes = await Promise.all(
      recoveryCodes.map((code) => hashPassword(canonicalRecoveryCode(code)))
    );

    await mutateWithHistory(
      context,
      {
        action: "PERMISSION_CHANGE",
        entityType: "User",
        entityLabel: user.email,
        // No revision: a user row is not versioned content, and a revision of one would only be a
        // second copy of the audit entry with a redacted secret in it.
        revise: false,
        before: { twoFactorEnabled: false }
      },
      async (tx) =>
        tx.user.update({
          where: { id: user.id },
          data: {
            twoFactorEnabled: true,
            // Encrypted at rest — a plaintext shared secret means one database read is a complete
            // account takeover, which is the one thing a second factor is bought to prevent.
            twoFactorSecret: encryptSecret(body.secret),
            twoFactorRecoveryCodes: hashedCodes
          }
        })
    );

    // The only time the plain codes exist outside the reader's hands. They are never recoverable
    // afterwards, which is why the screen showing them must insist on being read before it is left.
    return ok({ enabled: true, recoveryCodes });
  }

  // ── disable ────────────────────────────────────────────────────────────────
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true }
  });

  // 403, not 401. A 401 would send the browser client off to refresh a session that is perfectly
  // valid and then replay this request — charging the reader two password checks for one wrong
  // answer, and reading to them as though they had been signed out.
  if (!(await verifyPassword(body.password, row?.passwordHash ?? null))) {
    throw forbidden("That password is not correct. Two-step verification has not been changed.");
  }

  // Already off: say so rather than refusing. Turning off something that is off is not an error, and
  // the reader's intent is satisfied either way.
  if (!user.twoFactorEnabled) return ok({ enabled: false });

  await mutateWithHistory(
    context,
    {
      action: "PERMISSION_CHANGE",
      entityType: "User",
      entityLabel: user.email,
      revise: false,
      before: { twoFactorEnabled: true }
    },
    async (tx) =>
      tx.user.update({
        where: { id: user.id },
        data: {
          twoFactorEnabled: false,
          twoFactorSecret: null,
          // Cleared with the secret. Codes left behind would still open the account, so a "disabled"
          // second factor would go on holding ten live credentials nobody remembers exist.
          twoFactorRecoveryCodes: []
        }
      })
  );

  return ok({ enabled: false });
});
