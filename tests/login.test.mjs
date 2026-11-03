import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../app/login/actions.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(error) {
  const exports = {}, logs = [], requests = [];
  runInNewContext(code, { exports, process: { env: { NEXT_PUBLIC_SITE_URL: 'http://localhost:3000' } },
    console: { error: (...args) => logs.push(args) }, require(name) {
      if (name === 'next/navigation') return { redirect(path) { throw new Error(`redirect:${path}`); } };
      if (name === '@/lib/supabase/server') return { createClient: async () => ({ auth: {
        signInWithOtp: async request => { requests.push(request); return { error }; },
      } }) };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const form = new FormData();
  form.set('email', 'investor@example.com');
  return { logs, requests, run: () => exports.sendMagicLink(form) };
}

test('login keeps invite-only behavior and a neutral response on success', async () => {
  const app = harness(null);
  await assert.rejects(app.run(), /redirect:\/login\?sent=1/);
  assert.equal(app.requests[0].options.shouldCreateUser, false);
  assert.equal(app.requests[0].options.emailRedirectTo, 'http://localhost:3000/auth/confirm');
  assert.equal(app.logs.length, 0);
});

test('Supabase errors are logged by code and status without exposing provider messages or email', async () => {
  for (const code of ['email_not_confirmed', 'over_email_send_rate_limit', 'unexpected_failure']) {
    const app = harness({ code, status: 500, message: 'private SMTP credential or investor@example.com' });
    await assert.rejects(app.run(), /redirect:\/login\?sent=1/);
    assert.equal(app.logs.length, 1);
    assert.equal(app.logs[0][1].code, code);
    assert.equal(app.logs[0][1].status, 500);
    assert.ok(!JSON.stringify(app.logs).includes('private SMTP'));
    assert.ok(!JSON.stringify(app.logs).includes('investor@example.com'));
  }
});
