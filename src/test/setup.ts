// Test setup.
//
// Unmounts everything React rendered after each test. Without it the previous
// test's table is still in the document, and a query for "every row in the
// body" quietly returns two tables' worth -- which is the kind of failure that
// makes a suite look flaky rather than wrong.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
