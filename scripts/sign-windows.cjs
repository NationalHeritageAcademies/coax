// Windows code-signing hook for electron-builder.
//
// Cross-compiles from macOS using `jsign` (cross-platform Java signer that
// talks directly to Azure Trusted Signing's REST API). No Wine, no
// signtool.exe, no Windows VM.
//
// One-time setup on macOS:
//   brew install jsign
//
// Required env vars (set in .env.local — see .env.example for descriptions):
//   AZURE_TENANT_ID
//   AZURE_CLIENT_ID
//   AZURE_CLIENT_SECRET
//   TRUSTED_SIGNING_ENDPOINT      e.g. https://eus.codesigning.azure.net
//   TRUSTED_SIGNING_ACCOUNT       Artifact Signing account name
//   TRUSTED_SIGNING_PROFILE       Certificate profile name
//
// The service principal must have the "Artifact Signing Certificate Profile
// Signer" role (formerly "Trusted Signing Certificate Profile Signer") on the
// signing account (or certificate profile) resource.

const { spawn } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

loadDotEnvLocal();

const REQUIRED = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'TRUSTED_SIGNING_ENDPOINT',
  'TRUSTED_SIGNING_ACCOUNT',
  'TRUSTED_SIGNING_PROFILE',
];

exports.default = async function sign(configuration) {
  const file = configuration.path;
  if (!file) throw new Error('sign-windows: configuration.path is empty');

  // Local test builds: skip signing entirely. Unsigned installers still
  // install on a dev VM (Windows just shows a SmartScreen "run anyway"
  // prompt). NEVER set this in CI / release — published artifacts must be
  // signed, and the missing-env guard below enforces that by default.
  if (process.env.SKIP_WIN_SIGN === '1' || process.env.SKIP_WIN_SIGN === 'true') {
    console.log(`  • signing(win)     SKIPPED (SKIP_WIN_SIGN set) file=${file}`);
    return;
  }

  const missing = REQUIRED.filter((k) => !process.env[k] || !process.env[k].trim());
  if (missing.length > 0) {
    throw new Error(
      `sign-windows: missing required env var(s): ${missing.join(', ')}\n` +
        '  Set them in .env.local — see .env.example for the full list.',
    );
  }

  const endpoint = process.env.TRUSTED_SIGNING_ENDPOINT.trim();
  const account = process.env.TRUSTED_SIGNING_ACCOUNT.trim();
  const profile = process.env.TRUSTED_SIGNING_PROFILE.trim();

  // jsign's TRUSTEDSIGNING storetype expects --storepass to be an Azure OAuth
  // bearer token (NOT the client secret). Exchange the service-principal creds
  // for one via the client-credentials flow against the codesigning resource.
  const token = await getAzureAccessToken();

  const args = [
    '--storetype', 'TRUSTEDSIGNING',
    '--keystore', endpoint,
    '--storepass', token,
    '--alias', `${account}/${profile}`,
    // Microsoft's TSA is an RFC 3161 server; jsign defaults to authenticode
    // mode and chokes parsing the response ("Malformed content") without this.
    '--tsmode', 'RFC3161',
    '--tsaurl', 'http://timestamp.acs.microsoft.com',
    '--replace',
    file,
  ];

  console.log(`  • signing(win)     file=${file}`);
  const start = Date.now();

  await run('jsign', args);

  const seconds = Math.round((Date.now() - start) / 1000);
  console.log(`  • signed(win)      durationSeconds=${seconds}`);
};

// Acquire an Azure AD access token for the Trusted/Artifact Signing service
// via the OAuth2 client-credentials flow. The resulting bearer token is what
// jsign expects as --storepass for the TRUSTEDSIGNING storetype.
async function getAzureAccessToken() {
  const tenant = process.env.AZURE_TENANT_ID.trim();
  const clientId = process.env.AZURE_CLIENT_ID.trim();
  const clientSecret = process.env.AZURE_CLIENT_SECRET.trim();

  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://codesigning.azure.net/.default',
  });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(`sign-windows: network error acquiring Azure access token: ${err.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `sign-windows: failed to acquire Azure access token (HTTP ${res.status}).\n` +
        '  Check AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET.\n' +
        `  Response: ${text}`,
    );
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`sign-windows: token endpoint returned non-JSON: ${text}`);
  }
  if (!json.access_token) {
    throw new Error('sign-windows: token response missing access_token');
  }
  return json.access_token;
}

function run(cmd, args) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        rejectP(
          new Error(
            `sign-windows: \`${cmd}\` not found in PATH.\n` +
              '  On macOS: brew install jsign\n' +
              '  Other platforms: https://ebourg.github.io/jsign/',
          ),
        );
      } else {
        rejectP(err);
      }
    });
    child.on('exit', (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`sign-windows: \`${cmd}\` exited ${code}`));
    });
  });
}

// .env.local loader — electron-builder invokes sign hooks without sourcing
// dotenv, so do it here. process.env always wins (CI provides its own creds).
function loadDotEnvLocal() {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env.local');
    if (existsSync(candidate)) {
      const text = readFileSync(candidate, 'utf8');
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
