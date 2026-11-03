import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the actual middleware with isolated env/auth/response dependencies.
const code = ts.transpileModule(readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function harness(env = {}, signedIn = false) {
  const calls = [];
  const exports = {};
  runInNewContext(code, { exports, process: { env }, console: { warn: message => calls.push(message) },
    require(name) {
      if (name === '@supabase/ssr') return { createServerClient() {
        calls.push('auth-client');
        return { auth: { getUser: async () => ({ data: { user: signedIn ? { id: 'test-user' } : null } }) } };
      } };
      if (name === 'next/server') return { NextResponse: {
        next: () => ({ type: 'next' }),
        redirect: url => ({ type: 'redirect', url: url.toString() }),
        json: (body, options) => ({ type: 'json', body, status: options.status }),
      } };
      throw new Error(`Unexpected middleware dependency: ${name}`);
    },
  });
  return { calls, run(path, method = 'GET') {
    const url = new URL(path, 'http://localhost:3000');
    url.clone = () => new URL(url);
    return exports.middleware({ method, nextUrl: url, cookies: { getAll: () => [] } });
  } };
}
const configured = { NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic-test-key' };

test('missing either credential fails closed before creating auth, including the demo', async () => {
  for (const env of [{}, { NEXT_PUBLIC_SUPABASE_URL: configured.NEXT_PUBLIC_SUPABASE_URL },
    { ...configured, NEXT_PUBLIC_SUPABASE_URL: ' ' }, { ...configured, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '' }]) {
    for (const path of ['/', '/login', '/demo', '/demo/', '/portal', '/admin', '/files?path=private.pdf']) {
      const app = harness(env);
      const response = await app.run(path);
      assert.equal(response.status, 503);
      assert.ok(!app.calls.includes('auth-client'));
    }
  }
});

test('missing configuration rejects mutations rather than redirecting or pretending they succeeded', async () => {
  const app = harness();
  const response = await app.run('/admin', 'POST');
  assert.equal(response.status, 503);
  assert.match(response.body.error, /Supabase/);
  assert.ok(!app.calls.includes('auth-client'));
});

test('demo and home require a real session; login and confirmation remain reachable', async () => {
  for (const path of ['/', '/demo', '/demo/', '/demo/reporting']) {
    const anonymous = harness(configured);
    assert.equal((await anonymous.run(path)).url, 'http://localhost:3000/login');
    assert.ok(anonymous.calls.includes('auth-client'));
    const authenticated = harness(configured, true);
    assert.equal((await authenticated.run(path)).type, 'next');
  }
  for (const path of ['/login', '/auth/confirm?token_hash=synthetic&type=email']) {
    assert.equal((await harness(configured).run(path)).type, 'next');
  }
});

test('configured portal still requires login and signed-in requests still use auth', async () => {
  const anonymous = harness(configured);
  assert.equal((await anonymous.run('/portal')).url, 'http://localhost:3000/login');
  assert.ok(anonymous.calls.includes('auth-client'));
  const authenticated = harness(configured, true);
  assert.equal((await authenticated.run('/portal')).type, 'next');
  assert.ok(authenticated.calls.includes('auth-client'));
});
