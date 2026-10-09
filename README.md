# evoke-com-ua/.github

Shared CI pieces for the organisation's repositories.

## `actions/deploy-notify`

Posts one Slack message per deploy run in `#ci-cd` and edits it when the run ends.

```
🟡 Deploying · lms-en-app-v1 → dev
Pasha · develop · a1b2c3d Fix login redirect · 3 commits since last deploy · run
```

becomes one of

```
✅ Deployed · lms-en-app-v1 → dev · 3m 41s · admin-dev.evoke.com.ua
❌ Deploy failed · lms-en-app-v1 → dev · 2m 05s
⚪ Deploy cancelled · lms-en-app-v1 → dev · 0m 40s
```

A failure also gets a thread reply, broadcast to the channel, because editing a
message notifies nobody:

```
❌ Failed at deploy / deploy lms-api. The previous version keeps serving. @Pasha @Yulia · logs
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
