import type { DatabaseSync } from "node:sqlite";
import {
  isAuthorityTransactionView,
  mintAuthorityTransactionView,
  type AuthorityTransactionView,
} from "../room-governance/private-participant-contracts.js";

interface AuthorityTransactionDatabaseBinding {
  readonly database: DatabaseSync;
  active: boolean;
}

const transactionDatabases = new WeakMap<object, AuthorityTransactionDatabaseBinding>();

export function mintDatabaseAuthorityTransactionView(
  database: DatabaseSync,
  roomId: string,
  transactionId: string,
): AuthorityTransactionView {
  const view = mintAuthorityTransactionView(roomId, transactionId);
  transactionDatabases.set(view, { database, active: true });
  return view;
}

export function releaseDatabaseAuthorityTransactionView(
  transaction: AuthorityTransactionView,
): void {
  const binding = transactionDatabases.get(transaction);
  if (binding !== undefined) {
    binding.active = false;
    transactionDatabases.delete(transaction);
  }
}

export function useAuthorityTransactionDatabase<TResult>(
  transaction: AuthorityTransactionView,
  operation: (database: DatabaseSync) => TResult,
): TResult {
  if (!isAuthorityTransactionView(transaction)) {
    throw new TypeError("Authority transaction capability is invalid");
  }
  const binding = transactionDatabases.get(transaction);
  if (binding === undefined || !binding.active) {
    throw new TypeError("Authority transaction database capability is unavailable");
  }
  return operation(binding.database);
}
