import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect as navigate } from "next/navigation";
import {
  CircleCheck,
  Download,
  KeyRound,
  LogOut,
  Smartphone,
  TriangleAlert,
  UserRound
} from "lucide-react";

import { prisma } from "@/lib/db";
import { requireStudioUser, requireUser } from "@/lib/auth/current-user";
import { ACCESS_COOKIE, REFRESH_COOKIE, SESSION_HINT_COOKIE } from "@/lib/auth/cookies";
import { hashPassword, passwordProblems, verifyPassword } from "@/lib/auth/password";
import { revokeAllSessionsForUser } from "@/lib/auth/session";
import {
  canonicalRecoveryCode,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  totpUri,
  verifyTotp
} from "@/lib/auth/totp";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { isProduction, siteName } from "@/lib/env";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/permissions";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { MediaImage } from "@/components/ui/MediaImage";
import { Select } from "@/components/ui/Select";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";

/**
 * Your own account — name, picture, sign-in address, password, and two-step verification.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireUser()` IS THE FIRST STATEMENT of the page and of every action. Editing your own profile is not
 * a privilege, so there is no capability beyond being signed in — but each action re-reads the row rather
 * than trusting the token, because a token minted before a deactivation stays valid for up to half an hour.
 *
 * SERVER ACTIONS AND PLAIN FORMS, and here that is a security decision as much as a simplicity one.
 *
 *   • THE PENDING SECOND-FACTOR SECRET NEVER TOUCHES JAVASCRIPT. It is generated on the server, kept in an
 *     `httpOnly` cookie for ten minutes, and read back by the server when the six-digit code is submitted.
 *     A browser-held secret can be read by anything running on the page; this one cannot, and it is never
 *     put in a URL, where it would live in the history and in every proxy log on the way.
 *   • NOTHING IS STORED UNTIL A CODE IS PROVED. Writing the secret at "begin" would leave every abandoned
 *     setup as a half-armed account.
 *   • DISABLING NEEDS THE PASSWORD. A session is not proof of presence: somebody who walks up to an
 *     unlocked laptop must not be able to remove the very control that exists to stop them.
 *
 * ⚠ `app/api/auth/two-factor/route.ts` IMPLEMENTS THE SAME THREE STEPS FOR A CLIENT. That route is the
 * canonical one for anything talking over HTTP; the actions below use exactly the same library functions
 * from `lib/auth/totp.ts` and enforce exactly the same three rules, so the two cannot disagree about the
 * cryptography — only about how the secret gets from one step to the next. If either changes, both change.
 *
 * ⚠ THERE IS NO SCANNABLE SQUARE, AND THE SCREEN SAYS SO RATHER THAN PRETENDING. Drawing a QR code means
 * a QR encoder, and no dependency may be added (contract §13); hand-rolling one is four hundred lines of
 * bit-twiddling whose failure mode is a square that silently will not scan, which is worse than no square.
 * What is offered instead does the same job: a link that opens the authenticator app directly on a phone,
 * and the setup key in readable groups for typing in by hand. Every authenticator accepts both.
 *
 * ⚠ HOW IT IS REACHED, AND WHY THAT IS NOT A DETAIL. Like every studio screen this file declares no link
 * to itself: it is listed once in `components/studio/StudioNav.ts`, which is what the sidebar and the
 * Ctrl/Cmd+K jump-to panel render from. It is also the ONLY place in the product where two-step
 * verification can be switched on — `app/api/studio/users/[id]/two-factor/route.ts` exports DELETE and
 * nothing else, deliberately, because nobody may arm somebody else's second factor — and the only place a
 * password or a sign-in address can be changed at all. Left out of that registry, this screen is one an
 * administrator can reach only by typing the address, while the dashboard goes on telling them their
 * colleagues have no second factor.
 *
 * RECOVERY CODES ARE SHOWN EXACTLY ONCE. They are stored as bcrypt hashes and cannot be recovered, so the
 * screen insists on being dealt with before it is left: a text box ready to select, a file to save, and a
 * button that clears them. They live in an `httpOnly` cookie for ten minutes so that the page can render
 * them once after the redirect — and that cookie is deleted the moment the reader says they have them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your account"
};

/** How many recent pictures the avatar chooser offers. Stated on screen when it bites. */
const AVATAR_CHOICES = 60;

