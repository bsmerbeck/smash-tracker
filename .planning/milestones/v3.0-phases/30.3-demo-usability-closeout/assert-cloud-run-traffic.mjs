let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  const expected = process.env.EXPECTED_REVISION;
  if (!expected) {
    console.error('FATAL: EXPECTED_REVISION is empty — nothing to assert against');
    process.exit(1);
  }

  let service;
  try {
    service = JSON.parse(raw);
  } catch {
    console.error('FATAL: gcloud did not return parseable JSON');
    process.exit(1);
  }

  const traffic = service?.status?.traffic;
  if (!Array.isArray(traffic) || traffic.length === 0) {
    console.error('FATAL: status.traffic is absent or empty');
    process.exit(1);
  }

  for (const target of traffic) {
    console.log(
      `  traffic: revision=${target.revisionName || '(unnamed)'} percent=${target.percent || 0}` +
        (target.tag ? ` tag=${target.tag}` : ''),
    );
  }

  const serving = traffic.filter((target) => Number(target.percent) > 0);
  const total = traffic.reduce((sum, target) => sum + (Number(target.percent) || 0), 0);
  const problems = [];
  if (serving.length !== 1) {
    problems.push(`expected exactly 1 serving entry, found ${serving.length}`);
  }
  if (total !== 100) problems.push(`traffic percentages sum to ${total}, expected 100`);
  if (serving.length === 1) {
    if (serving[0].revisionName !== expected) {
      problems.push(`serving revision is ${serving[0].revisionName}, expected ${expected}`);
    }
    if (Number(serving[0].percent) !== 100) {
      problems.push(`serving revision is at ${serving[0].percent}%, expected 100`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`FATAL: ${problem}`);
    console.error('FATAL: split or wrong traffic — STOP. Resolve it before G7.');
    process.exit(1);
  }

  console.log(`OK: exactly one serving revision, ${expected} at 100%`);
});
