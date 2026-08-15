/**
 * Create or promote a MASTER ADMINISTRATOR, and grant them studio access.
 *
 *     node scripts/dev/grant-master-admin.mjs <email> [name]
 *     # the password is read from ADMIN_PASSWORD, never from an argument
 *
 * ⚠ THE PASSWORD IS READ FROM THE ENVIRONMENT, NOT FROM ARGV, and is never written to any file. A
 * command-line argument is visible in the process table to every other user on the machine and lands
 * in the shell history; a credential in .env or docker-compose.yml is a credential in every backup,
 * every image layer and every screen-share. Only the bcrypt hash is stored.
 *
 * Omit ADMIN_PASSWORD to create a provider-only account: no password is set, and the person signs in
 * with Google, Microsoft or Yahoo. That is the safer shape where a provider is available.
 *
 * Idempotent. Re-running promotes an existing account and refreshes the grant; it never creates a
 * second row and never silently changes a password that was not supplied.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const [, , rawEmail, ...nameParts] = process.argv;
if (!rawEmail) {
  console.error("Usage: ADMIN_PASSWORD=… node scripts/dev/grant-master-admin.mjs <email> [name]");
  process.exit(1);
}

const email = rawEmail.trim().toLowerCase();
const name = nameParts.join(" ").trim() || email.split("@")[0];
const password = process.env.ADMIN_PASSWORD;

// Mirrors lib/auth/password.ts. A weak password on the account that decides who else may sign in is
// the weakest link in the whole installation.
if (password && password.length < 12) {
  console.error("ADMIN_PASSWORD must be at least 12 characters.");
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const passwordHash = password ? await bcrypt.hash(password, 12) : undefined;

  const user = await prisma.user.upsert({
    where: { email },
    // A password is only written when one was supplied, so a re-run cannot blank an existing one.
    update: {
      role: "MASTER_ADMIN",
      isActive: true,
      canPublish: true,
      canManageMedia: true,
      ...(passwordHash ? { passwordHash } : {})
    },
    create: {
      email,
      name,
      role: "MASTER_ADMIN",
      canPublish: true,
      canManageMedia: true,
      ...(passwordHash ? { passwordHash } : {})
    }
  });

  /**
   * `allowedProviders: []` means ANY configured method.
   *
   * Naming a subset is a NARROWING, and narrowing a master administrator is how an installation locks
   * itself out: restrict the grant to GOOGLE, have the Google client secret expire, and nobody can add
   * anybody ever again. The empty list is the resilient choice for this tier.
   */
  await prisma.studioAccess.upsert({
    where: { email },
    update: {
      name,
      grantedRole: "MASTER_ADMIN",
      revokedAt: null,
      revokedById: null,
      allowedProviders: [],
      note: "Master administrator. May sign in with a password or with any configured provider."
    },
    create: {
      email,
      name,
      grantedRole: "MASTER_ADMIN",
      allowedProviders: [],
      note: "Master administrator. May sign in with a password or with any configured provider."
    }
  });

  console.log(`\n  ${user.email} is a master administrator.`);
  console.log(`  Password sign-in: ${user.passwordHash ? "enabled" : "not set (use a provider)"}`);
  console.log("  Studio access:    granted, any configured sign-in method\n");
} finally {
  await prisma.$disconnect();
}
