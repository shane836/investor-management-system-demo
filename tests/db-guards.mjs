// Runs the migration in in-process Postgres (PGlite) with stubbed Supabase auth/storage
// and checks RLS + 506(c) guards. Run: npm run test:db
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";

const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => readFileSync(new URL(name, migrationsDir), "utf8").replace(/create extension[^;]*;/i, ""));
const db = new PGlite();

const STUBS = `
create schema auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
create role authenticated nologin;
`;
const GRANTS = `
grant usage on schema public, auth, storage to authenticated;
grant all on all tables in schema public to authenticated;
grant all on all sequences in schema public to authenticated;
grant all on storage.objects to authenticated;
grant execute on all functions in schema public, auth, storage to authenticated;
`;

let pass = 0, failN = 0;
const ok = (name) => { pass++; console.log("  ✓", name); };
const bad = (name, e) => { failN++; console.log("  ✗", name, e ?? ""); };

async function as(uid, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false); set role authenticated;`);
  try { return await db.query(sql, params); } finally { await db.exec("reset role;"); }
}
async function expectError(name, uid, sql, match) {
  try { await as(uid, sql); bad(name, "(no error)"); }
  catch (e) { (match && !String(e.message).match(match)) ? bad(name, e.message) : ok(`${name} → "${e.message.slice(0, 70)}"`); }
}
async function expectOk(name, uid, sql) {
  try { const r = await as(uid, sql); ok(name); return r; } catch (e) { bad(name, e.message); }
}

const GP = "00000000-0000-0000-0000-00000000000a";
const LP1 = "00000000-0000-0000-0000-000000000001";
const LP2 = "00000000-0000-0000-0000-000000000002";
const LP3 = "00000000-0000-0000-0000-000000000003";

await db.exec(STUBS);
for (const migration of migrations) await db.exec(migration);
await db.exec(GRANTS);
console.log("Migration applied.");

await db.exec(`insert into auth.users (id, email) values
 ('${GP}','gp@mep.com'),('${LP1}','lp1@x.com'),('${LP2}','lp2@x.com'),('${LP3}','lp3@x.com');
 update profiles set role='gp' where id='${GP}';`);
const n = (await db.query("select count(*)::int c from profiles")).rows[0].c;
n === 4 ? ok("auth.users trigger created 4 profiles") : bad("profiles trigger", n);

await expectError("LP can't self-promote to GP", LP1, `update profiles set role='gp' where id='${LP1}'`, /Only a GP/);

const deal = (await as(GP, `insert into deals (name,status,min_investment,max_investors) values ('Sample','open',50000,2) returning id`)).rows[0].id;
await as(GP, `insert into deal_private values ('${deal}','ABA 123 / Acct 456')`);
const draft = (await as(GP, `insert into deals (name,status) values ('Secret','draft') returning id`)).rows[0].id;
const vis = (await as(LP1, `select id from deals`)).rows.map((r) => r.id);
vis.includes(deal) && !vis.includes(draft) ? ok("LP sees open deal, not draft") : bad("deal visibility", vis);

const e1 = (await as(LP1, `insert into investing_entities (owner_id,legal_name,entity_type) values ('${LP1}','LP One','individual') returning id`)).rows[0].id;
const s1 = (await as(LP1, `insert into subscriptions (deal_id,entity_id,amount) values ('${deal}','${e1}',100000) returning id`)).rows[0].id;
await expectError("LP can't subscribe to a draft deal", LP1, `insert into subscriptions (deal_id,entity_id,amount) values ('${draft}','${e1}',100000)`);
await expectError("LP can't skip to documents w/o accreditation", LP1, `update subscriptions set status='documents' where id='${s1}'`, /506\(c\)/);
await expectError("LP can't insert pre-verified accreditation", LP1, `insert into accreditations (entity_id,method,status) values ('${e1}','third_party_letter','verified')`, /row-level security/);

const a1 = (await as(LP1, `insert into accreditations (entity_id,method,letter_date) values ('${e1}','third_party_letter',current_date - 5) returning id`)).rows[0].id;
await expectOk("LP submits letter + moves to accreditation", LP1, `update subscriptions set accreditation_id='${a1}', status='accreditation' where id='${s1}'`);
await as(LP1, `update accreditations set status='verified' where id='${a1}'`);
const st = (await db.query(`select status from accreditations where id='${a1}'`)).rows[0].status;
st === "pending" ? ok("LP can't self-verify (update silently blocked by RLS)") : bad("self-verify", st);
const w0 = (await as(LP1, `select * from deal_private`)).rows.length;
w0 === 0 ? ok("Wire instructions hidden before countersign") : bad("wire leak", w0);

await expectOk("GP verifies accreditation", GP, `update accreditations set status='verified', reviewed_by='${GP}', expires_at=current_date + 85 where id='${a1}'`);
await expectOk("GP advances sub to documents", GP, `update subscriptions set status='documents' where id='${s1}' and status='accreditation'`);
await expectOk("LP uploads signed docs path", LP1, `update subscriptions set signed_doc_path='x/y.pdf' where id='${s1}'`);
await expectError("LP can't jump to funding", LP1, `update subscriptions set status='funding' where id='${s1}'`, /not allowed/);
await expectError("LP can't set funded_amount", LP1, `update subscriptions set funded_amount=1 where id='${s1}'`, /Not allowed/);
await expectOk("GP countersigns", GP, `update subscriptions set status='funding', gp_countersigned_at=now() where id='${s1}'`);
const w1 = (await as(LP1, `select wire_instructions from deal_private`)).rows.length;
w1 === 1 ? ok("Wire instructions visible after countersign") : bad("wire after countersign", w1);
await expectOk("GP marks funded", GP, `update subscriptions set status='funded', funded_amount=100000, funded_at=current_date where id='${s1}'`);

// LP2: expired + high-min below threshold
const e2 = (await as(LP2, `insert into investing_entities (owner_id,legal_name,entity_type) values ('${LP2}','LP Two LLC','llc') returning id`)).rows[0].id;
const s2 = (await as(LP2, `insert into subscriptions (deal_id,entity_id,amount) values ('${deal}','${e2}',500000) returning id`)).rows[0].id;
const aExp = (await as(GP, `insert into accreditations (entity_id,method,status,letter_date,expires_at) values ('${e2}','third_party_letter','verified',current_date-100,current_date-10) returning id`)).rows[0].id;
await as(GP, `update subscriptions set accreditation_id='${aExp}' where id='${s2}'`);
await expectError("Expired letter blocks progress (even for GP)", GP, `update subscriptions set status='documents' where id='${s2}'`, /expired/);
const aHM = (await as(GP, `insert into accreditations (entity_id,method,status) values ('${e2}','high_minimum','verified') returning id`)).rows[0].id;
await as(GP, `update subscriptions set accreditation_id='${aHM}' where id='${s2}'`);
await expectError("High-min blocked: LLC $500k < $1M", GP, `update subscriptions set status='documents' where id='${s2}'`, /high-minimum/);
await expectError("LP2 can't reuse LP1's accreditation", GP, `update subscriptions set accreditation_id='${a1}', status='documents' where id='${s2}'`, /different investing entity/);


// Funding invariant: application records may precede verification, accepted capital may not.
const fundingDeal = (await as(GP, `insert into deals (name,status,max_investors) values ('Funding guard regression','open',25) returning id`)).rows[0].id;
await as(GP, `insert into deal_private values ('${fundingDeal}','SYNTHETIC WIRE INSTRUCTIONS')`);
async function expectMutationError(name, uid, sql, match) {
  // Roll back even unexpected successes so every negative case starts clean.
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    await db.exec("set local role authenticated");
    try { await db.query(sql); bad(name, "(no error)"); }
    catch (e) { (match && !String(e.message).match(match)) ? bad(name, e.message) : ok(name); }
  } finally { await db.exec("rollback"); }
}
const insertFunding = (extra) => `insert into subscriptions (deal_id,entity_id,amount,${extra.columns}) values ('${fundingDeal}','${e1}',100000,${extra.values})`;
await expectMutationError("GP cannot directly insert funded without accreditation", GP,
  insertFunding({ columns: 'status,gp_countersigned_at,funded_amount,funded_at', values: "'funded',now(),100000,current_date" }), /506\(c\)/);
await expectMutationError("GP cannot insert funding without accreditation", GP,
  insertFunding({ columns: 'status,gp_countersigned_at', values: "'funding',now()" }), /506\(c\)/);
await expectMutationError("GP cannot disguise accepted funds as committed", GP,
  insertFunding({ columns: 'funded_amount', values: '100000' }), /506\(c\)/);
await expectMutationError("LP cannot prepopulate funding date on initial commitment", LP1,
  insertFunding({ columns: 'funded_at', values: 'current_date' }));
const pending = (await as(LP1, `insert into accreditations (entity_id,method) values ('${e1}','verification_service') returning id`)).rows[0].id;
await expectMutationError("GP cannot directly fund with pending accreditation", GP,
  insertFunding({ columns: 'status,accreditation_id,gp_countersigned_at', values: `'funded','${pending}',now()` }), /506\(c\)/);
await expectMutationError("GP cannot fund with another entity's accreditation", GP,
  insertFunding({ columns: 'status,accreditation_id,gp_countersigned_at', values: `'funded','${aExp}',now()` }), /different investing entity/);
await expectMutationError("GP cannot insert funding without countersign", GP,
  insertFunding({ columns: 'status,accreditation_id', values: `'funding','${a1}'` }), /countersign/i);

const initial = await expectOk("Unverified applicant can make initial commitment", LP1,
  `insert into subscriptions (deal_id,entity_id,amount) values ('${fundingDeal}','${e1}',100000) returning id`);
if (initial?.rows.length) {
  const sub = initial.rows[0].id;
  const update = (fields) => `update subscriptions set ${fields} where id='${sub}'`;
  await expectMutationError("GP cannot set funded amount without changing status", GP, update('funded_amount=100000'), /506\(c\)/);
  await expectMutationError("GP cannot set funded date without changing status", GP, update('funded_at=current_date'), /506\(c\)/);
  await expectMutationError("GP cannot countersign without verification", GP, update('gp_countersigned_at=now()'), /506\(c\)/);
  await expectOk("Verified subscription can advance to documents", GP, update(`status='documents', accreditation_id='${a1}'`));
  await expectMutationError("Verified subscription still needs countersign for funding", GP, update("status='funding'"), /countersign/i);
  await expectOk("Verified countersigned subscription can enter funding", GP, update("status='funding', gp_countersigned_at=now()"));
  await expectMutationError("GP cannot clear accreditation at unchanged funding status", GP, update('accreditation_id=null'), /506\(c\)/);
  await expectMutationError("LP cannot clear accreditation at unchanged funding status", LP1, update('accreditation_id=null'), /506\(c\)/);
  await expectMutationError("GP cannot swap accreditation to another entity", GP, update(`accreditation_id='${aExp}'`), /different investing entity/);
  await expectMutationError("GP cannot clear countersign at funding", GP, update('gp_countersigned_at=null'), /countersign/i);
  const wireCount = async () => (await as(LP1, `select * from deal_private where deal_id='${fundingDeal}'`)).rows.length;
  (await wireCount()) === 1 ? ok("Verified countersigned LP sees wires") : bad("valid funding wire visibility");
  await as(GP, `update accreditations set status='rejected' where id='${a1}'`);
  (await wireCount()) === 0 ? ok("Wire access rechecks accreditation approval") : bad("revoked accreditation leaks wires");
  await expectMutationError("Funding update rechecks revoked accreditation at unchanged status", GP, update('funded_amount=100000'), /506\(c\)/);
  await as(GP, `update accreditations set status='verified', expires_at=current_date-1 where id='${a1}'`);
  (await wireCount()) === 0 ? ok("Wire access respects recorded expiry") : bad("expired accreditation leaks wires");
  await expectMutationError("Funding update rechecks recorded expiry", GP, update('funded_at=current_date'), /expired/);
  await as(GP, `update accreditations set expires_at=current_date+85 where id='${a1}'`);
  await expectOk("Verified countersigned subscription can record funding", GP, update("status='funded', funded_amount=100000, funded_at=current_date"));
}
// No new universal expiry: a verified record with no expiry remains valid under existing policy.
const noExpiry = (await as(GP, `insert into accreditations (entity_id,method,status) values ('${e2}','verification_service','verified') returning id`)).rows[0].id;
await expectMutationError("Direct funding respects an explicit expired accreditation", GP,
  `insert into subscriptions (deal_id,entity_id,amount,status,accreditation_id,gp_countersigned_at) values ('${fundingDeal}','${e2}',100000,'funded','${aExp}',now())`, /expired/);
await expectMutationError("Direct funding preserves high-minimum threshold", GP,
  `insert into subscriptions (deal_id,entity_id,amount,status,accreditation_id,gp_countersigned_at) values ('${fundingDeal}','${e2}',500000,'funded','${aHM}',now())`, /high-minimum/);
await expectOk("GP can directly insert legitimate verified countersigned funding", GP,
  `insert into subscriptions (deal_id,entity_id,amount,status,accreditation_id,gp_countersigned_at,funded_amount,funded_at) values ('${fundingDeal}','${e2}',100000,'funded','${noExpiry}',now(),100000,current_date)`);

// Isolation
const leak = (await as(LP2, `select * from subscriptions where id='${s1}'`)).rows.length;
leak === 0 ? ok("LP2 can't see LP1's subscription") : bad("sub leak");
const leakA = (await as(LP2, `select * from accreditations where id='${a1}'`)).rows.length;
leakA === 0 ? ok("LP2 can't see LP1's accreditation") : bad("accred leak");

// Cap
const e3 = (await as(LP3, `insert into investing_entities (owner_id,legal_name,entity_type) values ('${LP3}','LP Three','individual') returning id`)).rows[0].id;
await expectError("Investor cap enforced (max 2)", LP3, `insert into subscriptions (deal_id,entity_id,amount) values ('${deal}','${e3}',60000)`, /Deal is full/);
const e1b = (await as(LP1, `insert into investing_entities (owner_id,legal_name,entity_type) values ('${LP1}','LP One IRA','ira') returning id`)).rows[0].id;
await expectOk("Same LP's 2nd entity doesn't count against cap", LP1, `insert into subscriptions (deal_id,entity_id,amount) values ('${deal}','${e1b}',60000)`);

// Storage
await db.exec(`insert into storage.objects (bucket_id,name) values
  ('portal','${LP1}/${e1}/accreditation/letter.pdf'), ('portal','deals/${deal}/ppm/ppm.pdf'), ('portal','deals/${draft}/ppm/secret.pdf');`);
const o2 = (await as(LP2, `select name from storage.objects`)).rows.map((r) => r.name);
!o2.some((x) => x.startsWith(LP1)) ? ok("Storage: LP2 can't read LP1's letter") : bad("storage leak", o2);
o2.some((x) => x.includes(`${deal}/ppm`)) ? ok("Storage: LP2 can read open deal PPM") : bad("ppm visibility", o2);
!o2.some((x) => x.includes(draft)) ? ok("Storage: draft deal docs hidden") : bad("draft docs leak", o2);
const o1 = (await as(LP1, `select name from storage.objects where name like '${LP1}%'`)).rows.length;
o1 === 1 ? ok("Storage: LP1 reads own letter") : bad("own letter", o1);
await expectError("Storage: LP can't write into another LP's folder", LP2, `insert into storage.objects (bucket_id,name) values ('portal','${LP1}/hack.pdf')`, /row-level security/);



// Deal minimum: enforce the configured amount at the write boundary, without
// retroactively rewriting commitments when the deal configuration later changes.
const minimumDeal = (await as(GP, `insert into deals (name,status,min_investment,max_investors) values ('Minimum regression','open',50000,25) returning id`)).rows[0].id;
const minimumInsert = (amount, entity = e1) => `insert into subscriptions (deal_id,entity_id,amount) values ('${minimumDeal}','${entity}',${amount})`;
await expectMutationError("LP cannot directly insert a below-minimum commitment", LP1, minimumInsert(49999.99), /Minimum investment/);
await expectMutationError("GP cannot directly insert a below-minimum commitment", GP, minimumInsert(49999.99), /Minimum investment/);
await expectMutationError("Commitment cannot use PostgreSQL numeric NaN", GP, minimumInsert("'NaN'"), /finite/);
const minimumSub = await expectOk("Unverified applicant can commit exactly the minimum", LP1, `${minimumInsert(50000)} returning id`);
if (minimumSub?.rows.length) {
  const sub = minimumSub.rows[0].id;
  const change = (fields) => `update subscriptions set ${fields} where id='${sub}'`;
  await expectMutationError("LP cannot reduce commitment below minimum", LP1, change('amount=49999.99'), /Minimum investment/);
  await expectMutationError("GP cannot reduce commitment below minimum", GP, change('amount=49999.99'), /Minimum investment/);
  await expectMutationError("Amount update cannot use numeric NaN", GP, change("amount='NaN'"), /finite/);
  await expectOk("LP can increase initial commitment above minimum", LP1, change('amount=60000'));
  const higherDeal = (await as(GP, `insert into deals (name,status,min_investment) values ('Higher minimum','open',100000) returning id`)).rows[0].id;
  await expectMutationError("Moving commitment to another deal checks that deal's minimum", GP, change(`deal_id='${higherDeal}'`), /Minimum investment/);
  await expectOk("GP can raise minimum without rewriting existing commitments", GP, `update deals set min_investment=100000 where id='${minimumDeal}'`);
  await expectOk("Historical amount does not block unrelated workflow updates", LP1, change("status='accreditation'"));
  await expectMutationError("Changing historical amount must meet the current minimum", GP, change('amount=70000'), /Minimum investment/);
  await expectOk("GP can change commitment to the new minimum", GP, change('amount=100000'));
}
const zeroMinimumDeal = (await as(GP, `insert into deals (name,status,min_investment) values ('No configured minimum','open',0) returning id`)).rows[0].id;
await expectOk("Zero configured minimum still allows positive initial commitment", LP2,
  `insert into subscriptions (deal_id,entity_id,amount) values ('${zeroMinimumDeal}','${e2}',1)`);


// Sponsor-only deal-minimum exceptions are exact, scoped to one investment,
// auditable, and independent of accreditation approval/thresholds.
const exceptionDeal = (await as(GP, `insert into deals (name,status,min_investment,max_investors) values ('Minimum exceptions','open',50000,25) returning id`)).rows[0].id;
const approveException = (entity, amount, reason = 'Sponsor approved smaller allocation') =>
  `select set_subscription_minimum_exception('${exceptionDeal}','${entity}',${amount},'${reason}') as id`;
await expectMutationError("LP cannot approve their own minimum exception", LP1, approveException(e1, 12500), /Only a GP/);
await expectMutationError("GP exception requires an audit reason", GP, approveException(e1, 12500, '   '), /reason/);
await expectMutationError("GP exception rejects nonfinite amount", GP, approveException(e1, "'NaN'"), /finite/);
const exceptionGrant = await expectOk("GP can approve and create a $12,500 initial investment", GP, approveException(e1, 12500));
if (exceptionGrant?.rows.length) {
  const sub = exceptionGrant.rows[0].id;
  const change = (fields) => `update subscriptions set ${fields} where id='${sub}'`;
  const approved = (await db.query(`select * from subscriptions where id='${sub}'`)).rows[0];
  approved.minimum_exception_actor === GP && approved.minimum_exception_at && approved.amount === '12500.00'
    ? ok("Exception records authenticated GP, timestamp and exact amount") : bad("exception attribution", approved.id);
  const advertised = (await as(LP1, `select min_investment from deals where id='${exceptionDeal}'`)).rows[0].min_investment;
  Number(advertised) === 50000 ? ok("Exception leaves advertised $50,000 minimum unchanged") : bad("global minimum changed");
  await expectMutationError("LP cannot change the approved exception", LP1, change("minimum_exception_amount=10000,minimum_exception_reason='Self approval'"), /Only a GP/);
  await expectMutationError("LP cannot spoof exception audit actor", LP1, change(`minimum_exception_actor='${LP1}'`), /Only a GP/);
  await expectMutationError("LP cannot use a different below-minimum amount", LP1, change('amount=10000'), /Minimum investment/);
  await expectMutationError("Other LP cannot copy approval into their own investment", LP2,
    `insert into subscriptions (deal_id,entity_id,amount,minimum_exception_active,minimum_exception_amount,minimum_exception_reason,minimum_exception_actor) values ('${exceptionDeal}','${e2}',12500,true,12500,'Copied approval','${GP}')`, /Only a GP/);
  await expectMutationError("LP cannot change approved investment identity", LP1, change("id=gen_random_uuid()"), /scope/);
  await expectMutationError("GP cannot move approved exception to another entity", GP, change(`entity_id='${e2}'`), /scope/);
  const otherDeal = (await as(GP, `insert into deals (name,status,min_investment) values ('Separate scope','open',50000) returning id`)).rows[0].id;
  await expectMutationError("GP cannot move approved exception to another deal", GP, change(`deal_id='${otherDeal}'`), /scope/);
  await expectOk("GP can change approved investment to $25,000", GP, approveException(e1, 25000, 'Revised allocation'));
  await expectMutationError("Old approved amount stops working after change", LP1, change('amount=12500'), /Minimum investment/);
  const hm = (await as(GP, `insert into accreditations (entity_id,method,status) values ('${e1}','high_minimum','verified') returning id`)).rows[0].id;
  await expectMutationError("Minimum exception does not lower accreditation method threshold", GP, change(`accreditation_id='${hm}',status='documents'`), /high-minimum/);
  await expectMutationError("Exception does not confer accreditation", GP, change("status='funding',gp_countersigned_at=now()"), /506\(c\)/);
  await expectMutationError("Revoke without reason fails", GP, `select revoke_subscription_minimum_exception('${sub}',' ')`, /reason/);
  await expectMutationError("LP cannot revoke sponsor approval", LP1, `select revoke_subscription_minimum_exception('${sub}','Investor request')`, /Only a GP/);
  await expectMutationError("Direct revocation cannot leave a live under-minimum commitment", GP, change("minimum_exception_active=false,minimum_exception_reason='Revoke'"), /Minimum investment/);
  await expectOk("GP can revoke and withdraw an unfunded commitment", GP, `select revoke_subscription_minimum_exception('${sub}','Allocation cancelled')`);
  const revoked = (await db.query(`select * from subscriptions where id='${sub}'`)).rows[0];
  revoked.status === 'withdrawn' && !revoked.minimum_exception_active && revoked.minimum_exception_actor === GP
    ? ok("Revocation retains history and withdraws commitment") : bad("unsafe revocation");
  await expectMutationError("Revoked exception cannot reopen below advertised minimum", GP, change("status='committed'"), /Minimum investment/);
  const audit = (await db.query(`select actor,details from audit_log where target_id='${sub}' and action='UPDATE' order by id desc limit 1`)).rows[0];
  audit?.actor === GP && audit.details.new.minimum_exception_reason === 'Allocation cancelled'
    && audit.details.old.minimum_exception_active === true && audit.details.new.minimum_exception_active === false
    ? ok("Audit preserves grant/change/revocation with GP and reason") : bad("exception audit missing");
}
// Change an existing ordinary commitment, rather than forcing a duplicate row.
const existing = (await as(LP2, `insert into subscriptions (deal_id,entity_id,amount) values ('${exceptionDeal}','${e2}',50000) returning id`)).rows[0].id;
const existingGrant = await expectOk("GP can lower an existing early commitment to $17,500", GP, approveException(e2, 17500));
if (existingGrant?.rows.length) {
  existingGrant.rows[0].id === existing ? ok("Lowering preserves subscription identity") : bad("duplicate subscription created");
  await expectOk("Ordinary verification progression still works for exception", GP, `update subscriptions set accreditation_id='${noExpiry}',status='documents' where id='${existing}'`);
  await expectMutationError("Exception still requires GP countersign", GP, `update subscriptions set status='funding' where id='${existing}'`, /countersign/);
  await expectMutationError("Cannot change exception after signing workflow begins", GP, approveException(e2, 12500), /before documents/);
  await expectMutationError("Cannot revoke exception after signing workflow begins", GP, `select revoke_subscription_minimum_exception('${existing}','Too late')`, /before documents/);
}

// K-1 isolation: test metadata and raw object access independently of the UI.
const k1Path = `${LP1}/${e1}/k1/synthetic-k1.pdf`;
const wrongEntityPath = `${LP1}/${e2}/k1/synthetic-k1.pdf`;
const publicK1Path = `deals/${deal}/k1/synthetic-k1.pdf`;
const insertK1 = (entity, path) => `insert into documents (deal_id,entity_id,kind,title,file_path,uploaded_by) values ('${deal}',${entity ? `'${entity}'` : 'null'},'k1','Synthetic K-1','${path}','${GP}')`;
await expectMutationError("GP cannot insert a deal-wide K-1", GP, insertK1(null, publicK1Path), /K-1/);
await expectMutationError("K-1 metadata cannot point at a shared file", GP, insertK1(e1, `deals/${deal}/ppm/synthetic-k1.pdf`), /K-1/);
await expectMutationError("K-1 path must match its actual entity owner", GP, insertK1(e2, wrongEntityPath), /K-1/);
await expectMutationError("K-1 path must match its assigned entity", GP, insertK1(e2, k1Path), /K-1/);
await expectMutationError("K-1 needs a nonempty filename", GP, insertK1(e1, `${LP1}/${e1}/k1/`), /K-1/);
const k1Doc = await expectOk("GP can create an entity-private K-1", GP, `${insertK1(e1, k1Path)} returning id`);
if (k1Doc?.rows.length) {
  const doc = k1Doc.rows[0].id;
  await expectMutationError("GP cannot remove K-1 entity on update", GP, `update documents set entity_id=null where id='${doc}'`, /K-1/);
  await expectMutationError("GP cannot move K-1 metadata to shared storage", GP, `update documents set file_path='${publicK1Path}' where id='${doc}'`, /K-1/);
  const ownDocs = (await as(LP1, `select id from documents where id='${doc}'`)).rows.length;
  ownDocs === 1 ? ok("Owner reads their K-1 metadata") : bad("own K-1 metadata hidden");
  const otherDocs = (await as(LP2, `select id from documents where id='${doc}'`)).rows.length;
  otherDocs === 0 ? ok("Other investor cannot read K-1 metadata") : bad("K-1 metadata leaked");
}
await expectMutationError("GP cannot upload K-1 to shared deal path", GP, `insert into storage.objects (bucket_id,name) values ('portal','${publicK1Path}')`, /K-1/);
await expectMutationError("GP cannot upload K-1 under wrong owner", GP, `insert into storage.objects (bucket_id,name) values ('portal','${wrongEntityPath}')`, /K-1/);
await expectOk("GP can upload entity-private K-1", GP, `insert into storage.objects (bucket_id,name) values ('portal','${k1Path}')`);
await expectMutationError("GP cannot rename private K-1 to shared K-1 path", GP, `update storage.objects set name='${publicK1Path}' where bucket_id='portal' and name='${k1Path}'`, /K-1/);
const objectCount = async (uid, path) => (await as(uid, `select id from storage.objects where bucket_id='portal' and name='${path}'`)).rows.length;
(await objectCount(LP1, k1Path)) === 1 ? ok("Owner can read K-1 object directly") : bad("own K-1 object hidden");
(await objectCount(LP2, k1Path)) === 0 ? ok("Other investor cannot read K-1 object directly") : bad("K-1 object leaked");
(await objectCount(GP, k1Path)) === 1 ? ok("GP retains K-1 object access") : bad("GP K-1 access blocked");
// Simulate pre-migration rows only in this isolated fixture; legacy bytes remain
// on disk but must be inaccessible to LPs even when a raw path is known.
await db.exec('alter table documents disable trigger user; alter table storage.objects disable trigger user;');
try {
  await db.query(insertK1(null, publicK1Path));
  await db.query(`insert into storage.objects (bucket_id,name) values ('portal','${publicK1Path}')`);
  const mislabeled = `deals/${deal}/ppm/legacy-k1.pdf`;
  await db.query(insertK1(e1, mislabeled));
  await db.query(`insert into storage.objects (bucket_id,name) values ('portal','${mislabeled}')`);
} finally { await db.exec('alter table documents enable trigger user; alter table storage.objects enable trigger user;'); }
const legacyMetadata = (await as(LP2, `select id from documents where kind='k1' and entity_id is null`)).rows.length;
legacyMetadata === 0 ? ok("Legacy deal-wide K-1 metadata is quarantined") : bad("legacy K-1 metadata leaked");
(await objectCount(LP2, publicK1Path)) === 0 ? ok("Legacy shared K-1 path is quarantined") : bad("legacy shared K-1 object leaked");
(await objectCount(LP1, `deals/${deal}/ppm/legacy-k1.pdf`)) === 0 ? ok("Mislabeled shared K-1 path is quarantined even from owner") : bad("mislabeled K-1 object leaked");
(await objectCount(LP2, `deals/${deal}/ppm/ppm.pdf`)) === 1 ? ok("Normal shared PPM remains readable") : bad("shared PPM broken");
await expectOk("Normal shared update can still be posted", GP,
  `insert into documents (deal_id,kind,title,file_path,uploaded_by) values ('${deal}','update','Synthetic update','deals/${deal}/update/synthetic.pdf','${GP}')`);


// Operational exceptions retain accountability without changing investment approval.
const GP2 = '00000000-0000-0000-0000-00000000000b';
await db.exec(`insert into auth.users (id,email) values ('${GP2}','gp2@example.test'); update profiles set role='gp' where id='${GP2}'`);
const openIssue = (kind = 'verification', summary = 'Evidence retrieval needs review', owner = GP) =>
  `select open_journey_exception('${s2}','${kind}','${summary}','${owner}') as id`;
await expectMutationError("LP cannot open internal journey exception", LP2, openIssue(), /Only a GP/);
await expectMutationError("Unauthenticated caller cannot open journey exception", '', openIssue(), /Only a GP/);
await expectMutationError("Exception requires a description", GP, openIssue('verification','   '), /description/);
await expectMutationError("Exception owner must be a GP", GP, openIssue('verification','Review needed',LP2), /owner/);
const issueOpened = await expectOk("GP can open an owned journey exception", GP, openIssue());
if (issueOpened?.rows.length) {
  const id = issueOpened.rows[0].id;
  const duplicate = (await as(GP, openIssue('verification','Retry must not replace description',GP2))).rows[0].id;
  const issue = (await as(GP, `select * from journey_exceptions where id='${id}'`)).rows[0];
  duplicate === id && issue.owner_id === GP && issue.summary === 'Evidence retrieval needs review'
    ? ok("Duplicate open returns existing issue without losing ownership/details") : bad("duplicate exception overwrite");
  (await as(LP2, `select * from journey_exceptions where id='${id}'`)).rows.length === 0
    ? ok("LP cannot read internal journey exception") : bad("internal issue leaked");
  await expectMutationError("LP cannot insert issue directly", LP2,
    `insert into journey_exceptions(subscription_id,kind,summary,owner_id,created_by,updated_by) values ('${s2}','other','Self write','${GP}','${GP}','${GP}')`, /row-level security/);
  const direct = await as(GP, `update journey_exceptions set summary='Untracked mutation' where id='${id}' returning id`);
  direct.rows.length === 0 ? ok("Direct GP update cannot bypass tracked issue actions") : bad("direct issue update bypass");
  const edit = (version, owner, state, resolution = 'null') =>
    `select update_journey_exception('${id}',${version},'${owner}','Follow up evidence recovery','${state}',${resolution})`;
  await expectMutationError("LP cannot update journey exception", LP2, edit(1,GP,'open'), /Only a GP/);
  await expectMutationError("Cannot resolve without recorded resolution", GP, edit(1,GP,'resolved'), /resolution/);
  await expectMutationError("Cannot assign issue to investor", GP, edit(1,LP2,'open'), /owner/);
  await expectOk("GP can explicitly reassign ownership and update details", GP, edit(1,GP2,'open'));
  await expectMutationError("Stale action cannot overwrite newer issue state", GP, edit(1,GP,'open'), /changed/);
  await expectMutationError("Missing version cannot bypass stale-write protection", GP, edit('null',GP,'open'), /changed/);
  const before = (await db.query(`select status,accreditation_id,gp_countersigned_at,funded_amount from subscriptions where id='${s2}'`)).rows[0];
  await expectOk("GP resolves issue with explicit explanation", GP, edit(2,GP2,'resolved',"'Recovered evidence into private storage'"));
  const after = (await db.query(`select status,accreditation_id,gp_countersigned_at,funded_amount from subscriptions where id='${s2}'`)).rows[0];
  JSON.stringify(before) === JSON.stringify(after) ? ok("Resolving issue changes no subscription approval/funding state") : bad("issue resolution changed investment state");
  const resolved = (await as(GP, `select * from journey_exceptions where id='${id}'`)).rows[0];
  resolved.status === 'resolved' && resolved.version === 3 && resolved.created_by === GP
    && resolved.updated_by === GP && resolved.resolved_by === GP && resolved.resolved_at
    ? ok("Issue retains creator, resolver, version and timestamps") : bad("issue attribution incomplete");
  await expectMutationError("Resolved issue history cannot be rewritten", GP2, edit(3,GP2,'open'), /resolved/i);
  (await as(GP, `delete from journey_exceptions where id='${id}' returning id`)).rows.length === 0
    ? ok("Issue history cannot be deleted through application role") : bad("issue audit deleted");
  const recurring = (await as(GP2, openIssue())).rows[0].id;
  recurring !== id ? ok("A recurring problem creates a new issue after resolution") : bad("resolved issue reused");
  const auditIssue = (await db.query(`select actor,details from audit_log where target_table='journey_exceptions' and target_id='${id}' and action='UPDATE' order by id desc limit 1`)).rows[0];
  auditIssue?.actor === GP && auditIssue.details.old.status === 'open'
    && auditIssue.details.new.resolution === 'Recovered evidence into private storage'
    ? ok("Audit preserves issue resolution and authenticated actor") : bad("issue audit missing");
}

// Audit
const au = (await db.query(`select count(*)::int c from audit_log`)).rows[0].c;
au > 10 ? ok(`Audit log captured ${au} rows`) : bad("audit", au);
const auLp = (await as(LP1, `select * from audit_log`)).rows.length;
auLp === 0 ? ok("LP can't read audit log") : bad("audit leak");
const actor = (await db.query(`select actor from audit_log where target_id='${a1}' and action='UPDATE' limit 1`)).rows[0]?.actor;
actor === GP ? ok("Audit records the GP as verifier") : bad("audit actor", actor);

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
