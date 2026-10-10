import "./setup";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it, mock } from "node:test";

import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

import { ApiError } from "@/lib/api";
import { sha256Base64 } from "@/lib/client/checksum";
import { confirmUploadedObject, landedObjectProblem, presignUpload, s3 } from "@/lib/storage/client";
import {
  ABSOLUTE_MAX_UPLOAD_BYTES,
  FILE_STORE_MAX_BYTES,
  isSha256Base64,
  mediaMaxBytes,
  sha256Hex
} from "@/lib/storage/upload-limits";
import { signUploadTicket, verifyUploadTicket, type UploadIntent } from "@/lib/storage/upload-ticket";

const BODY = Buffer.from("the bytes of a small photograph");
const SHA = createHash("sha256").update(BODY).digest("base64");
const OTHER_SHA = createHash("sha256").update("different bytes").digest("base64");
const KEY = "media/2026/10/0123456789abcdef-photo.jpg";

const INTENT: UploadIntent = { objectKey: KEY, byteSize: BODY.length, contentType: "image/jpeg", sha256: SHA };

function badRequest(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// presign: size and checksum are REQUIRED and SIGNED
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("presignUpload — what the signed PUT pins down", () => {
  it("refuses to sign without an exact size", async () => {
    // Before the fix `contentLength` was optional, and this signed a URL that accepted any body size.
    await assert.rejects(
      presignUpload({ key: KEY, contentType: "image/jpeg", checksumSha256: SHA } as never),
      badRequest
    );
    for (const contentLength of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(
        presignUpload({ key: KEY, contentType: "image/jpeg", contentLength, checksumSha256: SHA }),
        badRequest
      );
    }
  });

  it("refuses to sign without a well-formed base64 SHA-256", async () => {
    const hex = createHash("sha256").update(BODY).digest("hex");
    const base64url = createHash("sha256").update(BODY).digest("base64url");
    for (const checksumSha256 of [undefined, "", hex, base64url, SHA.slice(0, -2) + "B="]) {
      await assert.rejects(
        presignUpload({
          key: KEY,
          contentType: "image/jpeg",
          contentLength: BODY.length,
          checksumSha256
        } as never),
        badRequest
      );
    }
  });

  it("signs Content-Type, Content-Length and x-amz-checksum-sha256 as HEADERS, and returns the ones to replay", async () => {
    const signed = await presignUpload({
      key: KEY,
      contentType: "image/jpeg",
      contentLength: BODY.length,
      checksumSha256: SHA
    });
    const url = new URL(signed.url);
    const signedHeaders = (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");

    // Before the fix the signature covered only `content-length;host` — not even the content type.
    for (const header of ["content-type", "content-length", "x-amz-checksum-sha256", "host"]) {
      assert.ok(signedHeaders.includes(header), `${header} is signed (got ${signedHeaders.join(";")})`);
    }
    // Hoisted into the query string, the checksum would be part of the URL rather than a body check.
    assert.equal(url.searchParams.get("x-amz-checksum-sha256"), null);

    assert.deepEqual(signed.headers, { "Content-Type": "image/jpeg", "x-amz-checksum-sha256": SHA });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// the limits and the digest format, shared by the browser and the routes
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("upload limits", () => {
  it("caps each media kind, never above the absolute cap", () => {
    assert.equal(mediaMaxBytes("VIDEO"), 200 * 1024 * 1024);
    assert.ok(mediaMaxBytes("IMAGE") < mediaMaxBytes("VIDEO"));
    assert.ok(mediaMaxBytes("DOCUMENT") < mediaMaxBytes("VIDEO"));
    for (const kind of ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "MODEL_3D", "PANORAMA"] as const) {
      assert.ok(mediaMaxBytes(kind) <= ABSOLUTE_MAX_UPLOAD_BYTES);
    }
    assert.equal(FILE_STORE_MAX_BYTES, 200 * 1024 * 1024);
  });

  it("accepts only canonical standard-base64 SHA-256 digests", () => {
    assert.equal(isSha256Base64(SHA), true);
    assert.equal(isSha256Base64(createHash("sha256").update(BODY).digest("hex")), false);
    assert.equal(isSha256Base64(SHA.replace(/=$/, "")), false);
    assert.equal(isSha256Base64(42), false);
  });

  it("converts the verified digest to the hex the checksum columns have always held", () => {
    assert.equal(sha256Hex(SHA), createHash("sha256").update(BODY).digest("hex"));
  });

  it("the browser's fingerprint matches Node's SHA-256 byte for byte", async () => {
    assert.equal(await sha256Base64(new Blob([BODY])), SHA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// the ticket: what presign agreed to, sealed
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("upload ticket", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const ticket = signUploadTicket({ ...INTENT, userId: "user_1" }, now);

  it("round-trips the presigned values", () => {
    assert.deepEqual(verifyUploadTicket(ticket, { objectKey: KEY, userId: "user_1" }, now), INTENT);
  });

  it("refuses a ticket that was edited — e.g. a larger size or another checksum", () => {
    const [body, signature] = ticket.split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    for (const edit of [{ byteSize: payload.byteSize + 1 }, { sha256: OTHER_SHA }, { contentType: "text/html" }]) {
      const forged = `${Buffer.from(JSON.stringify({ ...payload, ...edit })).toString("base64url")}.${signature}`;
      assert.throws(() => verifyUploadTicket(forged, { objectKey: KEY, userId: "user_1" }, now), badRequest);
    }
    assert.throws(() => verifyUploadTicket(`${ticket}.x`, { objectKey: KEY, userId: "user_1" }, now), badRequest);
    assert.throws(() => verifyUploadTicket("", { objectKey: KEY, userId: "user_1" }, now), badRequest);
  });

  it("refuses another key, another user, and an expired ticket", () => {
    assert.throws(
      () => verifyUploadTicket(ticket, { objectKey: "media/2026/10/fedcba9876543210-x.jpg", userId: "user_1" }, now),
      badRequest
    );
    assert.throws(() => verifyUploadTicket(ticket, { objectKey: KEY, userId: "user_2" }, now), badRequest);
    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    assert.throws(() => verifyUploadTicket(ticket, { objectKey: KEY, userId: "user_1" }, later), badRequest);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// finalize: HEAD the object and compare it with the ticket, against a mocked S3 client
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface FakeHead {
  ContentLength?: number;
  ContentType?: string;
  ETag?: string;
  ChecksumSHA256?: string;
}

/** Replace the storage client's `send`, recording every command. `head: null` answers 404. */
function fakeStorage(head: FakeHead | null) {
  const sent: unknown[] = [];
  mock.method(s3(), "send", async (command: unknown) => {
    sent.push(command);
    if (command instanceof HeadObjectCommand) {
      if (head === null) {
        throw Object.assign(new Error("Not Found"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      }
      return head;
    }
    if (command instanceof DeleteObjectCommand) return {};
    throw new Error(`unexpected command ${String((command as object)?.constructor?.name)}`);
  });
  return {
    heads: () => sent.filter((c): c is HeadObjectCommand => c instanceof HeadObjectCommand),
    deletes: () => sent.filter((c): c is DeleteObjectCommand => c instanceof DeleteObjectCommand)
  };
}

const OPTIONS = { logTag: "[test]", nothingChanged: "Nothing was added." };
const GOOD_HEAD: FakeHead = { ContentLength: BODY.length, ContentType: "image/jpeg", ETag: '"abc"', ChecksumSHA256: SHA };

describe("confirmUploadedObject — finalize verification", () => {
  afterEach(() => mock.restoreAll());

  it("accepts an object whose size, checksum and type all match, and asks storage for the checksum", async () => {
    const storage = fakeStorage(GOOD_HEAD);
    const head = await confirmUploadedObject(INTENT, OPTIONS);
    assert.equal(head.byteSize, BODY.length);
    assert.equal(head.checksumSha256, SHA);
    assert.equal(storage.heads()[0]?.input.ChecksumMode, "ENABLED");
    assert.equal(storage.deletes().length, 0);
  });

  const mismatches: [string, FakeHead][] = [
    ["a different size", { ...GOOD_HEAD, ContentLength: BODY.length + 1 }],
    ["a different checksum", { ...GOOD_HEAD, ChecksumSHA256: OTHER_SHA }],
    ["no checksum at all (a gateway that ignored it)", { ...GOOD_HEAD, ChecksumSHA256: undefined }],
    ["a composite multipart checksum", { ...GOOD_HEAD, ChecksumSHA256: `${SHA}-2` }],
    ["a different content type", { ...GOOD_HEAD, ContentType: "text/html" }]
  ];

  for (const [what, head] of mismatches) {
    it(`refuses and DELETES an object with ${what}`, async () => {
      const storage = fakeStorage(head);
      await assert.rejects(confirmUploadedObject(INTENT, OPTIONS), badRequest);
      assert.equal(storage.deletes().length, 1);
      assert.equal(storage.deletes()[0]?.input.Key, KEY);
    });
  }

  it("refuses an object that never landed, without trying to delete it", async () => {
    const storage = fakeStorage(null);
    await assert.rejects(confirmUploadedObject(INTENT, OPTIONS), badRequest);
    assert.equal(storage.deletes().length, 0);
  });

  it("landedObjectProblem names the mismatch in a sentence", () => {
    const base = { byteSize: BODY.length, contentType: "image/jpeg", etag: null, checksumSha256: SHA };
    assert.equal(landedObjectProblem(INTENT, base), null);
    assert.match(landedObjectProblem(INTENT, { ...base, byteSize: 1 }) ?? "", /signed for/);
    assert.match(landedObjectProblem(INTENT, { ...base, checksumSha256: null }) ?? "", /fingerprint/);
  });
});
