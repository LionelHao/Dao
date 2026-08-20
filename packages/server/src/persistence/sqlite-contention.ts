export function isTransientSQLiteContention(error: unknown): boolean {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return false;
  }
  const record = error as Record<string, unknown>;
  const errcode = record.errcode;
  if (
    record.code !== "ERR_SQLITE_ERROR" ||
    !Number.isSafeInteger(errcode)
  ) {
    return false;
  }
  const primaryCode = Number(errcode) & 0xff;
  if (primaryCode !== 5 && primaryCode !== 6) {
    return false;
  }
  return record.errstr === "database is locked" ||
    record.errstr === "database table is locked" ||
    record.errstr === "database schema is locked";
}
