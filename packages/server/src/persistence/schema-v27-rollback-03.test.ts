import { AUTHORITY_V27_STATEMENT_COUNT_FOR_TEST } from "./schema.js";
import { defineV27RollbackRangeTest } from "./schema-v27-rollback-test-suite.js";

defineV27RollbackRangeTest(51, AUTHORITY_V27_STATEMENT_COUNT_FOR_TEST);