/**
 * The two short-lived cookies this screen uses.
 *
 * Namespaced, `httpOnly`, `sameSite: strict`, scoped to THIS PATH, and ten minutes long. The path scope is
 * what stops them being sent with every other request in the studio; the strict same-site rule stops them
 * being sent on a cross-site navigation at all.
 */
const PENDING_SECRET_COOKIE = "cxa.account.2fa-secret";
const RECOVERY_CODES_COOKIE = "cxa.account.2fa-codes";
const SHORT_COOKIE_SECONDS = 600;

function shortCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: isProduction(),
    path: "/studio/account",
    maxAge: SHORT_COOKIE_SECONDS
  };
}

const PROBLEMS: Record<string, string> = {
  name_missing: "A name is needed — it is what colleagues see beside everything you change.",
  password_wrong: "That is not your current password, so nothing has been changed.",
  password_mismatch: "The two new passwords were not the same, so nothing has been changed.",
  password_weak: "That password was refused. The rules are listed under the boxes.",
  password_same: "The new password is the same as the old one, so nothing has been changed.",
  email_invalid: "That does not look like a complete email address, so nothing has been changed.",
  email_taken: "Another account already uses that address. Nothing has been changed.",
  setup_expired:
    "The setup ran out of time, or it was started in another window. Start it again — nothing has been changed.",
  code_wrong:
    "That code does not match the setup key on screen. Codes last thirty seconds, so enter the current one — and check your phone's clock is set automatically.",
  already_on:
    "Two-step verification is already switched on for this account. Switch it off first if you need to move it to a new phone.",
  not_on: "Two-step verification is not switched on for this account."
};

const NOTICES: Record<string, string> = {
  profile_saved: "Your profile has been saved.",
  email_saved: "Your sign-in address has been changed. Use the new one next time you sign in.",
  two_factor_on:
    "Two-step verification is on. Your recovery codes are below — deal with them before you leave this page, because they cannot be shown again.",
  two_factor_off:
    "Two-step verification is off. Your account is protected by its password alone until you set it up again.",
  codes_dismissed: "The recovery codes have been cleared from this screen."
};

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** The setup key in groups of four, which is how it is typed in by hand without losing your place. */
function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The actions
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Who is doing this, for the audit entry.
 *
 * `clientIp()`/`userAgent()` in lib/api.ts take a `Request`, which a Server Action does not have, so the
 * same two headers are read here. `x-forwarded-for` carries a list; the first entry is the client.
 */
async function auditContext(actor: { id: string; email: string }): Promise<AuditContext> {
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for");
  return {
    actor,
    ipAddress: forwarded?.split(",")[0]?.trim() ?? incoming.get("x-real-ip") ?? null,
    userAgent: incoming.get("user-agent")
  };
}

function backWith(params: Record<string, string>): never {
  const search = new URLSearchParams(params).toString();
  navigate(`/studio/account${search.length > 0 ? `?${search}` : ""}`);
}

/** Clear the session cookies as well as the rows, so the still-valid access token cannot be replayed. */
async function endEverySession(userId: string): Promise<void> {
  await revokeAllSessionsForUser(userId);
  const store = await cookies();
  // Revoking the rows stops a REFRESH; the access token stays valid until it expires, which is up to half
  // an hour of a signed-out person still being able to read the studio. Deleting the cookies closes that.
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
  store.delete(SESSION_HINT_COOKIE);
}

