# Publishing

ahpx is published to npm automatically when changes are merged to `master`.

## How it works

The [publish workflow](.github/workflows/publish.yml) runs on every push to `master`:

1. **Quality gates** — typecheck, lint, build, and test must all pass
2. **Version bump** — auto-increments the patch version, formats with biome, and commits back to `master`
3. **Publish** — publishes to npm via OIDC trusted publishers (`npm publish --access public`)

### Pipeline details

| Step | What it does |
|------|-------------|
| **Node 24** | Required for npm 11, which has native OIDC support for trusted publishers |
| **`registry-url`** | Must be set in `setup-node` for OIDC token exchange to work |
| **Quality gates** | `npm ci` → `typecheck` → `lint` → `build` → `test` (in that order) |
| **Bump** | `npm version patch --no-git-tag-version`, then `biome check --write package.json` to fix formatting, then commit + push |
| **Skip guard** | Commits containing `"chore: bump version"` skip the workflow to prevent infinite loops |
| **Publish** | `npm publish --access public` — authenticated via OIDC, no `NPM_TOKEN` needed |

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
   - Go to [npmjs.com](https://www.npmjs.com) → Package Settings → **Trusted Publishers**
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

Provenance attestation (`--provenance`) is **not currently enabled** because it requires a public GitHub repository. The `id-token: write` permission is already configured for OIDC authentication, which is the same permission provenance needs.

**When the repo goes public**, re-add `--provenance` to the publish step:

```yaml
- name: Publish to npm
  run: npm publish --access public --provenance
```

This will generate [SLSA provenance attestations](https://slsa.dev/) linking each published package to the exact source commit and build.

## Skipped versions (0.2.1–0.2.6)

Versions 0.2.1 through 0.2.6 were bumped but never successfully published to npm due to a series of pipeline fixes:

| Version | Issue | Fix |
|---------|-------|-----|
| 0.2.1 | Build wasn't running before tests | Reordered steps: build before test |
| 0.2.2 | npm 10 lacked native OIDC support | Upgraded to npm 11 |
| 0.2.3 | npm 11 still wasn't available on Node 20 | Switched to Node 24 (ships npm 11) |
| 0.2.4 | `setup-node` missing `registry-url` | Added `registry-url: https://registry.npmjs.org` |
| 0.2.5 | `package.json` formatting mismatch after `npm version` | Added `biome check --write` after bump |
| 0.2.6 | `--provenance` requires public repo | Removed `--provenance` flag |

The first successful automated publish was **0.2.7**.

## Troubleshooting

### `npm publish` fails with 403 or OIDC error

- Verify that `registry-url: https://registry.npmjs.org` is set in the `setup-node` step — without it, npm won't attempt OIDC token exchange
- Ensure the trusted publisher is configured on npmjs.com with the correct repository owner, repo name, and workflow filename
- Check that the workflow has `id-token: write` permission

### `package.json` formatting causes lint failure

`npm version patch` reformats `package.json` using npm's own style (2-space indent, trailing newline). If your project uses biome for formatting, the bump step must run `biome check --write package.json` before committing to avoid a lint diff on the next CI run.

### `--provenance` fails with "not supported" error

Provenance attestation requires a **public** GitHub repository. If the repo is private, remove `--provenance` from the publish command. Re-add it when the repo goes public.

### Infinite publish loop

If the workflow triggers itself on its own version-bump commit, it creates an infinite loop. The skip guard (`if: "!contains(github.event.head_commit.message, 'chore: bump version')"`) prevents this. Don't change the bump commit message format without updating the guard.

### Stale checkout causes push failure

If another commit lands on `master` between checkout and the bump push, `git push` will fail. The workflow uses `concurrency: { group: publish-npm, cancel-in-progress: false }` to serialize publishes, but fast successive merges can still race. Re-running the failed workflow is the simplest fix.

## Manual publishing

If you need to publish manually (e.g., for a pre-release):

```bash
npm run typecheck && npm run lint && npm run build && npm test
npm publish --access public
```

Note: Manual publishes won't include OIDC authentication or provenance. Run `npm login` first to authenticate with your npm account.
