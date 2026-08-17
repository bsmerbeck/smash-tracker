let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  const expected = process.env.EXPECTED_REVISION;
  if (!expected) {
    console.error('FATAL: EXPECTED_REVISION is empty — no candidate can be approved');
    process.exit(1);
  }

  let revision;
  try {
    revision = JSON.parse(raw);
  } catch {
    console.error('FATAL: gcloud did not return parseable revision JSON');
    process.exit(1);
  }

  if (revision?.metadata?.name !== expected) {
    console.error(
      `FATAL: revision record names ${revision?.metadata?.name || '(missing)'}, expected ${expected}`,
    );
    process.exit(1);
  }

  const conditions = revision?.status?.conditions;
  const ready = Array.isArray(conditions)
    ? conditions.find((condition) => condition?.type === 'Ready')
    : undefined;
  if (ready?.status !== 'True') {
    console.error(
      `FATAL: ${expected} is not Ready=True` +
        (ready?.message ? ` — ${ready.message}` : ' (Ready condition absent or false)'),
    );
    process.exit(1);
  }

  console.log(`OK: exact candidate revision ${expected} reports Ready=True`);
});
