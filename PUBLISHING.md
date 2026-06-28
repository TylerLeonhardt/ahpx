# Publishing

ahpx is published to npm by a **tag-driven release pipeline**. Pushing a version
tag (`vX.Y.Z`) triggers the [publish workflow](.github/workflows/publish.yml),
which publishes the version already declared in `package.json`.

The pipeline does **not** auto-bump the version. The release author decides the
version (patch, minor, or major), commits the bump, and pushes the tag. This is
what lets ahpx ship breaking/minor releases (e.g. `0.3.0`) and not just patches.

## Cutting a release

```bash
# 1. From an up-to-date master, bump the version (no git tag yet):
npm version <patch|minor|major> --no-git-tag-version

# 2. Keep package.json formatting consistent with biome:
npx biome check --write package.json package-lock.json

# 3. Commit the bump:
git add package.json package-lock.json
git commit -m "chore: bump version to $(node -p "require('./package.json').version")"
git push origin master

# 4. Tag the commit (the tag MUST match package.json) and push the tag:
VERSION="$(node -p "require('./package.json').version")"
git tag -a "v${VERSION}" -m "v${VERSION}"
git push origin "v${VERSION}"
```

Pushing the `vX.Y.Z` tag fires the publish workflow. Watch it with:

```bash
gh run watch
```

> **Tip:** You can also bump + tag in one step with `npm version <patch|minor|major>`
> (no `--no-git-tag-version`), which creates the commit and tag for you. Then
> `git push origin master --follow-tags`. Run `biome check --write package.json`
> afterward if a formatting diff appears.

## How the pipeline works

The publish workflow triggers on pushed tags matching `v*.*.*` and runs a single
`publish` job:

| Step | What it does |
|------|-------------|
| **Tag/version assertion** | Strips the leading `v` from the tag and compares it to `package.json`'s `version`. **Fails loudly on mismatch** — the pipeline never publishes a version that disagrees with its tag. |
| **`npm ci`** | Clean install from the lockfile |
| **Quality gates** | `typecheck` → `lint` → `build` → unit tests (`vitest run src`, which excludes the `e2e/` suite). A failing gate blocks the publish. |
| **Already-published guard** | `npm view <pkg>@<version>` — if the version already exists on npm, the job **fails clearly** instead of erroring opaquely on `npm publish`. |
| **Publish** | `npm publish --access public` — authenticated via OIDC trusted publishers, no `NPM_TOKEN`. |
| **GitHub Release** | Creates a Release from the tag with auto-generated notes (skipped if one already exists). |

### Why tag-driven (and not push-to-master)?

The previous pipeline ran on every push to `master` and **auto-bumped the patch
version** before publishing. That had two fatal limitations:

1. It could only ever produce patch releases — there was no way to express a
   minor or major (breaking) release like `0.3.0`.
2. Re-enabling it would have bumped whatever was on `master` (e.g. `0.3.0 → 0.3.1`)
   and published the wrong version, desyncing the git tag, `package.json`, and npm.

The tag-driven design fixes both: the human author owns the version decision, the
tag is the single source of truth for *when* to release, and `package.json` is the
single source of truth for *what* version is released.

## Authentication: OIDC Trusted Publishers

Publishing uses **npm trusted publishers** via OpenID Connect (OIDC) — no
long-lived npm tokens are needed.

Instead of storing an `NPM_TOKEN` secret, the GitHub Actions workflow
authenticates directly with npm using a short-lived OIDC token that is:

- **Generated per workflow run** — no persistent secret to leak or rotate
- **Cryptographically signed** — tied to the specific repository and workflow
- **Scoped** — only works for the configured package and publisher

### How OIDC trusted publishing works

1. The workflow requests an OIDC token from GitHub (via `id-token: write` permission)
2. npm verifies the token's claims (repository, workflow, ref) against the trusted publisher configuration
3. If the claims match, npm issues a short-lived publish token for that specific run
4. The `npm publish` command uses this token automatically — no `NODE_AUTH_TOKEN` needed

