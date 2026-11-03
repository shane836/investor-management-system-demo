import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../lib/supabase/server.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(env) {
  const calls = [];
  const exports = {};
  runInNewContext(code, { exports, process: { env }, require(name) {
    if (name === '@supabase/ssr') return { createServerClient: (...args) => calls.push({ kind: 'user', args }) };
    if (name === '@supabase/supabase-js') return { createClient: (...args) => calls.push({ kind: 'admin', args }) };
    if (name === 'next/headers') return { cookies: async () => ({ getAll: () => [], set() {} }) };
    throw new Error(`Unexpected Supabase dependency: ${name}`);
  } });
  return { calls, ...exports };
}

const env = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic',
  SUPABASE_SECRET_KEY: 'sb_secret_synthetic',
};

test('user requests use the publishable key without needing the server secret', async () => {
  const app = harness({ ...env, SUPABASE_SECRET_KEY: undefined });
  await app.createClient();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].kind, 'user');
  assert.equal(app.calls[0].args[0], env.NEXT_PUBLIC_SUPABASE_URL);
  assert.equal(app.calls[0].args[1], env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
});

test('admin client uses the secret key with session persistence and refresh disabled', () => {
  const app = harness(env);
  app.createServiceClient();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].kind, 'admin');
  assert.equal(app.calls[0].args[0], env.NEXT_PUBLIC_SUPABASE_URL);
  assert.equal(app.calls[0].args[1], env.SUPABASE_SECRET_KEY);
  assert.equal(app.calls[0].args[2].auth.persistSession, false);
  assert.equal(app.calls[0].args[2].auth.autoRefreshToken, false);
});

test('missing secret fails explicitly before creating an admin client', () => {
  for (const secret of [undefined, '', ' ']) {
    const app = harness({ ...env, SUPABASE_SECRET_KEY: secret });
    assert.throws(() => app.createServiceClient(), /SUPABASE_SECRET_KEY/);
    assert.equal(app.calls.length, 0);
  }
});
