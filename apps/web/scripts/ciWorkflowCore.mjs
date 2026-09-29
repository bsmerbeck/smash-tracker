/**
 * Line-based reader for this repo's `.github/workflows/ci.yml` format, used by
 * the CI pin tests (`ciChartBundleGuard.test.mjs`, `ciTestSharding.test.mjs`).
 *
 * Deliberately no YAML dependency: the pnpm-strict `apps/web` package cannot
 * resolve `yaml`, and the workflow follows a fixed shape (two-space job
 * headers, single-line `run:` values, inline `[a, b]` lists) that the pins
 * themselves enforce. A structural rewrite makes the reader throw rather than
 * pass on empty input.
 */

const JOB_HEADER = /^ {2}([A-Za-z0-9_-]+):\s*$/;

const CHART_GUARD_RE = /^pnpm --filter @smash-tracker\/web (run )?guard:chart-bundle$/;

/** Returns a Map of job id -> that job's lines (header excluded). */
export function workflowJobs(text) {
  const lines = text.split('\n');
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) throw new Error('workflow has no column-0 `jobs:` key');
  const jobs = new Map();
  let current = null;
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    const header = JOB_HEADER.exec(line);
    if (header) {
      current = [];
      jobs.set(header[1], current);
    } else if (current) {
      current.push(line);
    }
  }
  if (jobs.size === 0) throw new Error('workflow `jobs:` has no job headers');
  return jobs;
}

/** Trimmed `run:` values in order; a block scalar `run: |` is returned as `|`. */
export function runCommands(lines) {
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim().replace(/^- /, '');
    if (trimmed.startsWith('run:')) out.push(trimmed.slice('run:'.length).trim());
  }
  return out;
}

