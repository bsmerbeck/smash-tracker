import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp } from '../test-support/testApp.js';

async function createClient(app: ReturnType<typeof buildTestApp>['app'], label = 'Alex') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/coaching/clients',
    headers: authHeader(),
    payload: { label },
  });
  return response.json().clientId as string;
}

describe('/api/coaching/clients/:clientId/sessions', () => {
  it('runs the full create -> list -> get -> patch -> toggle round-trip', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);

    const createResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions`,
      headers: authHeader(),
      payload: {
        date: 1000,
        characterTags: [1, 2],
        summary: 'Worked on shield pressure.',
        homework: [{ text: 'Practice out-of-shield options' }],
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.sessionId).toBeTruthy();
    expect(created.homework).toHaveLength(1);
    expect(created.homework[0].id).toBeTruthy();
    expect(created.homework[0].done).toBe(false);
    expect(created.linkedMatchIds).toBeNull();
    expect(created.coachPrivateNotes).toBeNull();

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/sessions`,
      headers: authHeader(),
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual([
      expect.objectContaining({ sessionId: created.sessionId }),
    ]);

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/sessions/${created.sessionId}`,
      headers: authHeader(),
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toEqual(created);

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/api/coaching/clients/${clientId}/sessions/${created.sessionId}`,
      headers: authHeader(),
      payload: { summary: 'Updated summary text' },
    });
    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json().summary).toBe('Updated summary text');
    expect(patchResponse.json().characterTags).toEqual([1, 2]);

    const itemId = created.homework[0].id as string;
    const toggleResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${created.sessionId}/homework/${itemId}/toggle`,
      headers: authHeader(),
      payload: { done: true },
    });
    expect(toggleResponse.statusCode).toBe(200);
    expect(
      toggleResponse.json().homework.find((item: { id: string }) => item.id === itemId).done,
    ).toBe(true);
  });

  it('404s a get for a nonexistent session', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/sessions/ghost-session`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('404s a homework toggle for an unknown item id', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const createResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions`,
      headers: authHeader(),
      payload: { date: 1000, summary: 'A session' },
    });
    const { sessionId } = createResponse.json();

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/homework/ghost-item/toggle`,
      headers: authHeader(),
      payload: { done: true },
    });

    expect(response.statusCode).toBe(404);
  });
});