> **Node 24 + `registry-url`:** Node 24 ships npm 11, which has native OIDC support
> for trusted publishers. The `setup-node` step must set
> `registry-url: https://registry.npmjs.org` for the OIDC token exchange to work.

### Trusted publisher configuration

The trusted publisher must be configured on npm to match this workflow:

- **Registry:** GitHub Actions
- **Organization/Owner:** `TylerLeonhardt`
- **Repository:** `ahpx`
- **Workflow filename:** `publish.yml`
- **Environment:** *(leave blank)*

> The workflow **filename** (`publish.yml`) is part of the trusted-publisher
> identity. If you rename the workflow file, update the trusted publisher on
> npmjs.com to match, or OIDC auth will start returning 403.

### References

- [npm Trusted Publishers documentation](https://docs.npmjs.com/trusted-publishers)
- [GitHub Actions OIDC documentation](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)

## Provenance

Provenance attestation (`--provenance`) is **not currently enabled**. The repo is
public (so provenance is possible) and `id-token: write` is already configured. To
enable it, add `--provenance` to the publish step:

```yaml
- name: Publish to npm
  run: npm publish --access public --provenance
```

This generates [SLSA provenance attestations](https://slsa.dev/) linking each
published package to the exact source commit and build.

## Troubleshooting

### Tag/version mismatch

The pipeline aborts before publishing if the tag (minus the `v`) doesn't equal
`package.json`'s `version`. Fix by re-tagging the correct commit, or by bumping
`package.json` to match the tag. **Never** publish past this guard manually.

### `npm publish` fails with 403 or OIDC error

- Verify `registry-url: https://registry.npmjs.org` is set in the `setup-node` step — without it, npm won't attempt OIDC token exchange.
- Ensure the trusted publisher on npmjs.com matches the repository owner, repo name, and **workflow filename** (`publish.yml`).
- Check that the workflow has `id-token: write` permission.

### "version already published"

The already-published guard ran `npm view <pkg>@<version>` and found the version
already on npm. Bump to a new version, commit, and tag again — npm versions are
immutable and cannot be overwritten.

### Re-running a release for an existing tag

If you need the pipeline to run again for a tag that already exists (e.g. the
workflow changed after the tag was pushed), delete and re-push the tag:

```bash
git push origin :refs/tags/vX.Y.Z   # delete remote tag
git push origin vX.Y.Z              # re-push → fires the workflow
```

The already-published guard prevents this from double-publishing: if the version
is already live on npm, the job fails at the guard instead of publishing twice.

## Manual publishing (discouraged)

The pipeline exists to do releases — prefer it. Only publish by hand if OIDC
trusted publishing is unavailable:

```bash
npm run typecheck && npm run lint && npm run build && npx vitest run src
npm login
npm publish --access public
```

Manual publishes won't include OIDC authentication or provenance.

## History: skipped versions (0.2.1–0.2.6)

Under the old push-to-master pipeline, versions 0.2.1 through 0.2.6 were bumped
but never successfully published due to a series of pipeline fixes:

| Version | Issue | Fix |
|---------|-------|-----|
| 0.2.1 | Build wasn't running before tests | Reordered steps: build before test |
| 0.2.2 | npm 10 lacked native OIDC support | Upgraded to npm 11 |
| 0.2.3 | npm 11 still wasn't available on Node 20 | Switched to Node 24 (ships npm 11) |
| 0.2.4 | `setup-node` missing `registry-url` | Added `registry-url: https://registry.npmjs.org` |
| 0.2.5 | `package.json` formatting mismatch after `npm version` | Added `biome check --write` after bump |
| 0.2.6 | `--provenance` requires public repo | Removed `--provenance` flag |

The first successful automated publish was **0.2.7**. The tag-driven pipeline
replaced the auto-bump push-to-master pipeline starting with **0.3.0**.
