# Publishing

ahpx is published to npm automatically when changes are pushed to `master`.

## How it works

The [publish workflow](.github/workflows/publish.yml) runs on every push to `master`:

1. **Quality gates** — typecheck, lint, test, build must all pass
2. **Version bump** — auto-increments the patch version and commits back to `master`
3. **Publish** — publishes to npm with provenance attestation

## Authentication: OIDC Trusted Publishers

Publishing uses **npm trusted publishers** via OpenID Connect (OIDC) — no long-lived npm tokens are needed.

Instead of storing an `NPM_TOKEN` secret, the GitHub Actions workflow authenticates directly with npm using a short-lived OIDC token that is:

- **Generated per workflow run** — no persistent secret to leak or rotate
- **Cryptographically signed** — tied to the specific repository and workflow
- **Scoped** — only works for the configured package and publisher

### How OIDC trusted publishing works

1. The workflow requests an OIDC token from GitHub (via `id-token: write` permission)
2. npm verifies the token's claims (repository, workflow, ref) against the trusted publisher configuration
3. If the claims match, npm issues a short-lived publish token for that specific run
4. The `npm publish` command uses this token automatically — no `NODE_AUTH_TOKEN` needed

### First-time setup

To configure trusted publishing for a new package:

1. **Create the package on npm with a pending trusted publisher:**
   - Go to [npmjs.com](https://www.npmjs.com) → **+ New Package** → **Create a provenance-enabled package**
   - Or, if the package already exists: go to Package Settings → **Trusted Publishers**
   - Add a trusted publisher with:
     - **Registry:** GitHub Actions
     - **Organization/Owner:** `TylerLeonhardt`
     - **Repository:** `ahpx`
     - **Workflow filename:** `publish.yml`
     - **Environment:** *(leave blank)*

2. **Push to master** — the workflow will authenticate via OIDC and publish automatically, even for the very first publish

3. **Remove the `NPM_TOKEN` secret** from the GitHub repository settings (if present) — it's no longer needed

> **Note:** If you need to do a one-off manual publish (e.g., the initial release before trusted publishers were configured), run `npm login` first to authenticate with your npm account.

### References

- [npm Trusted Publishers documentation](https://docs.npmjs.com/trusted-publishers)
- [GitHub Actions OIDC documentation](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)

## Provenance

Every publish includes `--provenance`, which generates a [SLSA provenance attestation](https://slsa.dev/) linking the published package back to the exact source commit and build. This works alongside OIDC trusted publishers — both use the same `id-token: write` permission.

## Manual publishing

If you need to publish manually (e.g., for a pre-release):

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm publish --access public
```

Note: Manual publishes won't include provenance attestation unless you have a valid OIDC token context.
