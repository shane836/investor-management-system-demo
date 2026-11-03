import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDomain } from '../scripts/deploy-render.mjs';

test('domain verification uses the existing service without deploying or changing settings', async () => {
  const calls = [];
  const result = await verifyDomain({ ownerId: 'tea-test', hostname: 'ims.example.com',
    request: async (path, method = 'GET') => {
      calls.push({ path, method });
      if (path.startsWith('/services?')) return [{ service: { name: 'investor-portal-demo', id: 'srv-test' } }];
      if (path.endsWith('/verify')) return null;
      return { name: 'ims.example.com', verificationStatus: 'verified' };
    },
  });
  assert.deepEqual(calls.slice(1), [
    { path: '/services/srv-test/custom-domains/ims.example.com/verify', method: 'POST' },
    { path: '/services/srv-test/custom-domains/ims.example.com', method: 'GET' },
  ]);
  assert.equal(result.verificationStatus, 'verified');
});

test('verification reports pending status and refuses to create a missing service', async () => {
  await assert.rejects(verifyDomain({ ownerId: 'tea-test', hostname: 'ims.example.com', request: async () => [] }), /No.*service/);
  const result = await verifyDomain({ ownerId: 'tea-test', hostname: 'ims.example.com', request: async path => {
    if (path.startsWith('/services?')) return [{ service: { name: 'investor-portal-demo', id: 'srv-test' } }];
    return path.endsWith('/verify') ? null : { verificationStatus: 'unverified' };
  } });
  assert.equal(result.verificationStatus, 'unverified');
});
