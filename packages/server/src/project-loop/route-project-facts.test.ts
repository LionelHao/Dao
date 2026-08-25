import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readProjectRouteFactsInTransaction } from "./route-project-facts.js";

describe("FT-09 proactive route Project facts", () => {
  it("exposes only current active Goal and Project revisions", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE rooms (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE project_room_states (room_id TEXT PRIMARY KEY, revision INTEGER);
        CREATE TABLE project_goals (room_id TEXT, revision INTEGER, status TEXT);
        INSERT INTO rooms VALUES ('room-1', 'active'), ('room-2', 'archived');
        INSERT INTO project_room_states VALUES ('room-1', 7), ('room-2', 4);
        INSERT INTO project_goals VALUES ('room-1', 3, 'active'), ('room-2', 2, 'active');
      `);
      expect(readProjectRouteFactsInTransaction(database, "room-1")).toEqual({
        status: "ready", goalRevision: 3, projectRevision: 7,
      });
      expect(readProjectRouteFactsInTransaction(database, "room-2"))
        .toEqual({ status: "dependency_unavailable" });
      expect(readProjectRouteFactsInTransaction(database, "missing"))
        .toEqual({ status: "dependency_unavailable" });
    } finally { database.close(); }
  });

  it("fails closed for corrupt revisions", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE rooms (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE project_room_states (room_id TEXT PRIMARY KEY, revision INTEGER);
        CREATE TABLE project_goals (room_id TEXT, revision INTEGER, status TEXT);
        INSERT INTO rooms VALUES ('room-1', 'active');
        INSERT INTO project_room_states VALUES ('room-1', 0);
        INSERT INTO project_goals VALUES ('room-1', 1, 'active');
      `);
      expect(() => readProjectRouteFactsInTransaction(database, "room-1"))
        .toThrow("corrupt");
    } finally { database.close(); }
  });
});
