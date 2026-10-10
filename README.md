# evoke-com-ua/.github

Shared CI pieces for the organisation's repositories.

## `actions/deploy-notify`

Posts one Slack message per deploy run in `#ci-cd` and edits it when the run ends.
The first line is the message; the rest sits beside a coloured bar (yellow, green,
red, grey):

```
🟡 Deploying · lms-en-app-v1 · dev
┃ 🌿 develop ← feature/ci-slack-notify
┃ #83 Post every deploy to Slack #ci-cd
┃ Pavlo Kapustin · 76817b3 · View run
```

becomes one of

```
✅ Deployed · lms-en-app-v1 · dev · 3m 41s          (… · admin-dev.evoke.com.ua on the last line)
❌ Deploy failed · lms-en-app-v1 · dev · 2m 05s
⚪ Deploy cancelled · lms-en-app-v1 · dev · 0m 40s
```

- **Branch and title** come from the merged pull request (`#83` links to it): the
  target branch ← the PR's branch, and the PR title, never GitHub's "Merge pull
  request …" line. Without access to the PR, the merge message is parsed instead
  (a squash merge then shows the number and title but not the PR's branch). A
  direct push shows the branch and the commit title; a manual run adds "manual run".
- **The name** is the person's Slack name (display name, else full name), found by
  email or through `SLACK_USER_MAP`; it is plain text and doesn't ping.

A failure also gets a thread reply, broadcast to the channel, because editing a
message notifies nobody:

```
❌ Failed at deploy / deploy lms-api. The previous version keeps serving.
@Pavlo Kapustin @Yulia · View logs
```

- **Who is mentioned** (failures only): the person who started the run (the
  commit author on a push, the actor on a manual run), the commit author on a
  manual run, and the author of the pull request the commit came from. A GitHub
  email is looked up in Slack (`users.lookupByEmail`); a private
  `@users.noreply.github.com` address or a miss falls back to `SLACK_USER_MAP`
  (`{"github-login": "U…"}`), then to the plain GitHub login.
- **It never breaks a deploy**: the notifications run in their own jobs, beside
  and after `build` and `deploy`, never before them; every call has a timeout and
  a Slack error ends as a warning. If the start message could not be posted, the
  final one is posted fresh.
- **The token** reaches only the notify steps, as an input from a secret, and is
  never printed.

### Organisation settings

Settings → Secrets and variables → Actions, each limited to `lms-en-app-v1`,
`lms-en-web-v1` and `lms-en-public`:

| Kind | Name | Value |
|---|---|---|
| secret | `SLACK_BOT_TOKEN` | CI_CD BOT token (`chat:write`, `users:read`, `users:read.email`) |
| variable | `SLACK_CHANNEL_CICD` | `#ci-cd` channel ID |
| variable | `SLACK_USER_MAP` | `{}`, or `{"github-login": "U…"}` for people Slack can't find by email |

This repository: Settings → Actions → General → Access → *Accessible from
repositories in the organization*.

### Use in a deploy workflow

```yaml
env:
  DEPLOY_ENV: dev
  DEPLOY_URL: https://admin-dev.evoke.com.ua
  SLACK_CHANNEL: ${{ vars.SLACK_CHANNEL_CICD }}
  SLACK_USER_MAP: ${{ vars.SLACK_USER_MAP }}

jobs:
  notify-start:
    runs-on: ubuntu-latest
    permissions: { actions: read, contents: read }
    outputs:
      ts: ${{ steps.notify.outputs.ts }}
      body: ${{ steps.notify.outputs.body }}
    steps:
      - id: notify
        uses: evoke-com-ua/.github/actions/deploy-notify@main
        continue-on-error: true
        timeout-minutes: 2
        with:
          phase: start
          slack-token: ${{ secrets.SLACK_BOT_TOKEN }}

  build: …    # unchanged
  deploy: …   # unchanged, needs: build

  notify:
    needs: [notify-start, build, deploy]
    if: always()
    runs-on: ubuntu-latest
    permissions: { actions: read, contents: read, pull-requests: read }
    steps:
      - uses: evoke-com-ua/.github/actions/deploy-notify@main
        continue-on-error: true
        timeout-minutes: 2
        with:
          phase: finish
          ts: ${{ needs.notify-start.outputs.ts }}
          body: ${{ needs.notify-start.outputs.body }}
          needs: ${{ toJSON(needs) }}
          slack-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

`DEPLOY_APP` overrides the name shown (default: the repository name).

## `.github/workflows/release.yml`

Versions for `main`. A PR into `main` must come from `release/X.Y.Z` (cut from
`stage`) or `hotfix/X.Y.Z` (cut from `main`); merging it creates the tag
`vX.Y.Z` and a GitHub Release with notes generated since the previous tag.

| Branch | Rule, against the latest `v*` tag |
|---|---|
| `release/X.Y.0` | a higher minor (`0.1.0` → `0.2.0`) or major (`→ 1.0.0`), patch `0` |
| `hotfix/X.Y.Z` | same major.minor, a higher patch (`0.2.0` → `0.2.1`) |

- **`check`** runs on every PR into `main` and blocks a wrong branch name or
  version. It is the required status check `release / check` in the repo's
  "main release" ruleset, which also allows merge commits only (squash would
  lose the branch name).
- **`publish`** runs when the PR is merged: `gh release create` on the merge
  commit. A hotfix release reminds to make the same fix on `stage` (and
  `develop` if it applies) as separate PRs.
- A push of a tag deploys nothing; the prod deploy still runs from the push to
  `main`.

### Use in a repository

`.github/workflows/release.yml` on `stage` and `develop` (release branches are
cut from `stage`, and a PR runs the workflow from its own branch):

```yaml
name: release

on:
  pull_request:
    branches: [main]
    types: [opened, reopened, synchronize, edited, closed]

jobs:
  release:
    uses: evoke-com-ua/.github/.github/workflows/release.yml@main
    permissions:
      contents: write
```
