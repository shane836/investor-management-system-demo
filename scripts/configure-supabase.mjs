import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Only these Auth settings are managed. Database migrations remain a separate step.
export function buildConfig(env) {
  let project, site;
  try {
    project = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
    site = new URL(env.NEXT_PUBLIC_SITE_URL);
  } catch {
    throw new Error('Set valid NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SITE_URL values in .env.local.');
  }
  const projectRef = project.hostname.match(/^([a-z]{20})\.supabase\.co$/)?.[1];
  if (!projectRef || project.protocol !== 'https:' || project.username || project.password || project.port || project.pathname !== '/' || project.search || project.hash) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL must be the hosted project URL: https://PROJECT_REF.supabase.co.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(site.hostname);
  if ((site.protocol !== 'https:' && !(local && site.protocol === 'http:')) || site.username || site.password || site.pathname !== '/' || site.search || site.hash) {
    throw new Error('NEXT_PUBLIC_SITE_URL must be an HTTPS origin (HTTP is allowed only for localhost).');
  }
  const sender = env.SUPABASE_SMTP_SENDER_EMAIL?.trim();
  if (!sender || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender)) {
    throw new Error('Set SUPABASE_SMTP_SENDER_EMAIL to an address on your verified Resend sending domain.');
  }
  return { projectRef, desired: {
    site_url: site.origin,
    uri_allow_list: `${site.origin}/auth/confirm`,
    external_email_enabled: true,
    disable_signup: true,
    mailer_autoconfirm: false,
    external_anonymous_users_enabled: false,
    smtp_host: 'smtp.resend.com',
    smtp_port: '465',
    smtp_user: 'resend',
    smtp_admin_email: sender,
    smtp_sender_name: 'Sample Investment Partners',
    mailer_templates_magic_link_content: '<h2>Sign in to your investor portal</h2><p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Sign in</a></p>',
    mailer_templates_invite_content: '<h2>Your investor portal invitation</h2><p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite">Accept invite</a></p>',
  } };
}

export function changesFor(current, desired) {
  const changes = {};
  for (const [key, value] of Object.entries(desired)) {
    if (key === 'uri_allow_list') {
      const existing = (current[key] || '').split(',').map(url => url.trim()).filter(Boolean);
      const combined = [...new Set([...existing, ...value.split(',')])];
      if (combined.some(url => !existing.includes(url))) changes[key] = combined.join(',');
    } else if (current[key] !== value) changes[key] = value;
  }
  return changes;
}

export async function configureAuth({ projectRef, desired, token, smtpPassword, apply = false, fetchImpl = fetch }) {
  if (!/^[a-z]{20}$/.test(projectRef)) throw new Error('Invalid Supabase project reference.');
  if (!token?.trim()) throw new Error('A Supabase management access token is required.');
  if (apply && !smtpPassword?.trim()) throw new Error('A Resend API key is required to apply SMTP configuration.');
  const endpoint = `https://api.supabase.com/v1/projects/${projectRef}/config/auth`;
  async function request(method, body) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(`Supabase ${method} request failed or timed out. If applying, run --check before retrying; the change may have reached Supabase.`);
    }
    if (!response.ok) throw new Error(`Supabase ${method} failed (HTTP ${response.status}). Check token permissions and project access. Response body omitted to protect credentials.`);
    if (method === 'PATCH') return;
    try { return await response.json(); }
    catch { throw new Error('Supabase returned an invalid configuration response.'); }
  }
  const current = await request('GET');
  const changes = changesFor(current, desired);
  if (!apply) return { changes };
  // Supabase can mask smtp_pass on reads. Supply it explicitly, never return or log it.
  await request('PATCH', { ...changes, smtp_pass: smtpPassword });
  const remaining = changesFor(await request('GET'), desired);
  if (Object.keys(remaining).length) throw new Error(`Configuration verification failed for: ${Object.keys(remaining).join(', ')}. Run --check to inspect the remaining differences.`);
  return { changes, verified: true };
}

function credential(envName, service) {
  if (process.env[envName]?.trim()) return process.env[envName].trim();
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-a', process.env.USER || '', '-s', service, '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    }).trim();
  } catch {
    throw new Error(`Missing ${envName}. Store it in Keychain as service "${service}", account "$USER", or set it in gitignored .env.local.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !['--preview', '--check', '--apply'].includes(arg))) {
    throw new Error('Usage: npm run supabase:config -- [--preview|--check|--apply]');
  }
  const envPath = fileURLToPath(new URL('../.env.local', import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const config = buildConfig(process.env);
  console.log(`Supabase project: ${config.projectRef}`);
  console.log(`Portal: ${config.desired.site_url}`);
  if (!args.length || args[0] === '--preview') {
    console.log('Desired Auth configuration (offline preview; no API requests):');
    console.log(JSON.stringify(config.desired, null, 2));
    console.log('SMTP password will be supplied from Keychain or RESEND_API_KEY on --apply.');
    return;
  }
  const token = credential('SUPABASE_ACCESS_TOKEN', 'investor-portal-demo/supabase-management-token');
  const apply = args[0] === '--apply';
  const smtpPassword = apply ? credential('RESEND_API_KEY', 'investor-portal-demo/resend-api-key') : undefined;
  const result = await configureAuth({ ...config, token, smtpPassword, apply });
  console.log(JSON.stringify(result.changes, null, 2));
  if (apply) console.log('Applied and verified non-secret Auth settings. SMTP password supplied; delivery still needs a test invitation.');
  else {
    const drift = Object.keys(result.changes).length > 0;
    console.log(drift ? 'Differences found; run --apply to update these settings.' : 'Managed non-secret Auth settings match. SMTP password is not compared.');
    if (drift) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
