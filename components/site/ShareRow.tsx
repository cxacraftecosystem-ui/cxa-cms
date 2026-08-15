"use client";

/**
 * ShareRow — copy the link, or hand it to something else.
 *
 * THE COPY BUTTON ANNOUNCES THROUGH THE TOAST, NOT BY SWAPPING ITS ICON. A tick that replaces a
 * clipboard glyph for two seconds is a confirmation only a sighted reader who was looking at that
 * corner of the screen receives; everyone else presses the button and is told nothing. The toast
 * carries a sentence, and the toast viewport is the one live region the product announces through.
 *
 * ⚠ AND IT ANNOUNCES FAILURE TOO. `navigator.clipboard` is undefined on an insecure origin and can
 * reject when the document is not focused, so the write is wrapped and the failure names the URL —
 * a copy button that silently does nothing is worse than no copy button, because the reader walks
 * away believing they have the link.
 *
 * NATIVE SHARE IS ADDITIVE, NEVER A REPLACEMENT. `navigator.share` exists on phones and on almost no
 * desktop browser, and it can only be detected after hydration. Rendering the explicit links ONLY
 * when it is missing would mean the server emits one set of controls and the client swaps to
 * another — a flash, and a moment where the reader's finger is heading for a button that is about to
 * move. So the explicit links are always there, and the Share button is added beside them once we
 * know the platform has one.
 *
 * `url` IS ABSOLUTE AND COMES FROM THE SERVER. Build it with `absoluteUrl()` from lib/seo.ts in the
 * page. Reading `window.location.href` here would produce a different string during SSR, and would
 * happily share a URL carrying whatever filter parameters happened to be in the address bar.
 */

import { useEffect, useState } from "react";
import {
  Linkedin,
  Link2,
  Mail,
  MessageCircle,
  Share2,
  Twitter,
  type LucideIcon
} from "lucide-react";

import { Button, LinkButton } from "@/components/ui/Button";
import { useToast } from "@/components/ui/ToastProvider";
import { cn } from "@/lib/utils";

export type ShareTarget = "linkedin" | "x" | "whatsapp" | "email";

export interface ShareRowProps {
  /** Absolute, canonical URL for this page. */
  url: string;
  /** The page's title. Used as the share text and the email subject. */
  title: string;
  /** One extra sentence for the platforms that take one. */
  text?: string;
  /** Which explicit targets to offer. Default: LinkedIn, X, email. */
  targets?: readonly ShareTarget[];
  /** Names the group of controls — "Share this project". */
  label?: string;
  className?: string;
}

const DEFAULT_TARGETS: readonly ShareTarget[] = ["linkedin", "x", "email"];

interface TargetSpec {
  name: string;
  icon: LucideIcon;
  href: (url: string, title: string, text?: string) => string;
}

const TARGETS: Record<ShareTarget, TargetSpec> = {
  linkedin: {
    name: "LinkedIn",
    icon: Linkedin,
    href: (url) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`
  },
  x: {
    name: "X",
    // lucide has no post-rebrand mark; the bird is the closest glyph in the one icon set this
    // product uses (contract §13), and the accessible name says "X" regardless.
    icon: Twitter,
    href: (url, title) =>
      `https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`
  },
  whatsapp: {
    name: "WhatsApp",
    icon: MessageCircle,
    href: (url, title) => `https://wa.me/?text=${encodeURIComponent(`${title} ${url}`)}`
  },
  email: {
    name: "email",
    icon: Mail,
    href: (url, title, text) =>
      `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(
        text ? `${text}\n\n${url}` : url
      )}`
  }
};

export function ShareRow({
  url,
  title,
  text,
  targets = DEFAULT_TARGETS,
  label = "Share this page",
  className
}: ShareRowProps) {
  const { toast } = useToast();
  // Detected after mount, never during render: `navigator` does not exist on the server, and an
  // `initial` that differs between the two is a hydration mismatch.
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);

  const copy = async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        throw new Error("The clipboard API is unavailable.");
      }
      await navigator.clipboard.writeText(url);
      toast({ tone: "success", title: "Link copied", description: url });
    } catch {
      toast({
        tone: "error",
        title: "The link could not be copied",
        description: `Copy it from the address bar instead: ${url}`
      });
    }
  };

  const shareNatively = async () => {
    try {
      await navigator.share({ title, text, url });
    } catch (error) {
      // AbortError is the reader closing the share sheet. That is a decision, not a failure, and a
      // toast for it would tell them off for changing their mind.
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast({
        tone: "error",
        title: "Sharing is not available",
        description: "Use the copy link button instead."
      });
    }
  };

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {canShare ? (
        <Button variant="secondary" icon={Share2} onClick={shareNatively}>
          Share
        </Button>
      ) : null}

      <Button variant="secondary" icon={Link2} onClick={copy}>
        Copy link
      </Button>

      {targets.map((key) => {
        const target = TARGETS[key];
        return (
          <LinkButton
            key={key}
            href={target.href(url, title, text)}
            variant="secondary"
            icon={target.icon}
            // `mailto:` opens a client rather than a tab, so it is left to the browser; the rest are
            // external destinations and carry the rel pair plus the spoken warning.
            newTab={key !== "email"}
            // `.field-button-secondary` is `px-4` for a labelled button; these carry only a glyph.
            // A utility beats a @layer components recipe on source order, so no `!` is needed.
            className="px-3"
          >
            <span className="sr-only">Share by {target.name}</span>
          </LinkButton>
        );
      })}
    </div>
  );
}
