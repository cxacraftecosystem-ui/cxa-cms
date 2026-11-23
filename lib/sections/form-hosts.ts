/**
 * Which form services may be framed on the Centre's own origin, and the sentence that says so.
 *
 * ⚠ ZOD-FREE ON PURPOSE. These lived in lib/sections/schema.ts, which builds every block's zod schema
 * when it loads and so cannot be tree-shaken. FormEmbedSection is a client component on the public
 * site and needs only the allow-list below, so importing it from the schema module shipped zod (~88 KB
 * compressed) to every page with a form. lib/sections/schema.ts imports and re-exports all of this, so
 * the schema, the studio's form and the public renderer still share ONE copy of the security check.
 */

/**
 * The four services a small institution actually collects applications with.
 *
 * `other` is in the list because there is always another one — and it is the one provider whose form is
 * NEVER put in a frame. See the host allow-list below.
 */
export const FORM_PROVIDERS = ["google", "microsoft", "typeform", "other"] as const;

export type FormEmbedProvider = (typeof FORM_PROVIDERS)[number];

/**
 * WHICH HOSTS MAY BE PUT IN AN IFRAME ON OUR OWN ORIGIN, per provider.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS AN ALLOW-LIST AND NOT A CONVENIENCE. An arbitrary URL rendered in a frame on
 * `centre.example/apply` is a page under somebody else's control wearing the Centre's domain, its
 * padlock and its header — which is the entire construction of a credential-harvesting page. The
 * reader has no way to tell the frame apart from the page around it, and every instinct we teach them
 * ("check the address bar") gives the wrong answer.
 *
 * `other` maps to an EMPTY list on purpose rather than being absent: an unknown service is offered as
 * an ordinary outbound link, which is safe because a link shows its destination and leaves our origin.
 * A uniform lookup with an empty list is also one fewer branch than a special case, and a branch is
 * where a check gets forgotten.
 *
 * Typeform is matched by SUFFIX because every account gets its own subdomain. The leading dot in
 * `.typeform.com` is load-bearing: without it `eviltypeform.com` passes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const FORM_PROVIDER_HOSTS: Record<FormEmbedProvider, readonly string[]> = {
  // forms.gle is Google's short link. It redirects to docs.google.com inside the frame, which is why
  // it is accepted here rather than refused for not being the final host.
  google: ["docs.google.com", "forms.gle"],
  microsoft: ["forms.office.com", "forms.microsoft.com"],
  typeform: ["typeform.com"],
  other: []
};

/** Which hosts get a suffix match — `*.host` as well as `host` itself. */
const FORM_HOST_SUFFIX_MATCH: readonly string[] = ["typeform.com"];

/** The provider's name as an administrator says it. */
export const FORM_PROVIDER_LABELS: Record<FormEmbedProvider, string> = {
  google: "Google Forms",
  microsoft: "Microsoft Forms",
  typeform: "Typeform",
  other: "Another service"
};

/**
 * May this hostname be framed for this provider?
 *
 * `www.` is stripped first, so the address a reader copied out of a browser bar is judged on the same
 * terms as the share link. Exported because the schema, the studio's form and the public renderer must
 * all reach the same verdict, and three copies of a security check are three chances for one of them to
 * be out of date.
 */
export function formHostAllowed(provider: FormEmbedProvider, hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^www\./, "");
  if (host === "") return false;

  return FORM_PROVIDER_HOSTS[provider].some((allowed) => {
    if (host === allowed) return true;
    return FORM_HOST_SUFFIX_MATCH.includes(allowed) && host.endsWith(`.${allowed}`);
  });
}

/**
 * The refusal, as a sentence naming what IS accepted.
 *
 * "That address is not allowed" tells an editor nothing they can act on. Naming the hosts turns a
 * refusal into an instruction, which is the whole of §9's rule that a message is a plain human sentence
 * ready to render verbatim.
 */
export function describeFormHosts(provider: FormEmbedProvider): string {
  const hosts = FORM_PROVIDER_HOSTS[provider];
  if (hosts.length === 0) {
    return "A form from any other service is offered as a link rather than shown inside the page, because a page from an address we do not recognise must not be framed inside the Centre's own site.";
  }

  const named = hosts
    .map((host) => (FORM_HOST_SUFFIX_MATCH.includes(host) ? `${host} (and its subdomains)` : host))
    .join(" or ");
  return `For ${FORM_PROVIDER_LABELS[provider]}, the address has to be on ${named}.`;
}
