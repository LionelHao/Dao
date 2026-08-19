import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { mintAuthorityTransactionView } from "../room-governance/private-participant-contracts.js";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
  useAuthorityTransactionDatabase,
} from "./authority-transaction-database.js";

describe("Authority transaction database capability", () => {
  it("runs feature-local SQL on the bound worker transaction connection", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("CREATE TABLE proof (value TEXT NOT NULL); BEGIN IMMEDIATE");
      const transaction = mintDatabaseAuthorityTransactionView(
        database,
        "room-1",
        "transaction-1",
      );
      useAuthorityTransactionDatabase(transaction, (boundDatabase) => {
        expect(boundDatabase).toBe(database);
        boundDatabase.prepare("INSERT INTO proof (value) VALUES (?)").run("same-writer");
      });
      releaseDatabaseAuthorityTransactionView(transaction);
      database.exec("COMMIT");
      expect(database.prepare("SELECT value FROM proof").get()).toEqual({ value: "same-writer" });
      expect(() => useAuthorityTransactionDatabase(transaction, () => undefined)).toThrow(
        "database capability is unavailable",
      );
    } finally {
      database.close();
    }
  });

  it("rejects an unbound or reconstructed transaction view", () => {
    const unbound = mintAuthorityTransactionView("room-1", "transaction-1");
    expect(() => useAuthorityTransactionDatabase(unbound, () => undefined)).toThrow(
      "database capability is unavailable",
    );
    expect(() => useAuthorityTransactionDatabase(
      JSON.parse(JSON.stringify(unbound)),
      () => undefined,
    )).toThrow("transaction capability is invalid");
  });
});