async function saveProfile(formData: FormData): Promise<void> {
  "use server";

  const user = await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const avatarId = String(formData.get("avatarId") ?? "").trim();

  if (name.length === 0) backWith({ problem: "name_missing" });

  const before = await prisma.user.findUnique({
    where: { id: user.id },
    select: { name: true, title: true, avatarId: true }
  });

  const context = await auditContext({ id: user.id, email: user.email });

  await mutateWithHistory(
    context,
    {
      action: "UPDATE",
      entityType: "User",
      entityLabel: user.email,
      // No revision: a user row is not versioned content, and a revision of one would only be a second
      // copy of the audit entry with its secrets redacted.
      revise: false,
      before
    },
    async (tx) =>
      tx.user.update({
        where: { id: user.id },
        data: {
          name: name.slice(0, 200),
          title: title.length > 0 ? title.slice(0, 200) : null,
          // "" from a cleared `<select>` means NO picture, which is `null` — not an id nobody has.
          avatarId: avatarId.length > 0 ? avatarId : null
        }
      })
  );

  backWith({ notice: "profile_saved" });
}

async function changeEmail(formData: FormData): Promise<void> {
  "use server";

  const user = await requireUser();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  // A very plain shape check. Anything stricter rejects a real address somewhere, and this value is
  // somebody's only way back into the studio.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) backWith({ problem: "email_invalid" });

  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  // The password, because this changes what the account SIGNS IN WITH. A session is not proof of presence.
  if (!(await verifyPassword(password, row?.passwordHash ?? null))) {
    backWith({ problem: "password_wrong" });
  }

  const clash = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (clash && clash.id !== user.id) backWith({ problem: "email_taken" });

  const context = await auditContext({ id: user.id, email: user.email });

  await mutateWithHistory(
    context,
    {
      action: "UPDATE",
      entityType: "User",
      entityLabel: email,
      revise: false,
      before: { email: user.email }
    },
    async (tx) => tx.user.update({ where: { id: user.id }, data: { email } })
  );

  backWith({ notice: "email_saved" });
}

async function changePassword(formData: FormData): Promise<void> {
  "use server";

  const user = await requireUser();

  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  if (!(await verifyPassword(current, row?.passwordHash ?? null))) {
    backWith({ problem: "password_wrong" });
  }
  if (next !== confirm) backWith({ problem: "password_mismatch" });
  if (next === current) backWith({ problem: "password_same" });
  // The SAME rules the sign-in and the invitation flows use, from lib/auth/password.ts. A second list of
  // rules written here would eventually accept a password one of the others refused.
  if (passwordProblems(next).length > 0) backWith({ problem: "password_weak" });

  const context = await auditContext({ id: user.id, email: user.email });

  await mutateWithHistory(
    context,
    {
      action: "UPDATE",
      entityType: "User",
      entityLabel: user.email,
      revise: false,
      before: { passwordChanged: false }
    },
    async (tx) =>
      tx.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next) } })
  );

  /**
   * EVERY SESSION, INCLUDING THIS ONE.
   *
   * A password change is the answer to "somebody else may have my password", and it is worth nothing if the
   * device they were using stays signed in. Signing this device out too is the honest version of that: it
   * costs one sign-in and removes any doubt about which sessions survived. The copy beside the form says so
   * before it is pressed.
   */
  await endEverySession(user.id);
  navigate("/studio/login?next=%2Fstudio%2Faccount");
}

async function signOutEverywhere(): Promise<void> {
  "use server";

  const user = await requireUser();
  await endEverySession(user.id);
  navigate("/studio/login?next=%2Fstudio%2Faccount");
}

async function beginTwoFactor(): Promise<void> {
  "use server";

  const user = await requireUser();
  if (user.twoFactorEnabled) backWith({ problem: "already_on" });

  /**
   * NOTHING IS WRITTEN TO THE DATABASE HERE.
   *
   * The secret goes into an `httpOnly` cookie and nowhere else, so an abandoned setup leaves no trace and
   * no half-armed account. It is never put in the URL: that would place a shared secret in the browser
   * history and in every proxy log between here and the reader.
   */
  const secret = generateTotpSecret();
  const store = await cookies();
  store.set(PENDING_SECRET_COOKIE, secret, shortCookieOptions());

  backWith({ setup: "1" });
}

