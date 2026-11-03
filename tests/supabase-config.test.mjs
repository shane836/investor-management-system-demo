import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, changesFor, configureAuth } from '../scripts/configure-supabase.mjs';

const env = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  NEXT_PUBLIC_SITE_URL: 'https://portal.example.com',
  SUPABASE_SMTP_SENDER_EMAIL: 'noreply@updates.example.com',
};

test('config targets the hosted project and enables invite-only email with server confirmation links', () => {
  const { projectRef, desired } = buildConfig(env);
  assert.equal(projectRef, 'abcdefghijklmnopqrst');
  assert.equal(desired.disable_signup, true);
  assert.equal(desired.external_email_enabled, true);
  assert.equal(desired.mailer_autoconfirm, false);
  assert.equal(desired.external_anonymous_users_enabled, false);
  assert.equal(desired.smtp_host, 'smtp.resend.com');
  assert.equal(desired.smtp_user, 'resend');
  assert.equal(desired.smtp_admin_email, env.SUPABASE_SMTP_SENDER_EMAIL);
  assert.match(desired.mailer_templates_magic_link_content, /token_hash=\{\{ \.TokenHash \}\}&type=email/);
  assert.match(desired.mailer_templates_invite_content, /type=invite/);
  assert.equal(desired.uri_allow_list, `${env.NEXT_PUBLIC_SITE_URL}/auth/confirm`);
  assert.ok(!('smtp_pass' in desired));
});

test('invalid target, unsafe site URL, or missing sender fail before any request', () => {
  for (const override of [
    { NEXT_PUBLIC_SUPABASE_URL: 'https://attacker.example.com' },
    { NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co/other' },
    { NEXT_PUBLIC_SITE_URL: 'http://portal.example.com' },
    { NEXT_PUBLIC_SITE_URL: 'https://user:pass@portal.example.com' },
    { SUPABASE_SMTP_SENDER_EMAIL: '' },
  ]) assert.throws(() => buildConfig({ ...env, ...override }));
  assert.equal(buildConfig({ ...env, NEXT_PUBLIC_SITE_URL: 'http://localhost:3000/' }).desired.site_url, 'http://localhost:3000');
});

test('patch preserves existing redirects and ignores unrelated settings and credentials', () => {
  const { desired } = buildConfig(env);
  const current = { ...desired, uri_allow_list: 'https://other.example.com/callback', external_google_enabled: true, smtp_pass: 'hidden' };
  const patch = changesFor(current, desired);
  assert.deepEqual(patch, { uri_allow_list: 'https://other.example.com/callback,https://portal.example.com/auth/confirm' });
  assert.deepEqual(changesFor({ ...desired }, desired), {});
});

function mockApi(current, { rejectPatch = false, ignorePatch = false } = {}) {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'PATCH') {
      if (rejectPatch) return new Response('sensitive upstream response', { status: 403 });
      if (!ignorePatch) current = { ...current, ...JSON.parse(options.body) };
    }
    return Response.json({ ...current, smtp_pass: 'masked' });
  } };
}

test('check is read-only; apply sends a narrow patch and verifies it by reading back', async () => {
  const config = buildConfig(env);
  const api = mockApi({ ...config.desired, disable_signup: false, external_google_enabled: true });
  const check = await configureAuth({ ...config, token: 'test-token', fetchImpl: api.fetch });
  assert.equal(check.changes.disable_signup, true);
  assert.deepEqual(api.calls.map(call => call.method), ['GET']);
  const result = await configureAuth({ ...config, token: 'test-token', smtpPassword: 'test-resend-secret', apply: true, fetchImpl: api.fetch });
  assert.equal(result.verified, true);
  assert.deepEqual(api.calls.map(call => call.method), ['GET', 'GET', 'PATCH', 'GET']);
  const patch = JSON.parse(api.calls[2].body);
  assert.deepEqual(patch, { disable_signup: true, smtp_pass: 'test-resend-secret' });
  assert.equal(api.calls[2].url, 'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth');
  assert.ok(!JSON.stringify(result).includes('test-resend-secret'));
});

test('missing credentials, API rejection, and failed readback surface without leaking response bodies', async () => {
  const config = buildConfig(env);
  await assert.rejects(configureAuth({ ...config, token: '' }), /access token/i);
  await assert.rejects(configureAuth({ ...config, token: 'token', apply: true }), /Resend/i);
  const rejected = mockApi({}, { rejectPatch: true });
  await assert.rejects(configureAuth({ ...config, token: 'token', smtpPassword: 'secret', apply: true, fetchImpl: rejected.fetch }), /^Error: Supabase PATCH failed \(HTTP 403\)/);
  const ignored = mockApi({}, { ignorePatch: true });
  await assert.rejects(configureAuth({ ...config, token: 'token', smtpPassword: 'secret', apply: true, fetchImpl: ignored.fetch }), /verification failed/i);
});
