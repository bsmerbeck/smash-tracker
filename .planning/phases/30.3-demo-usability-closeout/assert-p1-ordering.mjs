// Machine-check: in the committed runbook, every prerequisite in P1 must appear
// strictly before the FIRST serving-production mutation. Only lines inside fenced
// code blocks count as commands — prose that merely names a command does not.
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
  ['effective API-env validation (runs it)', /gate6-env-preflight\.ts/],
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
  console.error('FATAL: found no serving-production mutation in P1 — the check would pass vacuously');
  process.exit(1);
}
console.log(`first serving-production mutation: line ${firstMutation.n}  (${firstMutation.name})`);

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

// Lock the fail-closed mechanics that make the written operator safe when a
// person or autonomous runner pastes one fenced block at a time. Printing a
// failure is not a gate: every saved status must end in an executable assertion.
const allExecutableLines = [];
let inAnyFence = false;
for (const line of lines) {
  const t = line.trim();
  if (t.startsWith('```')) {
    inAnyFence = !inAnyFence;
    continue;
  }
  if (inAnyFence) allExecutableLines.push(line);
}
const executableWhole = allExecutableLines.join('\n');
const shellExecutableWhole = allExecutableLines
  .filter((line) => !line.trim().startsWith('#') && !line.trim().startsWith('//'))
  .join('\n');
const REQUIRED_FAIL_CLOSED = [
  ['independently approved SHA terminal gate', /test "\$SHA_BINDING_STATUS" -eq 0/],
  ['web environment terminal gate', /test "\$WEB_PREFLIGHT_STATUS" -eq 0/],
  ['detached-worktree terminal gate', /test "\$DETACHED_STATUS" -eq 0/],
  ['production web project binding', /"\$WEB_PROJECT_ID" != "smash-tracker-f97b7"/],
  ['production web auth-domain binding', /"\$WEB_AUTH_DOMAIN" != "grandfinals\.gg"/],
  ['API environment terminal gate', /test "\$API_PREFLIGHT_STATUS" -eq 0/],
  ['dirty-worktree executable failure', /if \[ -n "\$WORKTREE_STATUS" \]; then[\s\S]*?\n\s*false\n/],
  [
    'build-to-prerender success chain',
    /pnpm --filter @smash-tracker\/web build && \\\n\s*pnpm --filter @smash-tracker\/web prerender/,
  ],
  ['image build terminal gate', /test "\$IMAGE_BUILD_STATUS" -eq 0/],
  ['candidate deploy with unique revision suffix', /gcloud run deploy[\s\S]*?--revision-suffix/],
  ['candidate deploy with no traffic', /gcloud run deploy[\s\S]*?--no-traffic/],
  [
    'exact candidate readiness assertion',
    /gcloud run revisions describe "\$EXPECTED_DEPLOYED_REVISION"[\s\S]*?assert-cloud-run-revision-ready\.mjs/,
  ],
  ['traffic terminal gate', /test "\$TRAFFIC_STATUS" -eq 0/],
  ['P3 baseline terminal gate', /test "\$P3_BASELINE_STATUS" -eq 0/],
  [
    'failed-baseline recovery cannot move a passing baseline',
    /if \[ "\$\{P3_BASELINE_STATUS:-0\}" -eq 0 \]; then[\s\S]*?failed-record recovery must not move a valid baseline[\s\S]*?\n\s*false\n/,
  ],
  [
    'failed-baseline recovery preserves baseline and receipt with one stamp',
    /FAILED_STAMP=.*[\s\S]*?FAILED_BASELINE=.*\$\{FAILED_STAMP\}[\s\S]*?FAILED_RECEIPT=.*\$\{FAILED_STAMP\}/,
  ],
  [
    'failed-baseline recovery propagates baseline move failure',
    /mv \.\/apps\/api\/gate6-baseline\.json "\$FAILED_BASELINE" \|\| P3_RECOVERY_STATUS=\$\?/,
  ],
  [
    'failed-baseline recovery propagates receipt move failure',
    /mv \.\/apps\/api\/gate6-baseline-record-receipt\.json "\$FAILED_RECEIPT" \|\| P3_RECOVERY_STATUS=\$\?/,
  ],
  [
    'failed-baseline recovery verifies live paths are clear',
    /if \[ -e \.\/apps\/api\/gate6-baseline\.json \] \|\| \[ -e \.\/apps\/api\/gate6-baseline-record-receipt\.json \]; then/,
  ],
  ['failed-baseline recovery terminal gate', /test "\$P3_RECOVERY_STATUS" -eq 0/],
  ['P4 apply terminal gate', /test "\$HBOX_APPLY_STATUS" -eq 0/],
  ['P4 compare terminal gate', /test "\$HBOX_COMPARE_STATUS" -eq 0/],
  ['P5 probe terminal gate', /test "\$HBOX_PROBE_STATUS" -eq 0/],
  ['P6 refreshed-compare terminal gate', /test "\$HBOX_REFRESH_COMPARE_STATUS" -eq 0/],
  ['P7 final-audit terminal gate', /test "\$FINAL_GATE6_AUDIT_STATUS" -eq 0/],
  ['filtered-command receipt directory', /mkdir -p \.\/apps\/api\/receipts/],
  ['token header fed through stdin', /print -r -- "Authorization: Bearer \$GATE6_DEMO_ID_TOKEN"[\s\S]*?-H @-/],
];
for (const [name, re] of REQUIRED_FAIL_CLOSED) {
  if (!re.test(executableWhole)) {
    console.error(`FATAL: fail-closed runbook guard missing: ${name}`);
    ok = false;
  } else {
    console.log(`  present                         — ${name}`);
  }
}