async function cancelTwoFactorSetup(): Promise<void> {
  "use server";

  await requireUser();
  const store = await cookies();
  store.delete(PENDING_SECRET_COOKIE);
  backWith({});
}

async function enableTwoFactor(formData: FormData): Promise<void> {
  "use server";

  const user = await requireUser();
  if (user.twoFactorEnabled) backWith({ problem: "already_on" });

  const store = await cookies();
  const secret = store.get(PENDING_SECRET_COOKIE)?.value ?? "";
  // Exactly what `generateTotpSecret()` emits: 20 random bytes as 32 unpadded base32 characters. Pinning
  // the shape stops a short or mangled value — which an authenticator would accept and a weak one would
  // make guessable — from ever being stored.
  if (!/^[A-Z2-7]{32}$/.test(secret)) backWith({ problem: "setup_expired" });

  const code = String(formData.get("code") ?? "").replace(/\D/g, "");
  // A working code FOR THIS SECRET is what makes the round trip meaningful: it proves the app and the
  // server agree before the account starts depending on them.
  if (!verifyTotp(secret, code)) backWith({ problem: "code_wrong" });

  /**
   * Hashed at the same cost as a password. Deliberate: a recovery code is a password that bypasses the
   * second factor, and storing it any cheaper would make the weakest credential on the account the one
   * nobody thinks about. Ten bcrypt hashes take a couple of seconds.
   */
  const plainCodes = generateRecoveryCodes();
  const hashedCodes = await Promise.all(
    plainCodes.map((entry) => hashPassword(canonicalRecoveryCode(entry)))
  );

  const context = await auditContext({ id: user.id, email: user.email });

  await mutateWithHistory(
    context,
    {
      action: "PERMISSION_CHANGE",
      entityType: "User",
      entityLabel: user.email,
      revise: false,
      before: { twoFactorEnabled: false }
    },
    async (tx) =>
      tx.user.update({
        where: { id: user.id },
        data: {
          twoFactorEnabled: true,
          // Encrypted at rest by lib/auth/totp.ts — a plaintext shared secret in the database means one
          // database read is a complete account takeover, which is the one thing a second factor is bought
          // to prevent.
          twoFactorSecret: encryptSecret(secret),
          twoFactorRecoveryCodes: hashedCodes
        }
      })
  );

  store.delete(PENDING_SECRET_COOKIE);
  // The only moment the plain codes exist outside the reader's hands. `httpOnly`, ten minutes, this path
  // only — and the screen that renders them offers a button that clears this immediately.
  store.set(RECOVERY_CODES_COOKIE, plainCodes.join(","), shortCookieOptions());

  backWith({ notice: "two_factor_on" });
}

async function dismissRecoveryCodes(): Promise<void> {
  "use server";

  await requireUser();
  const store = await cookies();
  store.delete(RECOVERY_CODES_COOKIE);
  backWith({ notice: "codes_dismissed" });
}

