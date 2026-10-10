/**
 * Start-up hook. Next runs `register()` once per server process, before any request is served.
 *
 * It registers the newsletter's mail provider (Amazon SES) when its environment is set, so the first
 * confirmation email of a process goes out on the same code path as every later one and the start-up log
 * says which provider is in use. A process that serves a request before this has run still finds the
 * provider: `activeNewsletterMailer()` registers it from the environment on first use.
 *
 * ⚠ NODE ONLY. `register()` also runs in the edge runtime, which has neither Prisma nor the AWS SDK; the
 * dynamic import keeps both out of the edge bundle entirely.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNewsletterMailerFromEnv } = await import("./lib/newsletter/delivery");
  registerNewsletterMailerFromEnv();
}
