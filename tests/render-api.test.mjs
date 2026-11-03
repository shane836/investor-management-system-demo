import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiRequest } from '../scripts/deploy-render.mjs';

test('Render validation error includes endpoint and provider reason', async () => {
  const request = apiRequest('test-token', async () => Response.json({ message: 'Repository not found', code: 'repo_not_found' }, { status: 400 }));
  await assert.rejects(request('/services', 'POST', {}), error => {
    assert.match(error.message, /POST \/services failed \(HTTP 400\)/);
    assert.match(error.message, /repo_not_found/);
    assert.match(error.message, /Repository not found/);
    return true;
  });
});

test('error details redact the Render token, managed secret values, and credential prefixes before printing', async () => {
  const secret = 'private-smtp-value';
  const token = 'private-render-token';
  const request = apiRequest(token, async () => Response.json({
    message: `Rejected ${secret} ${token} sb_secret_example re_example sbp_fcexample Bearer unknown-header-value`,
  }, { status: 400 }));
  await assert.rejects(request('/services', 'POST', { envVars: [{ key: 'SUPABASE_SECRET_KEY', value: secret }] }), error => {
    for (const value of [secret, token, 'sb_secret_example', 're_example', 'sbp_fcexample', 'unknown-header-value']) assert.ok(!error.message.includes(value));
    assert.match(error.message, /REDACTED/);
    return true;
  });
});

test('non-JSON errors do not print raw HTML or response text', async () => {
  const request = apiRequest('token', async () => new Response('<html>private backend response</html>', { status: 502 }));
  await assert.rejects(request('/owners'), error => {
    assert.match(error.message, /HTTP 502/);
    assert.ok(!error.message.includes('private backend response'));
    return true;
  });
});
