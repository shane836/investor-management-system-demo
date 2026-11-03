import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildService, deployService } from '../scripts/deploy-render.mjs';

const env = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  SUPABASE_ACCESS_TOKEN: 'never-upload-management-token',
  RESEND_API_KEY: 'never-upload-resend-key',
  RENDER_API_KEY: 'never-upload-render-key',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
  NEXT_PUBLIC_IR_EMAIL: 'test@example.com',
};

test('Render payload uses free Node service and only explicitly selected app environment', () => {
  const payload = buildService(env, 'tea-test');
  assert.equal(payload.serviceDetails.plan, 'free');
  assert.equal(payload.serviceDetails.runtime, 'node');
  assert.equal(payload.branch, 'main');
  assert.equal(payload.repo, 'https://github.com/example/investor-portal-demo');
  assert.equal(payload.rootDir, '');
  assert.equal(payload.envVars.find(v => v.key === 'NEXT_PUBLIC_SITE_URL').value, 'https://ims.example.com');
  assert.ok(!JSON.stringify(payload).includes('never-upload'));
  assert.throws(() => buildService({ ...env, SUPABASE_SECRET_KEY: '' }, 'tea-test'), /SUPABASE_SECRET_KEY/);
  assert.throws(() => buildService({ ...env, RENDER_SITE_URL: 'http://localhost:3000' }, 'tea-test'), /HTTPS/);
});

function mockApi(existing = []) {
  const calls = [];
  const service = { id: 'srv-test', name: 'investor-portal-demo', ownerId: 'tea-test', repo: 'https://github.com/example/investor-portal-demo', branch: 'main', rootDir: '', type: 'web_service', serviceDetails: { plan: 'free', runtime: 'node', url: 'https://investor-portal-demo.onrender.com', healthCheckPath: '/login', envSpecificDetails: buildService(env, 'tea-test').serviceDetails.envSpecificDetails } };
  return { calls, request: async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path.startsWith('/services?')) return existing.map(s => ({ service: s === true ? service : s }));
    if (path === '/services') return { service, deployId: 'dep-first' };
    if (path.endsWith('/custom-domains') && method === 'GET') return [];
    if (path.endsWith('/custom-domains')) return [{ name: body.name }];
    if (path.endsWith('/deploys')) return { id: 'dep-next' };
    return {};
  } };
}

test('first apply creates one service and registers the domain; result contains no credentials', async () => {
  const api = mockApi();
  const result = await deployService({ env, ownerId: 'tea-test', request: api.request });
  assert.equal(result.serviceId, 'srv-test');
  assert.equal(result.deployId, 'dep-first');
  assert.deepEqual(api.calls.map(c => c.method), ['GET', 'POST', 'GET', 'POST']);
  assert.ok(!JSON.stringify(result).includes('sb_secret_test'));
});

test('repeat apply updates only managed variables and deploys without creating a duplicate service', async () => {
  const api = mockApi([true]);
  await deployService({ env, ownerId: 'tea-test', request: api.request });
  assert.ok(!api.calls.some(c => c.path === '/services' && c.method === 'POST'));
  assert.ok(api.calls.some(c => c.path.includes('/env-vars/SUPABASE_SECRET_KEY') && c.method === 'PUT'));
  assert.ok(!api.calls.some(c => c.path === '/services/srv-test/env-vars'));
  assert.ok(api.calls.some(c => c.path.endsWith('/deploys') && c.method === 'POST'));
});

test('existing service with a conflicting repo is rejected before any writes', async () => {
  const api = mockApi([{ name: 'investor-portal-demo', repo: 'https://github.com/someone/other', branch: 'main' }]);
  await assert.rejects(deployService({ env, ownerId: 'tea-test', request: api.request }), /does not match/);
  assert.equal(api.calls.length, 1);
});
