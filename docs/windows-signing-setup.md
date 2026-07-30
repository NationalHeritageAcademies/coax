# Windows code signing setup (in progress)

> **NHA fork status (2026-07-30):** everything below documents the *upstream
> Melodic Development* Azure Trusted Signing setup and is kept as a worked
> example of the process. NHA releases need their own signing identity:
> an Azure Trusted Signing account under NHA's tenant, identity validation
> for National Heritage Academies, a cert profile, and the six env vars /
> repo secrets re-issued from that account (see `.env.example` and
> `scripts/sign-windows.cjs` — the code is identity-agnostic and needs no
> changes). The same applies to macOS notarization: new `APPLE_ID` /
> `APPLE_TEAM_ID` / app-specific password secrets from NHA's Apple
> Developer account (`scripts/notarize.cjs`). Until those exist, CI builds
> ship unsigned (`SKIP_WIN_SIGN=1`, `mac.notarize: false`).
>
> Known so far: **NHA Apple Team ID = `2X78QR5M8K`**. Still needed: a
> Developer ID Application .p12 from that team (Account Holder role
> creates it), an Apple ID + app-specific password for notarytool, and
> the full Azure Trusted Signing setup below re-done under NHA's tenant
> (start the identity validation first — it's the multi-day step).

Coax's Windows installer is being wired up to Authenticode-sign via **Azure
Trusted Signing** (Microsoft's cloud KMS signing service, ~$120/yr).

This doc tracks the in-flight setup so it can be resumed on any machine.

---

## Why this exists

The Coax 1.2.0 Windows installer was leaving only `Uninstall Coax.exe`
behind in the install dir on a test user's machine. Root cause: the
`Coax.exe` is unsigned, and Coax's network surface (Sentry, electron-updater,
Polar license validation in `src/cli/license.ts` + `src/licensing/polar.ts`)
trips Windows Defender's ML heuristics, which quarantine the binary as it's
extracted by NSIS. NSIS doesn't notice the file vanished and reports
install success. Same failure mode in both `C:\Program Files (x86)\Coax\`
and `%LOCALAPPDATA%\Programs\Coax\`.

Pre-rename Relay didn't trip Defender — it had none of that network
surface and was just a window. The Coax rename + licensing/telemetry
additions pushed it over the line.

Code signing isn't a workaround — Defender's heuristics treat signed
binaries with verified publishers as low-risk and skip the quarantine
behavior. SmartScreen reputation builds separately, on the certificate
identity, over the first few dozen downloads.

## Why Azure Trusted Signing specifically

Evaluated alternatives:

- **Microsoft Store (MSIX)** — free signing but requires MSIX containerization
  that breaks Coax's workspace file management, SQLite, CLI install flow,
  and Polar-based commerce. Not worth it.
- **SignPath Foundation** — free for OSS only; Coax is paid/closed-source.
- **Traditional OV cert (SSL.com etc.)** — ~$200/yr, since June 2023 must be
  on hardware token (or cloud-HSM service for more $).
- **EV cert** — $300–600/yr + USB token. Best SmartScreen reputation but
  cost/logistics don't justify it for a one-person shop.
- **Azure Trusted Signing** — $9.99/mo Basic tier, cloud-KMS (no token),
  cross-platform via `jsign`, one account signs multiple apps.

## What's already done

- Azure Pay-As-You-Go subscription set up (upgraded from Free Trial; Basic
  support = $0).
- **Artifact Signing account:** `melodic-dev-signing` (Basic tier).
- **App Registration in Entra ID:** named `Coax`, single-tenant. Client ID,
  tenant ID, and a client secret are stored in `.env.local` (gitignored)
  on the original build machine.
- **Integration code drafted** (uncommitted):
  - `scripts/sign-windows.cjs` — custom signing hook for electron-builder
  - `electron-builder.yml` — added `win.sign` pointing at the hook
  - `.env.example` — appended the 6 required env vars + setup notes

## Status

Identity validation **passed** and the certificate profile
**`melodic-cert-profile`** is **Active** (subject
`CN="Melodic Development, LLC"`, Saranac MI). Role assignment done. Remaining
work is build + sign + verify (steps 3–6 below).

> Historical blocker (resolved): the first Public Organization validation
> failed with `Name mismatch — Input: RICHARD HOPKINS` because the authorized
> signer name didn't match the D&B record. Failed validations can't be edited;
> it was deleted and resubmitted matching D&B exactly.

## Resume steps (in order)

### 1. Identity validation — DONE

Public Organization validation for `Melodic Development, LLC` is approved. If
it ever needs redoing: open the D&B record at
[dnb.com/business-directory](https://www.dnb.com/business-directory/), match
the **exact** organization name, street spelling, and authorized-signer name,
then resubmit (failed entries must be deleted, not edited).

### 2. Cert profile + role assignment — DONE

1. Cert profile created: `melodic-dev-signing` → **Certificate Profiles** →
   **Public Trust**, named **`melodic-cert-profile`**. This string is the
   `TRUSTED_SIGNING_PROFILE` env var.
2. **Role assignment is done at the _account_ level, not the cert profile.**
   The cert-profile blade only shows Versions — it has no Access control (IAM).
   Go to the **`melodic-dev-signing` account** → **Access control (IAM)** →
   **+ Add** → **Add role assignment** → role
   **`Artifact Signing Certificate Profile Signer`** (search just `Signer`;
   this is the renamed "Trusted Signing Certificate Profile Signer", same
   `Microsoft.CodeSigning` provider) → assign to the `Coax` App Registration.
   A role granted at the account scope covers all profiles under it.

   CLI equivalent (if the portal picker is uncooperative):
   ```bash
   az role assignment create \
     --assignee <objectId of the Coax service principal> \
     --role "Trusted Signing Certificate Profile Signer" \
     --scope "/subscriptions/<subId>/resourceGroups/<rg>/providers/Microsoft.CodeSigning/codeSigningAccounts/melodic-dev-signing"
   ```
   (The CLI still accepts the old role name as an alias.)

### 3. Set up the build machine

If on a fresh machine, you need:

- The Coax repo cloned
- `jsign` installed: `brew install jsign` (macOS) or see
  [ebourg.github.io/jsign](https://ebourg.github.io/jsign/) for other platforms
- `.env.local` at the repo root with the 6 required env vars (see below)

The first three (`AZURE_*`) come from the `Coax` App Registration in Entra
ID. If you don't have the client secret value (you can't view it again
after creation), generate a new one in **Certificates & secrets** → **+ New
client secret** and update `.env.local`.

### 4. Fill in `.env.local`

```bash
# From the Coax App Registration in Entra ID
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...

# From the Artifact Signing account overview (region URL)
TRUSTED_SIGNING_ENDPOINT=https://eus.codesigning.azure.net

# Names you set in Azure
TRUSTED_SIGNING_ACCOUNT=melodic-dev-signing
TRUSTED_SIGNING_PROFILE=melodic-cert-profile
```

The hook uses the three `AZURE_*` values to fetch an OAuth bearer token (client-
credentials flow against `https://codesigning.azure.net/.default`) and passes
that to `jsign` as `--storepass`. jsign's `TRUSTEDSIGNING` storetype requires a
bearer token, **not** the client secret directly — the hook handles the
exchange, so you only ever put the secret in `.env.local`.

### 5. Build + sign

electron-builder builds **only for the host OS** by default, so plain
`npm run package` on macOS produces just the `.dmg`/zip and never runs the
Windows signer. Pass platform flags:

```bash
npm run package:dist        # mac + win   (electron-builder --mac --win)
npm run package:all         # mac + win + linux
# or ad-hoc:
npm run package -- --win    # windows only
```

Watch for `• signing(win)     file=...` log lines. The resulting
`dist/Coax Setup *.exe` (and the bundled `Coax.exe` + uninstaller inside
it) will be Authenticode-signed. The Windows installer builds natively on
macOS — no Wine needed.

### 6. Verify

1. Send the new installer to a Windows machine where Defender is enabled
   and the previous unsigned install failed.
2. Install — confirm `Coax.exe` and the rest of the app payload actually
   land in `%LOCALAPPDATA%\Programs\Coax\` (or wherever the user picked).
3. Right-click `Coax.exe` → Properties → **Digital Signatures** tab —
   confirm "Melodic Development" (or whatever D&B has on file) appears
   as a verified publisher.
4. SmartScreen may still show a one-time "publisher verified, new app"
   prompt until reputation builds. That's normal for a fresh non-EV cert
   and fades after a few dozen downloads.

### 7. Commit

Once signing is verified working end-to-end, commit:

- `scripts/sign-windows.cjs`
- `electron-builder.yml` (the `win.sign` + `signingHashAlgorithms` lines)
- `.env.example` (the appended Trusted Signing section)
- `docs/windows-signing-setup.md` (this file)

**Never commit `.env.local`.** It's already in `.gitignore`.

## How the integration works

`scripts/sign-windows.cjs` is registered via `win.sign` in
`electron-builder.yml`. electron-builder calls it for each Windows binary
that needs signing (`Coax.exe`, `Uninstall Coax.exe`, the NSIS installer
itself). The hook:

1. Loads `.env.local` from the repo root (walks up from `__dirname`).
2. Validates that all 6 required env vars are set — throws a clear error
   listing the missing ones if not (no silent unsigned builds).
3. Exchanges the `AZURE_*` service-principal creds for an OAuth bearer token
   (client-credentials flow against `https://codesigning.azure.net/.default`).
4. Shells out to `jsign` with `--storetype TRUSTEDSIGNING`, the bearer token
   as `--storepass`, the configured endpoint, alias `{account}/{profile}`,
   and Microsoft's free timestamp authority at
   `http://timestamp.acs.microsoft.com`.

`jsign` is a cross-platform Java signer that talks directly to the Azure
Trusted Signing REST API. No Wine, no Windows VM, no `signtool.exe`
needed on macOS.

## Cost

- Trusted Signing Basic: $9.99/month flat
- Pay-As-You-Go subscription: $0 base (only billed for actual usage)
- Timestamp authority: free
- Total: ~$120/year, covers signing as many Coax releases (and other
  Melodic Dev apps under the same publisher identity) as needed within
  the 5,000 signatures/month Basic limit.
