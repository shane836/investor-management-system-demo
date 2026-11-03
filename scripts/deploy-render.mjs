import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const serviceName = 'investor-portal-demo';
const repo = 'https://github.com/example/investor-portal-demo';

export function buildService(env, ownerId) {
  const site = new URL(env.RENDER_SITE_URL || 'https://ims.example.com');
  if (site.protocol !== 'https:' || site.username || site.password || site.port || site.pathname !== '/' || site.search || site.hash || !site.hostname.includes('.') || site.hostname.endsWith('.localhost')) {
    throw new Error('RENDER_SITE_URL must be a public HTTPS origin.');
  }
  const appVars = {
    NODE_VERSION: '24', NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
    NEXT_PUBLIC_SITE_URL: site.origin,
    NEXT_PUBLIC_FIRM_NAME: 'Sample Investment Partners — Demo',
    NEXT_PUBLIC_IR_EMAIL: env.NEXT_PUBLIC_IR_EMAIL,
  };
  for (const [key, value] of Object.entries(appVars)) {
    if (!value?.trim()) throw new Error(`Set ${key} in gitignored .env.local before deploying.`);
  }
  return {
    type: 'web_service', name: serviceName, ownerId, repo, branch: 'main', rootDir: '',
    autoDeployTrigger: 'commit',
    envVars: Object.entries(appVars).map(([key, value]) => ({ key, value })),
    serviceDetails: {
      runtime: 'node', plan: 'free', region: 'oregon', healthCheckPath: '/login',
      envSpecificDetails: {
        buildCommand: 'npm ci --no-audit --no-fund && npm test && npm run test:db && npm run build',
        startCommand: 'npm run start -- --hostname 0.0.0.0 --port $PORT',
      },
    },
  };
}

async function findService(request, ownerId) {
  const rows = await request(`/services?ownerId=${encodeURIComponent(ownerId)}&name=${serviceName}&limit=100`);
  const matches = rows.map(row => row.service).filter(service => service.name === serviceName);
  if (matches.length > 1) throw new Error('Multiple matching services found; resolve the ambiguity before deploying.');
  return matches[0];
}

export async function verifyDomain({ ownerId, hostname, request }) {
  const service = await findService(request, ownerId);
  if (!service) throw new Error('No investor-portal-demo service exists; deploy before verifying its domain.');
  const path = `/services/${service.id}/custom-domains/${encodeURIComponent(hostname)}`;
  await request(`${path}/verify`, 'POST');
  const domain = await request(path);
  return { serviceId: service.id, hostname, verificationStatus: domain.verificationStatus };
}

export async function deployService({ env, ownerId, request }) {
  const payload = buildService(env, ownerId);
  let service = await findService(request, ownerId);
  let deployId;
  if (service) {
    const details = service.serviceDetails;
    if (service.repo?.replace(/\.git$/, '') !== repo || service.branch !== 'main' || service.rootDir !== '' ||
      service.ownerId !== ownerId || service.type !== 'web_service' || details?.plan !== 'free' || details.runtime !== 'node' ||
      details.healthCheckPath !== '/login' || details.envSpecificDetails?.buildCommand !== payload.serviceDetails.envSpecificDetails.buildCommand ||
      details.envSpecificDetails?.startCommand !== payload.serviceDetails.envSpecificDetails.startCommand) {
      throw new Error('Existing service does not match this app, runtime, commands or Free plan; no changes made.');
    }
    // Per-key updates preserve environment variables owned by other workflows.
    for (const variable of payload.envVars) {
      await request(`/services/${service.id}/env-vars/${encodeURIComponent(variable.key)}`, 'PUT', { value: variable.value });
    }
    const deploy = await request(`/services/${service.id}/deploys`, 'POST', { clearCache: 'do_not_clear' });
    deployId = deploy?.id;
  } else {
    const created = await request('/services', 'POST', payload);
    service = created.service;
    deployId = created.deployId;
    if (!service?.id) throw new Error('Render did not return a service ID. Check --status before retrying.');
  }
  const siteUrl = payload.envVars.find(variable => variable.key === 'NEXT_PUBLIC_SITE_URL').value;
  const hostname = new URL(siteUrl).hostname;
  if (!hostname.endsWith('.onrender.com')) {
    const domains = await request(`/services/${service.id}/custom-domains`);
    if (!domains.some(row => (row.customDomain || row).name === hostname)) {
      await request(`/services/${service.id}/custom-domains`, 'POST', { name: hostname });
    }
  }
  return { serviceId: service.id, deployId, renderUrl: service.serviceDetails?.url, siteUrl };
}

function apiKey() {
  if (process.env.RENDER_API_KEY?.trim()) return process.env.RENDER_API_KEY.trim();
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-a', process.env.USER || '', '-s', 'investor-portal-demo/render-api-key', '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    }).trim();
  } catch {
    throw new Error('Cannot read Render API key. Store it in Keychain service "investor-portal-demo/render-api-key", account "$USER", or set RENDER_API_KEY in gitignored .env.local.');
  }
}

