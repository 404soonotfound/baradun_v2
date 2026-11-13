import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

it("tools/beaches만 바뀌어도 beaches 작업과 외부 원자료 없는 회귀가 실행됨", () => {
  const ci = readFileSync(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const filters = readFileSync(
    new URL("../../../.github/ci-filters.yml", import.meta.url),
    "utf8",
  );
  const beachesFilter = filters.match(
    /^beaches:[^\n]*\n((?:  - [^\n]*\n)+)/m,
  )?.[1];
  expect(beachesFilter).toMatch(/^  - (['"])tools\/beaches\/\*\*\1\s*$/m);
  expect(ci).toContain("filters: .github/ci-filters.yml");
  const job = ci.split("\n  beaches:\n")[1].split("\n  # 결과 모음")[0];
  expect(job).toContain("if: needs.changes.outputs.beaches == 'true'");
  expect(job).toContain("- run: npm run test:beaches");
  const pkg = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  expect(pkg.scripts["test:beaches"]).toBe("vitest run --root tools/beaches");
  expect(pkg.scripts.test).toContain("npm run test:beaches");
});