const forbidden = [
  ['failure masked by || echo', /\|\|\s*echo\s+["']FATAL/],
  ['operator exit code masked by echo', /echo\s+["']exit=\$\?["']/],
  ['receipt directory at repository root', /mkdir -p \.\/receipts(?:\s|$)/],
  [
    'bearer token expanded into curl argv',
    /curl[^\n]*-H\s+["']Authorization: Bearer \$GATE6_DEMO_ID_TOKEN["']/,
  ],
  ['temporary program created by shell heredoc', /cat\s+>\s+.*(?:\.mjs|\.ts)/],
  ['mutable latest-revision pointer used by an executable command', /--format=.*status\.latest(?:Created|Ready)RevisionName/],
];
for (const [name, re] of forbidden) {
  if (re.test(shellExecutableWhole)) {
    console.error(`FATAL: forbidden fail-open runbook pattern found: ${name}`);
    ok = false;
  }
}

// The traffic mutation must sit inside the exact-candidate readiness guard.
// This is deliberately structural rather than prose-based: an unready named
// revision must never reach update-traffic, even if printed output is ignored.
const guardLine = lines.findIndex((line) =>
  line.includes('if [ "$REVISION_READY_STATUS" -eq 0 ]; then'),
);
const trafficMutationLine = lines.findIndex((line) => line.includes('gcloud run services update-traffic'));
const trafficElseLine = lines.findIndex(
  (line, index) => index > trafficMutationLine && line.trim() === 'else',
);
if (
  guardLine < 0 ||
  trafficMutationLine < 0 ||
  trafficElseLine < 0 ||
  !(guardLine < trafficMutationLine && trafficMutationLine < trafficElseLine)
) {
  console.error('FATAL: update-traffic is not enclosed by the exact-candidate readiness guard');
  ok = false;
} else {
  console.log(
    `  lines ${guardLine + 1}-${trafficElseLine + 1}                  — update-traffic enclosed by exact readiness guard`,
  );
}

console.log(
  ok
    ? 'OK: ordering and fail-closed operator guards are present'
    : 'FAILED: runbook ordering or fail-closed guards are wrong',
);
process.exit(ok ? 0 : 1);
