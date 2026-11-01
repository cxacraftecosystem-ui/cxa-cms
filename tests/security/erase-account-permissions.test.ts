import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canEraseAccount, canManageStudioAccess, canManageUser, type PermissionSubject } from "@/lib/permissions";

/**
 * Who may delete an account permanently (lib/auth/erase-account.ts). The screen and the route both ask
 * `canEraseAccount`, so these cases are the whole rule outside the counts the service takes in SQL.
 */

const master: PermissionSubject = { id: "m1", role: "MASTER_ADMIN" };
const otherMaster: PermissionSubject = { id: "m2", role: "MASTER_ADMIN" };
const admin: PermissionSubject = { id: "a1", role: "ADMINISTRATOR" };
const editor: PermissionSubject = { id: "e1", role: "EDITOR" };

describe("canEraseAccount", () => {
  it("lets a master administrator delete an administrator, another master admin, or anybody below", () => {
    assert.equal(canEraseAccount(master, admin), true);
    assert.equal(canEraseAccount(master, otherMaster), true);
    assert.equal(canEraseAccount(master, editor), true);
  });

  it("never lets anybody delete their own account", () => {
    assert.equal(canEraseAccount(master, { id: master.id }), false);
  });

  it("refuses everybody who is not a master administrator, administrators included", () => {
    assert.equal(canEraseAccount(admin, editor), false);
    assert.equal(canEraseAccount(admin, otherMaster), false);
    assert.equal(canEraseAccount(editor, { id: "x" }), false);
    assert.equal(canEraseAccount(null, admin), false);
    assert.equal(canEraseAccount(undefined, admin), false);
  });

  it("leaves the older rules exactly as they were", () => {
    // Switching off stays strictly-below; the access console stays master-only.
    assert.equal(canManageUser(master, otherMaster), false);
    assert.equal(canManageUser(master, admin), true);
    assert.equal(canManageUser(admin, admin), false);
    assert.equal(canManageStudioAccess(master), true);
    assert.equal(canManageStudioAccess(admin), false);
  });
});