async function disableTwoFactor(formData: FormData): Promise<void> {
  "use server";

  const user = await requireUser();

  const password = String(formData.get("password") ?? "");
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  // THE PASSWORD, ALWAYS. A session is not proof of presence: somebody at an unlocked laptop must not be
  // able to remove the control that exists to stop them.
  if (!(await verifyPassword(password, row?.passwordHash ?? null))) {
    backWith({ problem: "password_wrong" });
  }
  if (!user.twoFactorEnabled) backWith({ problem: "not_on" });

  const context = await auditContext({ id: user.id, email: user.email });

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
          // Cleared with the secret. Codes left behind would still open the account, so a "switched off"
          // second factor would go on holding ten live credentials nobody remembers exist.
          twoFactorRecoveryCodes: []
        }
      })
  );

  backWith({ notice: "two_factor_off" });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export default async function StudioAccountPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // `requireStudioUser`, not `requireUser`, because this is the PAGE render path: a throw here has no
  // route() wrapper to catch it and becomes a 500 telling the reader the site is broken. The case is
  // real — an account deactivated while its access token is still within its lifetime lands exactly
  // here — and the honest answer is a redirect to sign in. The server actions above deliberately keep
  // `requireUser()`: an action's throw reaches the client as an error state carrying its message, and
  // redirecting out of one would discard whatever had been typed.
  const session = await requireStudioUser();

  const params = await searchParams;
  const problem = PROBLEMS[first(params.problem)] ?? null;
  const notice = NOTICES[first(params.notice)] ?? null;
  const settingUp = first(params.setup) === "1";

  const store = await cookies();
  const pendingSecret = store.get(PENDING_SECRET_COOKIE)?.value ?? "";
  const recoveryCodes = (store.get(RECOVERY_CODES_COOKIE)?.value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const [user, avatarChoices, activeSessions] = await prisma.$transaction([
    prisma.user.findUniqueOrThrow({
      where: { id: session.id },
      select: {
        id: true,
        name: true,
        email: true,
        title: true,
        role: true,
        avatarId: true,
        twoFactorEnabled: true,
        twoFactorRecoveryCodes: true,
        lastLoginAt: true,
        createdAt: true,
        avatar: {
          select: {
            objectKey: true,
            width: true,
            height: true,
            altText: true,
            blurDataUrl: true,
            variants: { select: { label: true, format: true, objectKey: true, width: true } }
          }
        }
      }
    }),
    /**
     * The pictures the avatar chooser offers.
     *
     * A plain `<select>` of recent images rather than the studio's media picker: the picker is a client
     * component, and this screen is deliberately a Server Component so that the second-factor secret never
     * reaches JavaScript. A dropdown of file names is a smaller tool, and it is the one that fits.
     */
    prisma.mediaAsset.findMany({
      where: { deletedAt: null, kind: "IMAGE" },
      select: { id: true, fileName: true },
      orderBy: { createdAt: "desc" },
      take: AVATAR_CHOICES
    }),
    prisma.session.count({
      where: { userId: session.id, revokedAt: null, expiresAt: { gt: new Date() } }
    })
  ]);

  const codesLeft = user.twoFactorRecoveryCodes.length;
  const uri =
    pendingSecret.length > 0
      ? totpUri({ secret: pendingSecret, accountName: user.email, issuer: siteName() })
      : "";

  return (
    <div className="mx-auto w-full max-w-[52rem] space-y-6">
      <StudioPageHeader
        title="Your account"
        description="Your name and picture as colleagues see them, the address you sign in with, your password, and the second step that protects it."
        meta={<Badge tone="info">{ROLE_LABELS[user.role]}</Badge>}
      />

      {problem ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-error-200 bg-error-100 px-3.5 py-3 text-sm leading-relaxed text-error-700"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{problem}</span>
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-success-600/25 bg-success-100 px-3.5 py-3 text-sm leading-relaxed text-success-600"
        >
          <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </p>
      ) : null}

      {/* ── The recovery codes, shown exactly once ────────────────────────────────────────── */}
      {recoveryCodes.length > 0 ? (
        <FormSection
          title="Your recovery codes — write these down now"
          tone="danger"
          description="Each one gets you into your account once, without your phone. They are the only way back in if you lose the device with your authenticator on it."
        >
          <div className="rounded-md border border-error-200 bg-error-100 px-3.5 py-3">
            <p className="flex items-start gap-2 text-sm font-semibold text-error-700">
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                This is the only time these will be shown. They are stored scrambled and cannot be read
                back — not by you, not by an administrator, not by anybody.
              </span>
            </p>
          </div>

          {/*
            A read-only text box rather than a copy button: it can be selected with the keyboard, is read
            properly by a screen reader, and is not a control that silently does nothing when the clipboard
            permission is refused. `readOnly`, so nothing can be typed over them by accident.
          */}
          <Field
            label="Recovery codes"
            help="Select all of these and copy them, or use the button below to save them as a file. Keep them somewhere you can reach without your phone."
          >
            <textarea
              readOnly
              rows={recoveryCodes.length}
              value={recoveryCodes.join("\n")}
              className="field-input font-mono text-sm leading-relaxed"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            {/*
              A `data:` link rather than an endpoint: the codes are already on this page, and a route that
              served them would be a second place they exist and a second thing to secure.
            */}
            <a
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(
                `Recovery codes for ${user.email} at ${siteName()}\nEach code works once.\n\n${recoveryCodes.join("\n")}\n`
              )}`}
              download="recovery-codes.txt"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              <Download aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              Save them as a file
            </a>

            <form action={dismissRecoveryCodes}>
              <Button type="submit" size="sm">
                I have saved them — clear this
              </Button>
            </form>
          </div>
        </FormSection>
      ) : null}

      {/* ── Profile ───────────────────────────────────────────────────────────────────────── */}
      <FormSection
        title="Your details"
        description="Your name appears beside everything you change, in the audit log and on the dashboard."
        footer={
          <Button type="submit" form="account-profile">
            Save your details
          </Button>
        }
      >
        {/*
          `form` + `id` rather than putting the button inside: the submit sits in the panel's footer, which
          is outside the `<form>` element in the DOM. The attribute is what makes it submit this form anyway.
        */}
        <form id="account-profile" action={saveProfile} className="space-y-5">
          <div className="flex items-start gap-4">
            {user.avatar ? (
              <MediaImage
                media={user.avatar}
                alt={`${user.name}, as shown beside their changes`}
                aspect={1}
                rounded="full"
                sizes="72px"
                className="h-16 w-16 shrink-0"
              />
            ) : (
              <span
                aria-hidden="true"
                className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-line-200 bg-surface-100 text-ink-300"
              >
                <UserRound className="h-6 w-6" />
              </span>
            )}

            <div className="min-w-0 flex-1 space-y-5">
              {/* `Field` (a real `<label>`) for all three: a plain input, a plain input and a native
                  `<select>`, so there is no button inside for a stray click to be forwarded to. */}
              <Field label="Your name" required help="As you would write it yourself.">
                <Input name="name" defaultValue={user.name} required maxLength={200} />
              </Field>

              <Field
                label="Your title"
                help="Optional — “Assistant Professor”, “Research Fellow”. Shown where there is room for it."
              >
                <Input name="title" defaultValue={user.title ?? ""} maxLength={200} />
              </Field>

              <Field
                label="Your picture"
                help="Chosen from the pictures already in the media library. Upload one there first if the one you want is not listed."
              >
                <Select
                  name="avatarId"
                  defaultValue={user.avatarId ?? ""}
                  placeholder="No picture"
                  options={avatarChoices.map((asset) => ({ value: asset.id, label: asset.fileName }))}
                />
              </Field>
            </div>
          </div>

          {avatarChoices.length >= AVATAR_CHOICES ? (
            <HelpText>
              The list offers the {AVATAR_CHOICES} most recently uploaded pictures, not all of them. Upload
              the one you want in the media library and it will appear at the top.
            </HelpText>
          ) : null}
        </form>
      </FormSection>

      {/* ── What you can do ───────────────────────────────────────────────────────────────── */}
      <FormSection
        title="What your account can do"
        description="Set by an administrator. Nobody can raise their own level of access."
      >
        <p className="text-sm text-ink-900">{ROLE_LABELS[user.role]}</p>
        <p className="prose-measure text-sm leading-relaxed text-ink-500">
          {ROLE_DESCRIPTIONS[user.role]}
        </p>
        <p className="text-xs text-ink-500">
          {activeSessions === 1
            ? "1 device is signed in as you."
            : `${activeSessions} devices are signed in as you.`}{" "}
          {user.lastLoginAt
            ? `You last signed in on ${user.lastLoginAt.toLocaleString("en-GB", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "UTC"
              })} UTC.`
            : ""}
        </p>
      </FormSection>

      {/* ── Sign-in address ───────────────────────────────────────────────────────────────── */}
      <FormSection
        title="Your sign-in address"
        description="This is what you type to sign in, so a typo here locks you out."
        footer={
          <Button type="submit" form="account-email" variant="secondary">
            Change the address
          </Button>
        }
      >
        <form id="account-email" action={changeEmail} className="space-y-5">
          <Field label="Email address" required help="It has to be an address you actually read.">
            <Input
              name="email"
              type="email"
              defaultValue={user.email}
              required
              autoComplete="username"
              spellCheck={false}
            />
          </Field>

          <Field label="Your current password" required help="Asked for because this changes how you sign in.">
            <Input name="password" type="password" required autoComplete="current-password" />
          </Field>

          <HelpText tone="warn">
            The new address takes effect at once and no confirmation message is sent, so check the spelling
            before you save. If you lock yourself out, another administrator can put it right — and if you
            are the only administrator, nobody can.
          </HelpText>
        </form>
      </FormSection>

      {/* ── Password ──────────────────────────────────────────────────────────────────────── */}
      <FormSection
        title="Your password"
        description="Changing it signs you out of every device, including this one."
        footer={
          <Button type="submit" form="account-password" variant="secondary" icon={KeyRound}>
            Change the password
          </Button>
        }
      >
        <form id="account-password" action={changePassword} className="space-y-5">
          <Field label="Your current password" required>
            <Input name="current" type="password" required autoComplete="current-password" />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Your new password"
              required
              help="At least 12 characters. A short phrase of several words is both stronger and easier to type than a scramble."
            >
              <Input name="next" type="password" required autoComplete="new-password" />
            </Field>

            <Field label="The new password again" required help="To catch a typo before it locks you out.">
              <Input name="confirm" type="password" required autoComplete="new-password" />
            </Field>
          </div>

          <HelpText tone="warn">
            When this is saved, every device signed in as you is signed out — this one included. That is
            deliberate: a password change is the answer to “somebody else may have my password”, and it is
            worth nothing if the device they were using stays signed in. You will be asked to sign in again
            with the new password straight away.
          </HelpText>
        </form>
      </FormSection>

      {/* ── Two-step verification ─────────────────────────────────────────────────────────── */}
      <FormSection
        title="Two-step verification"
        description="A six-digit code from an app on your phone, on top of your password. It is the single most effective thing you can do to protect this account."
      >
        {user.twoFactorEnabled ? (
          <>
            <p className="flex items-start gap-2 text-sm">
              <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
              <span className="text-ink-900">
                It is on.{" "}
                <span className="text-ink-500">
                  {codesLeft === 0
                    ? "You have no recovery codes left, so a lost phone means asking an administrator for help."
                    : `${codesLeft} recovery ${codesLeft === 1 ? "code is" : "codes are"} left.`}
                </span>
              </span>
            </p>

            {codesLeft === 0 ? (
              <HelpText tone="warn">
                Switch it off and set it up again to get a fresh set of recovery codes. Do that while you
                still have your phone — not after.
              </HelpText>
            ) : null}

            <form action={disableTwoFactor} className="space-y-4 rounded-md border border-error-200 p-3">
              <p className="text-sm font-semibold text-error-600">Switch it off</p>
              <p className="prose-measure text-sm leading-relaxed text-ink-700">
                Your account will need only its password again, and the recovery codes you hold stop
                working. Do this to move to a new phone — switch it off, then set it up again on the new
                device straight away.
              </p>

              <Field label="Your password" required help="Asked for because a session is not proof that it is you.">
                <Input name="password" type="password" required autoComplete="current-password" />
              </Field>

              <Button type="submit" variant="danger" size="sm">
                Switch off two-step verification
              </Button>
            </form>
          </>
        ) : pendingSecret.length > 0 || settingUp ? (
          pendingSecret.length === 0 ? (
            <HelpText tone="warn">
              The setup ran out of time, or it was started in another window. Start it again.
            </HelpText>
          ) : (
            <>
              <ol className="space-y-4">
                <li className="text-sm leading-relaxed text-ink-700">
                  <span className="font-semibold text-ink-900">1. Open your authenticator app.</span> Any of
                  them works — Google Authenticator, Microsoft Authenticator, Aegis, 1Password, Bitwarden.
                </li>

                <li className="text-sm leading-relaxed text-ink-700">
                  <span className="font-semibold text-ink-900">2. Add this account.</span> On the phone you
                  are reading this on, the link below opens the app with everything filled in. On a computer,
                  choose “enter a setup key” in the app and type the key underneath.
                  {/*
                    ⚠ NO QR CODE — see the file header. This link does the same job on the device where a
                    camera would be used, and the key does it everywhere else. A `data-allow-unsaved` is
                    unnecessary here: there is no unsaved work on this screen to guard.
                  */}
                  <span className="mt-2 block">
                    <a href={uri} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                      <Smartphone aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                      Open my authenticator app
                    </a>
                  </span>
                  <span className="mt-2 block rounded-md border border-line-200 bg-surface-50 px-3 py-2.5">
                    <span className="field-label block">Setup key</span>
                    <code className="mt-1 block break-all font-mono text-sm font-semibold text-ink-900">
                      {groupSecret(pendingSecret)}
                    </code>
                    <span className="mt-1.5 block text-xs leading-relaxed text-ink-500">
                      Account: {user.email} · Issuer: {siteName()} · Six digits, changing every thirty
                      seconds. The spaces are only there to make it readable — type it without them if the
                      app objects.
                    </span>
                  </span>
                </li>

                <li className="text-sm leading-relaxed text-ink-700">
                  <span className="font-semibold text-ink-900">
                    3. Type the code the app is showing now.
                  </span>{" "}
                  This proves your phone and this site agree about the time before your account starts
                  depending on it.
                </li>
              </ol>

              <form action={enableTwoFactor} className="space-y-4">
                <Field
                  label="The six digits from your app"
                  required
                  help="Codes last thirty seconds. If it is refused, wait for the next one and try that."
                >
                  <Input
                    name="code"
                    required
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="000000"
                    className="max-w-40 font-mono text-lg tracking-widest"
                  />
                </Field>

                <div className="flex flex-wrap gap-2">
                  <Button type="submit">Switch on two-step verification</Button>
                </div>
              </form>

              <form action={cancelTwoFactorSetup}>
                <Button type="submit" variant="ghost" size="sm">
                  Stop setting this up
                </Button>
              </form>

              <HelpText>
                Nothing has been saved to your account yet. If you close this page the setup is abandoned and
                the key above stops working, which is exactly what should happen — an abandoned setup must
                not leave your account half-protected.
              </HelpText>
            </>
          )
        ) : (
          <>
            <p className="flex items-start gap-2 text-sm">
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
              <span className="text-ink-900">
                It is off.{" "}
                <span className="text-ink-500">
                  Your password on its own is all that protects everything this account can change.
                </span>
              </span>
            </p>

            <form action={beginTwoFactor}>
              <Button type="submit" icon={Smartphone}>
                Set up two-step verification
              </Button>
            </form>

            <HelpText>
              You will need your phone in your hand — it takes about a minute. Nobody else can switch this
              on for you, and no administrator can ever see or copy your codes.
            </HelpText>
          </>
        )}
      </FormSection>

      {/* ── Sessions ──────────────────────────────────────────────────────────────────────── */}
      <FormSection
        title="Signed-in devices"
        description="Every computer and phone that is currently signed in as you."
      >
        <form action={signOutEverywhere}>
          <Button type="submit" variant="secondary" size="sm" icon={LogOut}>
            Sign out of every device
          </Button>
        </form>
        <HelpText>
          This ends every session, including this one, so you will be asked to sign in again immediately. Do
          it if you have signed in on a machine you no longer trust — a shared computer, a laptop you have
          lent out, or one that has been lost.
        </HelpText>
      </FormSection>
    </div>
  );
}
