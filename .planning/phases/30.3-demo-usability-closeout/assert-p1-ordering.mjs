// Machine-check: in the committed runbook, every LOCAL prerequisite in P1 must
// appear strictly before the FIRST production-mutating command. Only lines inside
// fenced code blocks count as commands — prose that merely names a command does not.
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const lines = readFileSync(path, 'utf8').split('\n');

const start = lines.findIndex((l) => l.startsWith('- [ ] P1.'));
const end = lines.findIndex((l, i) => i > start && l.startsWith('- [ ] P2.'));
if (start < 0 || end < 0) {
  console.error('FATAL: could not locate the P1 block');
  process.exit(1);
}

// Collect executable lines (inside ``` fences) within P1, with 1-based line numbers.
const cmds = [];
let inFence = false;
for (let i = start; i < end; i++) {
  const t = lines[i].trim();
  if (t.startsWith('```')) {
    inFence = !inFence;
    continue;
  }
  if (inFence) cmds.push({ n: i + 1, text: lines[i] });
}

const MUTATORS = [
  ['gcloud run deploy', /gcloud run deploy\b/],
  ['gcloud run services update-traffic', /gcloud run services update-traffic\b/],
  ['firebase deploy', /firebase deploy\b/],
];
const PREREQS = [
  ['frozen dependency installation', /pnpm install --frozen-lockfile/],
  ['web env transfer', /cp .*apps\/web\/\.env\.production/],
  ['api env transfer', /cp .*apps\/api\/\.env\b/],
  ['effective API-env validation (runs it)', /cd apps\/api && pnpm exec tsx gate6-env-preflight\.ts/],
  ['web build', /pnpm --filter @smash-tracker\/web build/],
  ['prerender', /pnpm --filter @smash-tracker\/web prerender/],
  ['API image build + push', /docker buildx build .*--push/],
];

const firstOf = (pats) => {
  for (const c of cmds) for (const [name, re] of pats) if (re.test(c.text)) return { name, n: c.n };
  return null;
};

const firstMutation = firstOf(MUTATORS);
if (!firstMutation) {
  console.error('FATAL: found no production-mutating command in P1 — the check would pass vacuously');
  process.exit(1);
}
console.log(`first production mutation: line ${firstMutation.n}  (${firstMutation.name})`);

let ok = true;
for (const [name, re] of PREREQS) {
  const hit = cmds.find((c) => re.test(c.text));
  if (!hit) {
    console.error(`FATAL: prerequisite not found in any P1 code block: ${name}`);
    ok = false;
    continue;
  }
  const rel = hit.n < firstMutation.n ? 'BEFORE' : 'AFTER';
  console.log(`  line ${String(hit.n).padStart(4)}  ${rel.padEnd(6)} first mutation  — ${name}`);
  if (rel !== 'BEFORE') ok = false;
}

// No mutator may appear before the last prerequisite either.
const lastPrereqLine = Math.max(
  ...PREREQS.map(([, re]) => {
    const hit = cmds.find((c) => re.test(c.text));
    return hit ? hit.n : -1;
  }),
);
if (firstMutation.n < lastPrereqLine) {
  console.error(`FATAL: a mutation at line ${firstMutation.n} precedes a prerequisite at line ${lastPrereqLine}`);
  ok = false;
}

console.log(
  ok
    ? 'OK: all local prerequisites and both deployable artifacts precede the first production mutation'
    : 'FAILED: P1 ordering is wrong',
);
process.exit(ok ? 0 : 1);
