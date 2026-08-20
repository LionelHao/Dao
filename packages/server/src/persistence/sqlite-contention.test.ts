import { describe, expect, it } from "vitest";
import { isTransientSQLiteContention } from "./sqlite-contention.js";

describe("SQLite contention classification", () => {
  it.each([
    [5, "database is locked"],
    [6, "database table is locked"],
    [261, "database is locked"],
    [262, "database table is locked"],
    [517, "database is locked"],
  ])("accepts bounded busy/locked code %s", (errcode, errstr) => {
    expect(isTransientSQLiteContention({
      code: "ERR_SQLITE_ERROR",
      errcode,
      errstr,
    })).toBe(true);
  });

  it.each([
    new Error("database is locked"),
    { code: "ERR_SQLITE_ERROR", errcode: 11, errstr: "database disk image is malformed" },
    { code: "ERR_SQLITE_ERROR", errcode: 5, errstr: "not a database" },
    { code: "EIO", errcode: 5, errstr: "database is locked" },
    { code: "ERR_SQLITE_ERROR", errcode: "5", errstr: "database is locked" },
    null,
  ])("rejects non-contention storage failure %#", (error) => {
    expect(isTransientSQLiteContention(error)).toBe(false);
  });
});
