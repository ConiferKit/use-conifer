#!/usr/bin/env node
// check-changelog.mjs — structural gate on CHANGELOG.md.
//
// A changelog is worth something only if a reader can trust it, and the way
// changelogs stop being trustworthy is gradual: a release ships without an
// entry, then an entry gets written from `git log` after the fact, then the
// entries are filler nobody reads and nobody would miss. Every rule below is
// mechanical on purpose — this script cannot judge whether an entry is USEFUL,
// only whether it is STRUCTURALLY honest. Reviewers own the judgement.
//
// Checked here:
//   1. The released version in package.json has a section.
//   2. That section is dated, and the date is not in the future.
//   3. An [Unreleased] section exists, so there is somewhere to write.
//   4. Versions are unique and ordered newest-first.
//   5. Only Keep a Changelog category headings are used.
//   6. Every category has at least one entry (no empty "### Added").
//   7. Link references resolve for every version mentioned.
//   8. ANTI-SLOP: entries are prose, not commit subjects. An entry that is a
//      bare conventional-commit line ("feat: add x"), or a git SHA, or which
//      names a file path with no explanation, is rejected — those are the
//      shapes a generated changelog takes when nobody is paying attention.
//
// Run: node scripts/check-changelog.mjs   (exits non-zero with a reason)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const changelog = readFileSync(fileURLToPath(new URL("CHANGELOG.md", root)), "utf8");
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("package.json", root)), "utf8"));

const problems = [];
const fail = (msg) => problems.push(msg);

const KEEP_A_CHANGELOG_CATEGORIES = new Set([
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
]);

// ---------------------------------------------------------------- structure

const lines = changelog.split("\n");

// Section headings: "## [1.2.3] - 2026-08-27" or "## [Unreleased]".
const sections = [];
lines.forEach((line, i) => {
  const m = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(line);
  if (m) sections.push({ version: m[1], date: m[2], line: i });
});

if (sections.length === 0) fail("CHANGELOG.md has no '## [version]' sections at all.");

const unreleased = sections.find((s) => s.version.toLowerCase() === "unreleased");
if (!unreleased) {
  fail(
    "no '## [Unreleased]' section — without one there is nowhere to record a change " +
      "before it ships, which is how changelogs start being written after the fact.",
  );
}

const released = sections.filter((s) => s.version.toLowerCase() !== "unreleased");

// 1. The shipped version must be described.
const current = released.find((s) => s.version === pkg.version);
if (!current) {
  fail(
    `package.json is ${pkg.version} but CHANGELOG.md has no '## [${pkg.version}]' section. ` +
      "A release nobody can read about is a release nobody can safely upgrade to.",
  );
}

// 2. Dates: present, ISO, not in the future.
const today = new Date().toISOString().slice(0, 10);
for (const s of released) {
  if (!s.date) {
    fail(`'## [${s.version}]' has no date. Use 'YYYY-MM-DD'.`);
    continue;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date)) {
    fail(`'## [${s.version}]' has date '${s.date}'; expected YYYY-MM-DD.`);
    continue;
  }
  if (s.date > today) {
    fail(`'## [${s.version}]' is dated ${s.date}, which is in the future (today is ${today}).`);
  }
}

// 4. Unique, and newest-first.
const seen = new Set();
for (const s of released) {
  if (seen.has(s.version)) fail(`version ${s.version} appears more than once.`);
  seen.add(s.version);
}

const semver = (v) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
const cmp = (a, b) => {
  const A = semver(a);
  const B = semver(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
};
for (let i = 1; i < released.length; i++) {
  if (cmp(released[i - 1].version, released[i].version) < 0) {
    fail(
      `versions are out of order: ${released[i - 1].version} is listed above ` +
        `${released[i].version}. Newest first.`,
    );
  }
}

// 5 + 6. Categories are known, and none is empty.
const boundaries = [...sections.map((s) => s.line), lines.length];
sections.forEach((section, idx) => {
  const body = lines.slice(section.line + 1, boundaries[idx + 1]);
  let category = null;
  let entriesInCategory = 0;

  const closeCategory = () => {
    if (category && entriesInCategory === 0) {
      fail(`'### ${category}' under [${section.version}] has no entries. Remove it or fill it.`);
    }
  };

  for (const line of body) {
    const heading = /^### (.+?)\s*$/.exec(line);
    if (heading) {
      closeCategory();
      category = heading[1];
      entriesInCategory = 0;
      if (!KEEP_A_CHANGELOG_CATEGORIES.has(category)) {
        fail(
          `'### ${category}' under [${section.version}] is not a Keep a Changelog category ` +
            `(${[...KEEP_A_CHANGELOG_CATEGORIES].join(", ")}).`,
        );
      }
      continue;
    }
    if (/^\s*-\s+\S/.test(line)) {
      entriesInCategory++;

      // 8. ANTI-SLOP.
      const entry = line.replace(/^\s*-\s+/, "").trim();
      const plain = entry.replace(/[*`_[\]]/g, "");

      if (/^(feat|fix|chore|docs|refactor|test|build|ci|perf|style)(\([^)]*\))?!?:/i.test(plain)) {
        fail(
          `[${section.version}] entry is a raw commit subject, not a changelog entry: "${entry}". ` +
            "Say what changed for a caller.",
        );
      }
      if (/\b[0-9a-f]{7,40}\b/.test(plain) && !/\b\d+\.\d+\.\d+\b/.test(plain)) {
        fail(
          `[${section.version}] entry cites a commit SHA: "${entry}". ` +
            "A reader cannot resolve a SHA; describe the change.",
        );
      }
      if (plain.length < 20) {
        fail(
          `[${section.version}] entry is too short to be informative: "${entry}".`,
        );
      }
      if (/^(update|updated|bump|misc|various|cleanup|improvements?)\b/i.test(plain)) {
        fail(
          `[${section.version}] entry says nothing: "${entry}". ` +
            "Name what changed and why a caller would care.",
        );
      }
    }
  }
  closeCategory();

  // A released section with no categories at all is a stub.
  if (section.version.toLowerCase() !== "unreleased") {
    const hasCategory = body.some((l) => /^### /.test(l));
    const hasProse = body.some((l) => /\w{20,}/.test(l));
    if (!hasCategory && !hasProse) {
      fail(`'## [${section.version}]' is an empty stub.`);
    }
  }
});

// 7. Link references resolve.
const refs = new Set();
for (const line of lines) {
  const m = /^\[([^\]]+)\]:\s*\S+/.exec(line);
  if (m) refs.add(m[1]);
}
for (const s of sections) {
  if (!refs.has(s.version)) {
    fail(`'## [${s.version}]' has no link reference '[${s.version}]: <url>' at the bottom.`);
  }
}

// ------------------------------------------------------------------ verdict

if (problems.length > 0) {
  console.error("CHANGELOG.md does not pass:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nSee the header of scripts/check-changelog.mjs for what each rule is protecting.",
  );
  process.exit(1);
}

console.log(
  `CHANGELOG.md ok — ${released.length} released version(s), ` +
    `current ${pkg.version} documented.`,
);