export function apiRequest(token, fetchImpl = fetch) {
  return async (path, method = 'GET', body) => {
    let response;
    try {
      response = await fetchImpl(`https://api.render.com/v1${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(`Render ${method} request failed or timed out. Some changes may have reached Render; run --status before retrying.`);
    }
    if (!response.ok) {
      const sensitive = [token];
      for (const variable of body?.envVars || []) {
        if (/secret|password|token|api_key/i.test(variable.key)) sensitive.push(variable.value);
      }
      // Per-key environment updates have a different body shape.
      if (path.includes('/env-vars/') && typeof body?.value === 'string') sensitive.push(body.value);
      let reason = 'No readable error details returned.';
      try {
        const details = await response.json();
        const safe = [details.code, details.message].filter(value => typeof value === 'string').join(': ');
        if (safe) reason = safe;
      } catch {
        reason = 'Non-JSON error details omitted.';
      }
      // Redact before truncation so a partial token cannot escape the filter.
      for (const value of sensitive.filter(Boolean).sort((a, b) => b.length - a.length)) {
        reason = reason.split(value).join('[REDACTED]');
      }
      reason = reason.replace(/\b(?:sb_secret_|sbp_|re_|rnd_)[A-Za-z0-9_-]+/g, '[REDACTED]')
        .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
        .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1200);
      throw new Error(`Render ${method} ${path.split('?')[0]} failed (HTTP ${response.status}): ${reason}`);
    }
    if (response.status === 204 || response.status === 202) return null;
    try { return await response.json(); }
    catch { throw new Error('Render returned an unreadable response. Run --status before retrying.'); }
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !['--preview', '--owners', '--apply', '--status', '--verify-domain'].includes(arg))) {
    throw new Error('Usage: npm run render:deploy -- [--preview|--owners|--apply|--status|--verify-domain]');
  }
  const path = fileURLToPath(new URL('../.env.local', import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
  const mode = args[0] || '--preview';
  if (mode === '--preview') {
    const payload = buildService(process.env, process.env.RENDER_OWNER_ID || '<selected on apply>');
    console.log(JSON.stringify({ ...payload, envVars: payload.envVars.map(({ key }) => ({ key, value: '<not displayed>' })) }, null, 2));
    console.log(`Site URL: ${process.env.RENDER_SITE_URL || 'https://ims.example.com'}`);
    console.log('Offline preview. Only pushed main-branch code is deployed. No API requests or credentials read from Keychain.');
    return;
  }
  const request = apiRequest(apiKey());
  const owners = await request('/owners?limit=100');
  if (mode === '--owners') {
    console.log(JSON.stringify(owners.map(({ owner }) => ({ id: owner.id, name: owner.name })), null, 2));
    return;
  }
  let ownerId = process.env.RENDER_OWNER_ID?.trim();
  if (!ownerId && owners.length === 1) ownerId = owners[0].owner.id;
  if (!ownerId || !owners.some(({ owner }) => owner.id === ownerId)) {
    throw new Error('Select your workspace with --owners, then set RENDER_OWNER_ID in .env.local. No service changed.');
  }
  if (mode === '--verify-domain') {
    const hostname = new URL(process.env.RENDER_SITE_URL || 'https://ims.example.com').hostname;
    console.log(JSON.stringify(await verifyDomain({ ownerId, hostname, request }), null, 2));
    console.log('DNS verification requested. If still unverified, check --status again shortly. HTTPS certificate issuance may take additional time.');
    return;
  }
  if (mode === '--status') {
    const service = await findService(request, ownerId);
    if (!service) { console.log('No investor-portal-demo service exists in this workspace.'); return; }
    const deploys = await request(`/services/${service.id}/deploys?limit=1`);
    const domains = await request(`/services/${service.id}/custom-domains`);
    const latest = deploys[0]?.deploy;
    console.log(JSON.stringify({ serviceId: service.id, renderUrl: service.serviceDetails?.url,
      latestDeploy: latest ? { id: latest.id, status: latest.status } : null,
      domains: domains.map(row => { const d = row.customDomain || row; return { name: d.name, verificationStatus: d.verificationStatus }; }),
    }, null, 2));
    if (latest && /failed|canceled/.test(latest.status)) process.exitCode = 1;
    return;
  }
  const result = await deployService({ env: process.env, ownerId, request });
  console.log(JSON.stringify(result, null, 2));
  console.log('Deployment requested; run --status to check completion. This is not a Blueprint-managed service.');
  if (result.renderUrl && new URL(result.siteUrl).hostname !== new URL(result.renderUrl).hostname) {
    console.log(`DNS: CNAME ${new URL(result.siteUrl).hostname} → ${new URL(result.renderUrl).hostname}`);
  }
  console.log('After DNS and HTTPS work, apply Supabase Auth configuration with NEXT_PUBLIC_SITE_URL set to the deployed Site URL. Test a magic-link login before sharing.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