/** Items of the first `<key>: [a, b]` line, or null when there is none. */
export function inlineList(lines, key) {
  for (const line of lines) {
    const match = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`).exec(line.trim());
    if (match) {
      return match[1]
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
    }
  }
  return null;
}

/** Violation strings for the chart-bundle guard placement; [] means OK. */
export function checkChartBundleGuard(text) {
  const jobs = workflowJobs(text);
  for (const lines of jobs.values()) {
    const runs = runCommands(lines);
    const guardAt = runs.findIndex((cmd) => CHART_GUARD_RE.test(cmd));
    if (guardAt === -1) continue;
    const buildAt = runs.indexOf('pnpm build');
    if (buildAt === -1) {
      return [
        'CHART_BUILD_MISSING: the job that runs the chart-bundle guard has no `pnpm build` run line',
      ];
    }
    if (buildAt > guardAt) {
      return ['CHART_GUARD_ORDER: `pnpm build` must come before the chart-bundle guard'];
    }
    return [];
  }
  return ['CHART_GUARD_MISSING: no job runs `pnpm --filter @smash-tracker/web guard:chart-bundle`'];
}

const SHARD_ARGS = '--shard=${{ matrix.shard }}/${{ strategy.job-total }}';
const SHARDED_PACKAGES = ['web', 'api'];
const SHARED_BUILD_CMD = 'pnpm --filter @smash-tracker/shared build';
const GATE_JOB = 'build-and-test';
/** Whole-suite commands that would run a sharded suite a second time. */
const UNSHARDED_COMMANDS = [
  'pnpm test',
  'pnpm -r test',
  'pnpm --filter @smash-tracker/web test',
  'pnpm --filter @smash-tracker/api test',
];
/** Suites that are not sharded and must appear in exactly one run line. */
const RUN_ONCE_COMMANDS = [
  /^pnpm --filter @smash-tracker\/shared test$/,
  /^pnpm --filter @smash-tracker\/web (run )?test:guards$/,
];

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** Direct child keys of the job's `matrix:` line, found by indentation. */
function matrixKeys(lines) {
  const at = lines.findIndex((line) => line.trim() === 'matrix:');
  if (at === -1) return [];
  const base = indentOf(lines[at]);
  const keys = [];
  let childIndent = null;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = indentOf(line);
    if (indent <= base) break;
    if (childIndent === null) childIndent = indent;
    if (indent === childIndent) keys.push(line.trim().split(':')[0]);
  }
  return keys;
}

/** Violation strings for the CI test-sharding and gate invariants; [] means OK. */
export function checkTestSharding(text) {
  const jobs = workflowJobs(text);
  const violations = [];
  const allRuns = [];
  for (const lines of jobs.values()) allRuns.push(...runCommands(lines));

  for (const pkg of SHARDED_PACKAGES) {
    const cmd = `pnpm --filter @smash-tracker/${pkg} exec vitest run ${SHARD_ARGS}`;
    const holders = [...jobs].filter(([, lines]) => runCommands(lines).includes(cmd));
    const occurrences = allRuns.filter((run) => run === cmd).length;
    if (holders.length !== 1 || occurrences !== 1) {
      violations.push(
        `SHARD_CMD:${pkg} expected exactly one run line \`${cmd}\`, got ${occurrences}`,
      );
    }
    if (holders.length === 0) continue;
    for (const [job, lines] of holders) {
      const shards = (inlineList(lines, 'shard') ?? []).map(Number);
      const contiguous = shards.length >= 2 && shards.every((value, index) => value === index + 1);
      if (!contiguous) {
        violations.push(
          `SHARD_MATRIX_NOT_CONTIGUOUS:${job} shard list must be exactly 1..K with K >= 2, got [${shards.join(', ')}]`,
        );
      }
      const keys = matrixKeys(lines);
      if (keys.length !== 1 || keys[0] !== 'shard') {
        violations.push(
          `SHARD_MATRIX_EXTRA_KEY:${job} matrix must have the single key \`shard\`, got [${keys.join(', ')}]`,
        );
      }
      if (!lines.some((line) => line.trim() === 'fail-fast: false')) {
        violations.push(`SHARD_FAIL_FAST:${job} the shard job must set \`fail-fast: false\``);
      }
      const runs = runCommands(lines);
      const buildAt = runs.indexOf(SHARED_BUILD_CMD);
      if (buildAt === -1 || buildAt > runs.indexOf(cmd)) {
        violations.push(
          `SHARD_SHARED_BUILD:${job} \`${SHARED_BUILD_CMD}\` must run before the shard command`,
        );
      }
    }
  }

  for (const cmd of UNSHARDED_COMMANDS) {
    if (allRuns.includes(cmd)) {
      violations.push(`UNSHARDED_SUITE:${cmd} would run a sharded suite a second time`);
    }
  }

  for (const pattern of RUN_ONCE_COMMANDS) {
    const matches = allRuns.filter((run) => pattern.test(run));
    if (matches.length !== 1) {
      violations.push(
        `RUN_ONCE:${matches[0] ?? pattern.source} must appear exactly once, found ${matches.length}`,
      );
    }
  }

  const gate = jobs.get(GATE_JOB);
  if (!gate) {
    violations.push(`GATE_MISSING: no \`${GATE_JOB}\` aggregate job`);
    return violations;
  }
  if (!gate.some((line) => ['if: always()', 'if: ${{ always() }}'].includes(line.trim()))) {
    violations.push(`GATE_ALWAYS:${GATE_JOB} must run under \`if: always()\``);
  }
  const needs = new Set(inlineList(gate, 'needs') ?? []);
  const expected = new Set([...jobs.keys()].filter((id) => id !== GATE_JOB));
  const missing = [...expected].filter((id) => !needs.has(id));
  const extra = [...needs].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0) {
    violations.push(
      `GATE_NEEDS:${[...missing, ...extra].join(',')} needs must equal every other job (missing: [${missing.join(', ')}], extra: [${extra.join(', ')}])`,
    );
  }
  return violations;
}
