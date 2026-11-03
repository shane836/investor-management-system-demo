import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../lib/auth.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function auth({ user = { id: 'test-user' }, profile = null, error = null } = {}) {
  const exports = {}, logs = [];
  const query = { select() { return this; }, eq() { return this; },
    async single() { return { data: profile, error }; }, async maybeSingle() { return { data: profile, error }; } };
  runInNewContext(code, { exports, console: { error: (...args) => logs.push(args) }, require(name) {
    if (name === 'next/navigation') return { redirect(path) { throw new Error(`redirect:${path}`); } };
    if (name === '@/lib/supabase/server') return { createClient: async () => ({
      auth: { getUser: async () => ({ data: { user } }) }, from: () => query,
    }) };
    throw new Error(`Unexpected auth dependency: ${name}`);
  } });
  return { ...exports, logs };
}
test('a profile permission error is surfaced separately from a missing profile', async () => {
  const app = auth({ error: { code: '42501' } });
  await assert.rejects(app.requireUser(), /redirect:\/login\?error=profile-unavailable/);
  assert.equal(app.logs.length, 1);
});
test('missing profile does not send the user to the portal', async () => {
  await assert.rejects(auth().requireUser(), /redirect:\/login\?error=no-profile/);
});
test('logged-out requests require sign-in and an existing LP cannot enter admin', async () => {
  await assert.rejects(auth({ user: null }).requireUser(), /redirect:\/login$/);
  await assert.rejects(auth({ profile: { id: 'test-user', role: 'lp' } }).requireGP(), /redirect:\/portal$/);
});
