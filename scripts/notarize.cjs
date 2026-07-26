const path = require('path');
const { notarize } = require('@electron/notarize');

// Credentials come from one of two places:
//   - CI: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID env vars
//     (set as GitHub Actions secrets — see .github/workflows/release.yml)
//   - Local: the `coax-notarize` keychain profile, created once with
//     `xcrun notarytool store-credentials coax-notarize ...`
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  const useEnv = APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID;
  const credentials = useEnv
    ? { appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID }
    : { keychainProfile: 'coax-notarize' };

  console.log(
    `  • notarizing       appPath=${appPath} credentials=${useEnv ? 'env' : 'keychainProfile:coax-notarize'}`,
  );
  const start = Date.now();

  await notarize({ appPath, ...credentials });

  const seconds = Math.round((Date.now() - start) / 1000);
  console.log(`  • notarized        durationSeconds=${seconds}`);
};
