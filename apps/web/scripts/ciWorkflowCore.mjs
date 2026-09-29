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
