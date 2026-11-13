import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

it("tools/agy-review만 바뀌어도 판정 회귀 검사가 CI에서 돌고 ci-ok에 모임", () => {
  const ci = readFileSync(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const filters = readFileSync(
    new URL("../../../.github/ci-filters.yml", import.meta.url),
    "utf8",
  );
  const filter = filters.match(/^agy_review:[^\n]*\n((?:  - [^\n]*\n)+)/m)?.[1];
  expect(filter).toMatch(/^  - (['"])tools\/agy-review\/\*\*\1\s*$/m);
  expect(ci).toContain("filters: .github/ci-filters.yml");
  expect(ci).toContain("agy_review: ${{ steps.filter.outputs.agy_review }}");
  const job = ci.split("\n  agy-review:\n")[1].split("\n\n")[0];
  expect(job).toContain("if: needs.changes.outputs.agy_review == 'true'");
  expect(job).toContain("- run: npm run test:agy-review");
  expect(ci).toMatch(/needs: \[[^\]]*\bagy-review\b[^\]]*\]/);
  const pkg = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  expect(pkg.scripts["test:agy-review"]).toBe(
    "vitest run --root tools/agy-review",
  );
  expect(pkg.scripts.test).toContain("npm run test:agy-review");
});
