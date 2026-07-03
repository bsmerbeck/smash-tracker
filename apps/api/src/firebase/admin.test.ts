import { describe, expect, it, vi } from 'vitest';

const initializeAppMock = vi.fn(() => ({ name: 'fake-app' }));
const applicationDefaultMock = vi.fn(() => ({ type: 'application-default' }));
const getAuthMock = vi.fn(() => ({ kind: 'auth' }));
const getDatabaseMock = vi.fn(() => ({ kind: 'database' }));

vi.mock('firebase-admin/app', () => ({
  initializeApp: initializeAppMock,
  applicationDefault: applicationDefaultMock,
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: getAuthMock,
}));
vi.mock('firebase-admin/database', () => ({
  getDatabase: getDatabaseMock,
}));

describe('initFirebase', () => {
  it('initializes the app with applicationDefault credentials and the configured database URL', async () => {
    const { initFirebase } = await import('./admin.js');

    const services = initFirebase({
      NODE_ENV: 'test',
      PORT: 3001,
      HOST: '0.0.0.0',
      FIREBASE_DATABASE_URL: 'https://example-default-rtdb.firebaseio.com',
      CORS_ORIGIN: 'http://localhost:5173',
      WEB_BASE_URL: 'http://localhost:5173',
    });

    expect(applicationDefaultMock).toHaveBeenCalledOnce();
    expect(initializeAppMock).toHaveBeenCalledWith({
      credential: { type: 'application-default' },
      databaseURL: 'https://example-default-rtdb.firebaseio.com',
    });
    expect(services.auth).toEqual({ kind: 'auth' });
    expect(services.database).toEqual({ kind: 'database' });
  });
});
