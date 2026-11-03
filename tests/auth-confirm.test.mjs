import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../app/auth/confirm/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ siteUrl = 'https://ims.example.com', error = null } = {}) {
  const exports = {}, calls = [], logs = [];
  runInNewContext(code, { exports, URL, process: { env: { NEXT_PUBLIC_SITE_URL: siteUrl } },
    console: { error: (...args) => logs.push(args) }, require(name) {
      if (name === 'next/server') return { NextResponse: {
        redirect: url => ({ url: url.toString() }),
        json: (body, options) => ({ body, status: options.status }),
      } };
      if (name === '@/lib/supabase/server') return { createClient: async () => ({ auth: {
        verifyOtp: async args => { calls.push(args); return { error }; },
        exchangeCodeForSession: async value => { calls.push(value); return { error }; },
      } }) };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { calls, logs, run: query => exports.GET({ url: `http://0.0.0.0:10000/auth/confirm${query}` }) };
}

test('magic links, invitations and PKCE callbacks redirect to the public site behind Render', async () => {
  for (const query of ['?token_hash=synthetic&type=email', '?token_hash=synthetic&type=invite', '?code=synthetic']) {
    const app = harness();
    assert.equal((await app.run(query)).url, 'https://ims.example.com/');
    assert.equal(app.calls.length, 1);
  }
});

test('invalid or expired links return to public login, never the internal address', async () => {
  for (const query of ['', '?token_hash=synthetic&type=email', '?code=synthetic']) {
    const app = harness({ error: { message: 'expired' } });
    const response = await app.run(query);
    const target = new URL(response.url);
    assert.equal(target.origin, 'https://ims.example.com');
    assert.equal(target.pathname, '/login');
    assert.match(target.searchParams.get('error'), /invalid or expired/);
  }
});

test('local configuration still redirects to localhost', async () => {
  assert.equal((await harness({ siteUrl: 'http://localhost:3000' }).run('?code=synthetic')).url, 'http://localhost:3000/');
});

test('missing Site URL fails before consuming the one-time login token', async () => {
  const app = harness({ siteUrl: '' });
  assert.equal((await app.run('?code=synthetic')).status, 503);
  assert.equal(app.calls.length, 0);
  assert.equal(app.logs.length, 1);
});
