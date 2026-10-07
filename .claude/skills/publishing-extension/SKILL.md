---
name: publishing-extension
description: Use when the user asks to publish, release or ship the System Metrics extension to the VS Code Marketplace, or to bump its version for a release.
---

# Publishing the extension

A Marketplace publish is public, and a version number can never be reused. Run the steps in order. A failing step stops the run: report its real output and wait.

## Steps

1. `npm run gate`: lint, tests and `vsce package`.
2. `npm run release:check`. It checks that you're on `main` with a clean tree that matches `origin/main`, that `CHANGELOG.md` has `## <version>`, that tag `v<version>` is free, that the version isn't on the Marketplace yet, and that the vsce token is valid.
3. On a FAIL line:

   | FAIL                                                  | Next                                                                                                                                                                                                                                                          |
   | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | version already on the Marketplace, or the tag exists | Ask the user: patch, minor or major? Set `version` in `package.json`, add `## <version>` to `CHANGELOG.md` (drafted from `git log v<previous>..HEAD`), run the gate, and propose the commit through the normal commit approval. Push, then restart at step 1. |
   | CHANGELOG has no entry                                | Draft it from the git log and propose it as a commit.                                                                                                                                                                                                         |
   | not on main, tree dirty, or not pushed                | Report it. The user decides.                                                                                                                                                                                                                                  |
   | vsce token invalid                                    | The user runs `npx vsce login <publisher>` **from the project folder**. A vsce run from another directory may be a different install that stores tokens elsewhere.                                                                                            |

4. Ask the user to confirm the F5 check for this version: the panel opens, the graphs move every second, each GPU has its own section, hiding and showing the view restarts the graphs, and the Show Cores setting toggles the core bars.
5. Present the publish and wait for an explicit yes to **this** publish:
   - extension id and version
   - the `CHANGELOG.md` entry
   - the commands: `npx vsce publish`, `git tag v<version>`, `git push origin v<version>`
6. On yes, run those three commands in order, stopping at the first failure.
7. Report the published version, the pushed tag, and `https://marketplace.visualstudio.com/items?itemName=<publisher>.<name>`. The listing can take a few minutes to appear.

## Command forms

- Publish with plain `npx vsce publish`, which packages with dependencies; `systeminformation` must ship.
- Version bumps go through the commit in step 3. `vsce publish patch|minor|major` would commit and tag by itself, without approval.
- An approval covers one publish only.
