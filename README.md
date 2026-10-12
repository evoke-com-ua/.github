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
- **Releases on `main`** (deployed from `release/X.Y.Z` or `hotfix/X.Y.Z`, see
  `release.yml` below) are marked: a purple bar while running,
  `🚀 Releasing v0.1.0` → `🚀 Released v0.1.0` with a *Release notes* link,
  `🩹 Deploying hotfix v0.1.1` → `🩹 Hotfix v0.1.1 deployed`, and
  `❌ Release v0.1.0 failed` / `⚪ … cancelled`. The version comes from the branch
  name, so the message doesn't wait for the release job.
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
  `develop` if it applies) as separate PRs. Then it deletes the release or
  hotfix branch (a warning if it can't).
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

## `.github/workflows/release-lms.yml`: Release LMS

One run ships `lms-en-app-v1` and/or `lms-en-web-v1` to prod. Actions →
**Release LMS** → Run workflow:

| Input | Values |
|---|---|
| `kind` | `release-minor`, `release-major` (branch from `stage`), `hotfix` (branch from `main`) |
| `repos` | `both`, `app`, `web` |
| `version` | empty = computed; or e.g. `0.5.0`, checked against the same rules |
| `skip-backup` | skip the database backup (only until DevOps has set it up) |

**Versions** are one line for the whole LMS. A release goes above the highest
tag in either repo (web `v0.3.0` + app `v0.2.0` → next release `v0.4.0` for
both). A hotfix stays on the shipped repo's `major.minor` and takes the next
patch not used by either repo; `hotfix` + `both` needs both repos on the same
line.

1. **prepare**: version, branches, one Slack message in `#ci-cd`. Cherry-pick
   onto the branches now if needed.
2. **open-prs** (environment `release-branches` = *Continue*): PRs into `main`
   opened by the EVOKE Release app, with their commits and **the migrations
   that will run**. Review and approve them.
3. **ship** (environment `production` = *Continue*):
   1. every PR approved and mergeable, else stop (nothing built);
   2. **build** both images in parallel (`deploy-prod.yml`, `mode: build`, on the
      release branch); a failure stops, nothing deployed;
   3. **back up** the prod database (`lms-en-app-v1` `deploy-prod.yml`,
      `mode: backup`, runs `PROD_DB_BACKUP_COMMAND` from DevOps); a failure
      stops, nothing deployed;
   4. **deploy the backend** (`mode: deploy`; cord runs migrations, then the
      health check), then **merge** its PR (tag + Release);
   5. **deploy the frontend**, then merge its PR.
4. **cancelled**: if a step is rejected; branches and PRs stay.

| Fails at | Prod | Next |
|---|---|---|
| build or backup | unchanged | fix → *Re-run failed jobs* |
| backend deploy | previous backend serving; migrations may have partly run | decide by hand: fix forward, or restore the pre-release backup only if data is damaged |
| frontend deploy | new backend (compatible) + previous frontend | fix → *Re-run failed jobs*: merged repos are skipped |

The database is never restored automatically, and the backend is not rolled
back when the frontend fails: migrations only add (see `migrations-check` in
`lms-en-app-v1`), so the new backend works with the previous frontend.

The merges carry `Release LMS: <run url>` and `[skip actions]` in the commit
message, so the push to `main` starts no workflow at all (the code is already
live). The `Release LMS:` conditions in `deploy-prod` and `deploy-notify` stay
as a safety net. `release / publish` runs on the PR being closed, not on the
push, so it still creates the tag and Release.

With the repository variable `RELEASE_APP_LOGIN` (the app's bot login) set in
`lms-en-app-v1` and `lms-en-web-v1`, `release / check` refuses `release/` PRs
not opened by the app. Hotfix PRs can still be opened by hand.

### Setup

- GitHub App **EVOKE Release** (Contents, Pull requests, Workflows, Actions:
  read and write; Checks: read), installed on `lms-en-app-v1`, `lms-en-web-v1`
  and this repo. Here: variable `RELEASE_APP_ID`, secret
  `RELEASE_APP_PRIVATE_KEY`.
- Environments here: `release-branches` and `production`, required reviewer
  Pavel, *Prevent self-review* off.
- `lms-en-app-v1`: variable `PROD_DB_BACKUP_COMMAND` (from DevOps).
- Slack: the org secret `SLACK_BOT_TOKEN` and variables `SLACK_CHANNEL_CICD`,
  `SLACK_USER_MAP` (CI_CD BOT), already shared with this repo.
- `lms-en-app-v1` and `lms-en-web-v1` need `deploy-prod.yml` with the `mode`
  input on the branch a release is cut from (`stage`; `main` for hotfixes after
  the first release).
