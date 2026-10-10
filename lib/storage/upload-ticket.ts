import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { badRequest } from "@/lib/api";
import { authEnv } from "@/lib/env";
import { z } from "@/lib/zod";
import { isSha256Base64, SHA256_REQUIRED_MESSAGE } from "./upload-limits";

/**
 * The upload ticket: a signed record of exactly what a presign route agreed to.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY IT EXISTS. Presign writes nothing to the database (a signed URL is a promise, not a fact), so by
 * the time a finalize route runs the server has no memory of the size, type and SHA-256 it signed. The
 * browser's own description of the file is the thing being checked, so it cannot also be the reference.
 * The ticket carries the presigned values back, sealed with an HMAC, and the finalize route compares the
 * object's `HEAD` against THEM — not against whatever the request body now claims.
 *
 * It is bound to the object key (so one ticket cannot finalize another upload) and to the user who asked
 * for it (so a ticket lifted from one session cannot register bytes under somebody else's name).
 *
 * Format: `base64url(json).base64url(HMAC-SHA256("upload-ticket:v1:" + body))`, keyed with `JWT_SECRET`
 * through `authEnv()` — which refuses a weak or placeholder key — and domain-separated so no other token
 * this application signs with the same key can be replayed as one of these.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

const TICKET_DOMAIN = "upload-ticket:v1:";

/**
 * How long a ticket is accepted after it was issued.
 *
 * Far longer than the 15-minute PUT URL on purpose: the URL only has to be valid when the transfer
 * STARTS, a 200 MB file on a domestic uplink can take most of an hour, and the file store collects a
 * title and a category before it registers. The ticket grants nothing on its own — the bytes must already
 * be in storage under its key, with its size and its checksum.
 */
export const UPLOAD_TICKET_TTL_SECONDS = 24 * 60 * 60;

/** Generous for the five fields below; anything longer is not one of ours. */
const MAX_TICKET_LENGTH = 4096;

/** The `sha256` field every presign body carries. Required: see lib/storage/upload-limits.ts. */
export const Sha256Field = z
  .string({ error: SHA256_REQUIRED_MESSAGE })
  .trim()
  .refine(isSha256Base64, SHA256_REQUIRED_MESSAGE);

/** The `uploadTicket` field every finalize body carries. Required: an upload without one is refused. */
export const UploadTicketField = z
  .string({ error: "The upload's receipt is missing, so nothing was saved. Start the upload again." })
  .trim()
  .min(1, "The upload's receipt is missing, so nothing was saved. Start the upload again.")
  .max(MAX_TICKET_LENGTH, "The upload's receipt is damaged, so nothing was saved. Start the upload again.");

export interface UploadIntent {
  objectKey: string;
  byteSize: number;
  /** Lower-cased, exactly as signed into the PUT. */
  contentType: string;
  /** Standard base64 of the raw 32-byte digest, exactly as signed into the PUT. */
  sha256: string;
}

interface TicketPayload extends UploadIntent {
  userId: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

function sign(body: string): string {
  return createHmac("sha256", authEnv().secret).update(TICKET_DOMAIN + body).digest("base64url");
}

export function signUploadTicket(
  input: UploadIntent & { userId: string },
  now: Date = new Date()
): string {
  const payload: TicketPayload = {
    objectKey: input.objectKey,
    byteSize: input.byteSize,
    contentType: input.contentType,
    sha256: input.sha256,
    userId: input.userId,
    exp: Math.floor(now.getTime() / 1000) + UPLOAD_TICKET_TTL_SECONDS
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

function readPayload(value: unknown): TicketPayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.objectKey !== "string" ||
    typeof v.contentType !== "string" ||
    typeof v.userId !== "string" ||
    typeof v.byteSize !== "number" ||
    !Number.isSafeInteger(v.byteSize) ||
    v.byteSize <= 0 ||
    typeof v.exp !== "number" ||
    !isSha256Base64(v.sha256)
  ) {
    return null;
  }
  return {
    objectKey: v.objectKey,
    byteSize: v.byteSize,
    contentType: v.contentType,
    sha256: v.sha256,
    userId: v.userId,
    exp: v.exp
  };
}

const RESTART = "Start the upload again.";

/**
 * The presigned values for this upload, or a 400 explaining why the ticket is not accepted.
 *
 * Every refusal is a 400 with a sentence, never a 500: a stale tab or an expired ticket is an ordinary
 * event, and the remedy (upload again) is the same for all of them.
 */
export function verifyUploadTicket(
  ticket: string,
  expected: { objectKey: string; userId: string },
  now: Date = new Date()
): UploadIntent {
  const token = ticket.trim();
  const separator = token.indexOf(".");
  // EXACTLY ONE separator, so the body cannot be extended after the signature was computed.
  if (
    token.length === 0 ||
    token.length > MAX_TICKET_LENGTH ||
    separator <= 0 ||
    token.indexOf(".", separator + 1) !== -1
  ) {
    throw badRequest(`The upload's receipt is missing or damaged, so nothing was saved. ${RESTART}`);
  }

  const body = token.slice(0, separator);
  const presented = Buffer.from(token.slice(separator + 1), "utf8");
  const wanted = Buffer.from(sign(body), "utf8");
  if (presented.length !== wanted.length || !timingSafeEqual(presented, wanted)) {
    throw badRequest(`The upload's receipt is missing or damaged, so nothing was saved. ${RESTART}`);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    decoded = null;
  }
  const payload = readPayload(decoded);
  if (!payload) {
    throw badRequest(`The upload's receipt is missing or damaged, so nothing was saved. ${RESTART}`);
  }

  if (payload.exp * 1000 <= now.getTime()) {
    throw badRequest(`This upload was started more than a day ago and its receipt has expired. ${RESTART}`);
  }
  if (payload.objectKey !== expected.objectKey) {
    throw badRequest(`The upload's receipt is for a different file, so nothing was saved. ${RESTART}`);
  }
  if (payload.userId !== expected.userId) {
    throw badRequest(`This upload was started by a different account, so nothing was saved. ${RESTART}`);
  }

  return {
    objectKey: payload.objectKey,
    byteSize: payload.byteSize,
    contentType: payload.contentType,
    sha256: payload.sha256
  };
}
