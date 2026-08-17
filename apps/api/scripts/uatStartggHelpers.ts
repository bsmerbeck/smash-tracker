/** UAT helpers: re-export the shipped research fetch + a raw one-off GraphQL poster for standings lookups (read-only, official API). */
export { fetchResearchSetsPage } from '../src/startgg/client.js';

export async function gqlRawForUat(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch('https://api.start.gg/gql/alpha', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  return body.data;
}
