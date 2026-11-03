import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(path, user = null) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require(name) {
    if (name === 'next/navigation') return { redirect(path) { throw new Error(`redirect:${path}`); } };
    if (name === '@/lib/supabase/server') return { createClient: async () => ({
      auth: { getUser: async () => ({ data: { user } }) },
      from() { throw new Error('The walkthrough must not query investor records.'); },
    }) };
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  return exports.default;
}

test('demo server layout rejects anonymous access independently of middleware', async () => {
  await assert.rejects(load('../app/demo/layout.tsx')({ children: 'demo' }), /redirect:\/login$/);
});

test('demo server layout accepts an Auth session without querying profiles or live investments', async () => {
  const render = load('../app/demo/layout.tsx', { id: 'reviewer' });
  assert.equal(await render({ children: 'synthetic walkthrough' }), 'synthetic walkthrough');
});

test('home sends users to the protected walkthrough instead of the database portal', async () => {
  await assert.rejects(load('../app/page.tsx')(), /redirect:\/demo$/);
});
