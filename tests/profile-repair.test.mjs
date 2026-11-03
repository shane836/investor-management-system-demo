import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('repair backfills pre-migration accounts, preserves GP roles, and grants access without weakening RLS', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
      alter table storage.objects enable row level security;
      create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
      create role authenticated nologin; grant usage on schema auth to authenticated;`);
    const lp = '00000000-0000-4000-8000-000000000001', gp = '00000000-0000-4000-8000-000000000002';
    await db.exec(`insert into auth.users(id,email) values ('${lp}','lp@example.com'),('${gp}','gp@example.com');`);
    const directory = new URL('../supabase/migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql') && name < '0007').sort()) {
      await db.exec(readFileSync(new URL(name, directory), 'utf8').replace(/create extension[^;]*;/i, ''));
    }
    await db.exec(`insert into profiles(id,email,role) values ('${gp}','gp@example.com','gp');`);
    const repair = readFileSync(new URL('0007_profile_bootstrap_access.sql', directory), 'utf8');
    await db.exec(repair);
    await db.exec(repair);
    assert.equal((await db.query(`select role from profiles where id='${lp}'`)).rows[0].role, 'lp');
    assert.equal((await db.query(`select role from profiles where id='${gp}'`)).rows[0].role, 'gp');
    await db.exec(`select set_config('request.jwt.claim.sub','${lp}',false); set role authenticated;`);
    const rows = (await db.query('select id from profiles')).rows;
    assert.deepEqual(rows.map(row => row.id), [lp]);
    await assert.rejects(db.exec("insert into profiles(id,email,role) values ('00000000-0000-4000-8000-000000000003','fake@example.com','gp')"));
    await assert.rejects(db.exec(`update profiles set role='gp' where id='${lp}'`), /Only a GP/);
    assert.equal((await db.query('select * from audit_log')).rows.length, 0);
    assert.equal((await db.query('select * from journey_exceptions')).rows.length, 0);
  } finally { await db.close(); }
});
