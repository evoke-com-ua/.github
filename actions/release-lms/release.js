const SLACK = 'https://slack.com/api/'
const TIMEOUT = 10000
const OWNER = 'evoke-com-ua'
const REPOS = {
  app: { name: 'lms-en-app-v1' },
  web: { name: 'lms-en-web-v1' },
}
const ORDER = ['app', 'web']
const MARKER = 'Release LMS:'
const READY = ['CLEAN', 'HAS_HOOKS', 'UNSTABLE']
const WORKFLOW = 'deploy-prod.yml'
const POLL = Number(process.env.POLL_MS || 15000)
const RUN_TIMEOUT = 45 * 60 * 1000
const MIGRATIONS = /(^|\/)[Dd]atabase\/migrations\/.*\.php$/

const COLORS = { running: '#7c3aed', released: '#2eb67d', failed: '#e01e5a', cancelled: '#9e9ea6' }
const MARKS = { waiting: '⏳', building: '🔨', built: '📦', deploying: '🟡', ok: '✅', failed: '❌' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const duration = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}
const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim())
  return m && m.slice(1).map(Number)
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const show = (v) => v.join('.')
const latest = (list) => [...list].sort(compare).pop()

/**
 * The version for a run, on the one number line shared by app and web.
 * A release goes above every tag in either repo; a hotfix stays on the shipped repos' major.minor line and takes the
 * next patch free in either repo. `wanted` (optional) is checked against the same rules.
 */
function pickVersion(tagsByRepo, kind, names, wanted) {
  const all = Object.values(tagsByRepo).flat()
  const top = latest(all)
  const want = wanted ? parse(wanted) : null
  if (wanted && !want) throw new Error(`"${wanted}" is not a version like 0.3.0`)

  if (kind !== 'hotfix') {
    const next = !top ? (kind === 'release-major' ? [1, 0, 0] : [0, 1, 0])
      : kind === 'release-major' ? [top[0] + 1, 0, 0] : [top[0], top[1] + 1, 0]
    if (!want) return show(next)
    if (want[2] !== 0) throw new Error(`a release ends in .0 (got ${show(want)})`)
    if (top && compare(want, top) <= 0) throw new Error(`a release must be above v${show(top)}, the highest version in app and web`)
    return show(want)
  }

  const lines = names.map((n) => {
    const v = latest(tagsByRepo[n])
    if (!v) throw new Error(`${n} has no version yet, so there is nothing to hotfix`)
    return v
  })
  const [major, minor] = lines[0]
  if (lines.some((v) => v[0] !== major || v[1] !== minor)) {
    throw new Error(`${names.map((n, i) => `${n} is on ${lines[i][0]}.${lines[i][1]}`).join(', ')}: run the hotfix per repo`)
  }
  const patch = Math.max(...all.filter((v) => v[0] === major && v[1] === minor).map((v) => v[2]))
  if (!want) return `${major}.${minor}.${patch + 1}`
  if (want[0] !== major || want[1] !== minor || want[2] <= patch) {
    throw new Error(`a hotfix on ${major}.${minor} must be ${major}.${minor}.${patch + 1} or a higher patch (got ${show(want)})`)
  }
  return show(want)
}

module.exports = async ({ github, context, core }) => {
  const e = process.env
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`
  const repoUrl = (name) => `${context.serverUrl}/${OWNER}/${name}`

  const slack = async (method, body) => {
    if (!e.SLACK_TOKEN || !e.SLACK_CHANNEL) return null
    try {
      const res = await fetch(SLACK + method, {
        method: 'POST',
        headers: { Authorization: `Bearer ${e.SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel: e.SLACK_CHANNEL, ...body }),
        signal: AbortSignal.timeout(TIMEOUT),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(`${method}: ${json.error}`)
      return json
    } catch (err) {
      core.warning(`Slack: ${err.message}`)
      return null
    }
  }

  const slackUser = async (id) => {
    try {
      const res = await fetch(`${SLACK}users.info?${new URLSearchParams({ user: id })}`, {
        headers: { Authorization: `Bearer ${e.SLACK_TOKEN}` },
        signal: AbortSignal.timeout(TIMEOUT),
      })
      const json = await res.json()
      return json.ok ? json.user : null
    } catch {
      return null
    }
  }

  const render = (s) => {
    const tag = `v${s.version}`
    const what = s.kind === 'release' ? 'release' : 'hotfix'
    const header = {
      branches: `⏸ *LMS ${what} ${tag}* · *prod* · waiting for cherry-picks → <${runUrl}|Continue>`,
      prs: `⏸ *LMS ${what} ${tag}* · *prod* · waiting for PR review → <${runUrl}|Continue>`,
      shipping: s.kind === 'release' ? `🚀 *Releasing LMS ${tag}* · *prod*` : `🩹 *Deploying LMS hotfix ${tag}* · *prod*`,
      released: s.kind === 'release' ? `🚀 *LMS ${tag} released* · *prod* · ${s.took}` : `🩹 *LMS hotfix ${tag} deployed* · *prod* · ${s.took}`,
      failed: `❌ *LMS ${what} ${tag} stopped${s.stoppedAt ? ` at ${s.stoppedAt}` : ''}* · *prod*`,
      cancelled: `⚪ *LMS ${what} ${tag} cancelled* · nothing deployed`,
    }[s.status]
    const color = { released: COLORS.released, failed: COLORS.failed, cancelled: COLORS.cancelled }[s.status] || COLORS.running
    const lines = s.repos.map((r) => {
      const url = repoUrl(r.name)
      const pr = r.pr ? ` · <${url}/pull/${r.pr}|#${r.pr}>` : ''
      if (s.status === 'branches' || (s.status === 'cancelled' && !r.pr)) {
        return `🌿 *${r.name}* · \`${r.branch}\` from \`${r.base}\``
      }
      if (s.status === 'prs' || s.status === 'cancelled') {
        const migrations = r.migrations?.length ? ` · ${r.migrations.length} migration${r.migrations.length === 1 ? '' : 's'}` : ''
        return `🔎 *${r.name}*${pr} · ${r.commits} commit${r.commits === 1 ? '' : 's'}${migrations}`
      }
      const parts = [`${MARKS[r.state || 'waiting']} *${r.name}*${pr}`]
      if (r.state === 'building') parts.push('building…')
      if (r.state === 'built') parts.push('built')
      if (r.state === 'deploying') parts.push('deploying…')
      if (r.took) parts.push(r.took)
      if (r.run) parts.push(`<${r.run}|View run>`)
      if (r.state === 'ok') parts.push(`<${url}/releases/tag/${tag}|Release notes>`)
      return parts.join(' · ')
    })
    if (s.backup && !['branches', 'prs', 'cancelled'].includes(s.status)) {
      const b = s.backup
      const label = { skipped: '⚪ skipped', running: '🟡 running…', ok: '✅ done', failed: '❌ failed' }[b.state] || '⏳'
      lines.splice(1, 0, `💾 *Database backup* · ${label}${b.run ? ` · <${b.run}|View run>` : ''}`)
    }
    if (s.note) lines.push(`_${s.note}_`)
    return {
      text: header,
      attachments: [{
        color,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(s.who)} · <${runUrl}|Release LMS run>` }] },
        ],
      }],
      unfurl_links: false,
      unfurl_media: false,
    }
  }

  const publish = async (s) => {
    const msg = render(s)
    if (s.ts) await slack('chat.update', { ts: s.ts, text: msg.text, attachments: msg.attachments })
    else s.ts = (await slack('chat.postMessage', msg))?.ts || ''
  }

  const save = (s) => core.setOutput('state', JSON.stringify(s))

  // What main has and stage doesn't (a fix on the release branch, a hotfix, a direct edit on main), as a PR into
  // stage. Compared by file content: squash merges into stage never make main's commits ancestors of stage.
  const syncStage = async (name, version) => {
    const { data: cmp } = await github.rest.repos.compareCommitsWithBasehead({ owner: OWNER, repo: name, basehead: 'stage...main' })
    const blobAt = async (path) => {
      try {
        return (await github.rest.repos.getContent({ owner: OWNER, repo: name, path, ref: 'stage' })).data.sha
      } catch (err) {
        if (err.status === 404) return null
        throw err
      }
    }
    const differ = []
    for (const f of (cmp.files || []).slice(0, 100)) {
      if (await blobAt(f.filename) !== (f.status === 'removed' ? null : f.sha)) differ.push(f.filename)
      if (f.previous_filename && await blobAt(f.previous_filename) !== null) differ.push(f.previous_filename)
    }
    if (!differ.length) return null

    const branch = `sync/stage-from-v${version}`
    const { data: main } = await github.rest.git.getRef({ owner: OWNER, repo: name, ref: 'heads/main' })
    try {
      await github.rest.git.createRef({ owner: OWNER, repo: name, ref: `refs/heads/${branch}`, sha: main.object.sha })
    } catch (err) {
      if (err.status !== 422) throw err // 422: the branch exists from an earlier attempt
    }
    const open = await github.rest.pulls.list({ owner: OWNER, repo: name, head: `${OWNER}:${branch}`, base: 'stage', state: 'open' })
    if (open.data[0]) return open.data[0]
    const body = [
      `\`main\` has changes that \`stage\` doesn't after v${version}, opened by [Release LMS](${runUrl}). Merge it so the next release from \`stage\` doesn't undo or conflict with them.`,
      '',
      `### Files that differ (${differ.length}${(cmp.files || []).length > 100 ? ', first 100 changed files checked' : ''})`,
      ...differ.map((f) => `- \`${f}\``),
      '',
      'Squash-merge as usual. If GitHub reports conflicts, merge `stage` into this branch and resolve them there. Close it only if `stage` has deliberately replaced these changes.',
    ].join('\n')
    return (await github.rest.pulls.create({ owner: OWNER, repo: name, head: branch, base: 'stage', title: `Sync stage with main after v${version}`, body })).data
  }

  const fail = async (s, at, reason, note, logs) => {
    s.status = 'failed'
    s.stoppedAt = at
    s.note = note
    await publish(s)
    const id = s.whoId ? `<@${s.whoId}>` : esc(s.who)
    if (s.ts) {
      await slack('chat.postMessage', {
        thread_ts: s.ts,
        unfurl_links: false,
        text: `❌ Stopped${at ? ` at *${at}*` : ''}: ${esc(reason)}.${note ? ` ${note}` : ''}\n${id} · <${logs || runUrl}|View logs>`,
      })
    }
    save(s)
    core.setFailed(reason)
  }

  const claimed = new Set()
  const dispatch = async (name, ref, mode, onRun) => {
    const since = Date.now() - 10000
    await github.rest.actions.createWorkflowDispatch({ owner: OWNER, repo: name, workflow_id: WORKFLOW, ref, inputs: { mode } })
    let run = null
    const deadline = Date.now() + RUN_TIMEOUT
    while (Date.now() < deadline) {
      if (!run) {
        const { data } = await github.rest.actions.listWorkflowRuns({
          owner: OWNER, repo: name, workflow_id: WORKFLOW, event: 'workflow_dispatch', branch: ref, per_page: 10,
        })
        run = data.workflow_runs
          .filter((w) => !claimed.has(w.id) && new Date(w.created_at).getTime() >= since)
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0] || null
        if (run) {
          claimed.add(run.id)
          await onRun(run)
        }
      } else {
        run = (await github.rest.actions.getWorkflowRun({ owner: OWNER, repo: name, run_id: run.id })).data
        if (run.status === 'completed') return run
      }
      await sleep(POLL)
    }
    return run ? { ...run, conclusion: 'timed_out' } : { conclusion: 'not_started', html_url: '' }
  }

  if (e.PHASE === 'prepare') {
    const keys = e.REPOS === 'both' ? ORDER : [e.REPOS]
    if (!keys.every((k) => REPOS[k])) throw new Error(`unknown repos ${e.REPOS}`)
    const names = keys.map((k) => REPOS[k].name)

    const tagsByRepo = {}
    for (const k of ORDER) {
      const list = await github.paginate(github.rest.repos.listTags, { owner: OWNER, repo: REPOS[k].name, per_page: 100 })
      tagsByRepo[REPOS[k].name] = list.map((t) => parse(t.name)).filter(Boolean)
    }
    const version = pickVersion(tagsByRepo, e.KIND, names, e.VERSION)
    const kind = e.KIND === 'hotfix' ? 'hotfix' : 'release'
    const base = kind === 'release' ? 'stage' : 'main'
    const branch = `${kind}/${version}`

    for (const name of names) {
      const exists = await github.rest.repos.getBranch({ owner: OWNER, repo: name, branch }).then(() => true, () => false)
      if (exists) throw new Error(`${name} already has ${branch}; delete it or choose another version`)
      if (tagsByRepo[name].some((v) => show(v) === version)) throw new Error(`${name} already has v${version}`)
    }

    const map = (() => {
      try {
        return JSON.parse(e.SLACK_USER_MAP || '{}')
      } catch {
        return {}
      }
    })()
    const whoId = map[context.actor] || null
    const user = whoId ? await slackUser(whoId) : null
    const who = user?.profile?.display_name || user?.real_name || context.actor

    const repos = []
    for (const name of names) {
      const { data: ref } = await github.rest.git.getRef({ owner: OWNER, repo: name, ref: `heads/${base}` })
      await github.rest.git.createRef({ owner: OWNER, repo: name, ref: `refs/heads/${branch}`, sha: ref.object.sha })
      repos.push({ name, base, branch, sha: ref.object.sha.slice(0, 7), state: 'waiting' })
    }

    const withApp = names.includes(REPOS.app.name)
    const backup = withApp ? { state: e.SKIP_BACKUP === 'true' ? 'skipped' : 'waiting' } : null
    const s = { kind, version, branch, repos, who, whoId, backup, status: 'branches', ts: '' }
    await publish(s)
    save(s)
    await core.summary
      .addHeading(`LMS ${kind} v${version}`, 2)
      .addList(repos.map((r) => `${r.name}: <code>${branch}</code> from <code>${base}</code> at ${r.sha}`))
      .addRaw('Cherry-pick what the release needs onto these branches, then approve <b>release-branches</b> to open the PRs.', true)
      .write()
    return
  }

  const s = JSON.parse(e.STATE)

  if (e.PHASE === 'open-prs') {
    const title = `${s.kind === 'release' ? 'Release' : 'Hotfix'} ${s.version}`
    const sections = []
    for (const r of s.repos) {
      const { data: cmp } = await github.rest.repos.compareCommitsWithBasehead({
        owner: OWNER, repo: r.name, basehead: `main...${r.branch}`,
      })
      r.commits = cmp.total_commits
      r.migrations = (cmp.files || []).filter((f) => MIGRATIONS.test(f.filename) && f.status !== 'removed').map((f) => f.filename)
      const commits = cmp.commits.slice(-50).map((c) => `- ${c.sha.slice(0, 7)} ${c.commit.message.split('\n')[0]}`).join('\n')
      const migrations = r.migrations.length ? `\n\n### Migrations (${r.migrations.length})\n${r.migrations.map((m) => `- \`${m}\``).join('\n')}` : ''
      const body = `${title} of the LMS, opened by [Release LMS](${runUrl}). The same run builds, deploys and merges it after approval (backend first). Don't merge by hand.\n\n### Commits (${r.commits})\n${commits}${migrations}`
      const existing = await github.rest.pulls.list({ owner: OWNER, repo: r.name, head: `${OWNER}:${r.branch}`, base: 'main', state: 'open' })
      const pr = existing.data[0] || (await github.rest.pulls.create({ owner: OWNER, repo: r.name, head: r.branch, base: 'main', title, body })).data
      r.pr = pr.number
      sections.push(`<b>${r.name}</b>: <a href="${pr.html_url}">#${pr.number}</a>, ${r.commits} commits`)
      if (r.migrations.length) sections.push(`Migrations that run on deploy:<ul>${r.migrations.map((m) => `<li><code>${m}</code></li>`).join('')}</ul>`)
    }
    s.status = 'prs'
    await publish(s)
    save(s)
    await core.summary
      .addHeading(`LMS ${s.kind} v${s.version}: review`, 2)
      .addRaw(sections.join('<br>'), true)
      .addRaw('<br>Review and approve the PRs, then approve <b>production</b> to build, back up and deploy.', true)
      .write()
    return
  }

  if (e.PHASE === 'ship') {
    s.status = 'shipping'
    s.note = ''
    const started = Date.now()

    const pending = []
    for (const r of s.repos) {
      let pr
      for (let i = 0; i < 6; i++) {
        pr = (await github.graphql(
          'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){state mergeStateStatus reviewDecision}}}',
          { o: OWNER, r: r.name, n: r.pr },
        )).repository.pullRequest
        if (pr.state !== 'OPEN' || pr.mergeStateStatus !== 'UNKNOWN') break
        await sleep(5000)
      }
      if (pr.state === 'MERGED') {
        r.state = 'ok'
        continue
      }
      if (pr.state !== 'OPEN' || !READY.includes(pr.mergeStateStatus)) {
        const why = pr.state !== 'OPEN' ? pr.state.toLowerCase()
          : pr.reviewDecision !== 'APPROVED' ? 'not approved' : `not mergeable (${pr.mergeStateStatus.toLowerCase()})`
        pending.push(`${r.name} #${r.pr} ${why}`)
      }
    }
    if (pending.length) return fail(s, '', `PRs not ready: ${pending.join('; ')}`, 'Nothing was built or deployed.')

    const todo = s.repos.filter((r) => r.state !== 'ok')
    if (s.backup && s.backup.state !== 'skipped' && !todo.some((r) => r.name === REPOS.app.name)) s.backup.state = 'ok'
    for (const r of todo) Object.assign(r, { state: 'building', took: '', run: '' })
    await publish(s)
    const builds = await Promise.all(todo.map((r) => dispatch(r.name, r.branch, 'build', async (run) => {
      r.run = run.html_url
      await publish(s)
    })))
    todo.forEach((r, i) => {
      r.state = builds[i].conclusion === 'success' ? 'built' : 'failed'
    })
    const broken = todo.findIndex((r) => r.state === 'failed')
    if (broken >= 0) {
      const names = todo.filter((r) => r.state === 'failed').map((r) => r.name).join(', ')
      return fail(s, names, `build ${builds[broken].conclusion}`, 'Nothing was deployed. Fix the release branch, then Re-run failed jobs.', builds[broken].html_url)
    }
    await publish(s)

    const app = todo.find((r) => r.name === REPOS.app.name)
    if (app && s.backup && s.backup.state !== 'skipped') {
      s.backup.state = 'running'
      s.backup.run = ''
      await publish(s)
      const run = await dispatch(app.name, app.branch, 'backup', async (w) => {
        s.backup.run = w.html_url
        await publish(s)
      })
      s.backup.state = run.conclusion === 'success' ? 'ok' : 'failed'
      if (run.conclusion !== 'success') {
        return fail(s, 'database backup', `backup ${run.conclusion}`, 'Nothing was deployed. Check the backup, then Re-run failed jobs.', run.html_url)
      }
      await publish(s)
    }

    for (const r of todo) {
      r.state = 'deploying'
      r.run = ''
      await publish(s)
      const run = await dispatch(r.name, r.branch, 'deploy', async (w) => {
        r.run = w.html_url
        await publish(s)
      })
      r.took = run.run_started_at ? duration(new Date(run.updated_at) - new Date(run.run_started_at)) : ''
      if (run.conclusion !== 'success') {
        r.state = 'failed'
        const note = r.name === REPOS.app.name
          ? 'The previous backend keeps serving. Migrations may have partly run: check the logs, fix forward, and restore the pre-release backup only if data is damaged.'
          : 'The new backend stays live (it works with the previous frontend); the previous frontend keeps serving. Fix the release branch, then Re-run failed jobs.'
        return fail(s, r.name, `deploy ${run.conclusion}`, note, run.html_url)
      }
      await github.rest.pulls.merge({
        owner: OWNER, repo: r.name, pull_number: r.pr, merge_method: 'merge',
        commit_message: `${MARKER} ${runUrl}\n[skip actions]`,
      })
      r.state = 'ok'
      await publish(s)
    }

    // The release is out; a failure here only changes the note.
    const syncs = []
    for (const r of s.repos) {
      try {
        const pr = await syncStage(r.name, s.version)
        if (pr) syncs.push(`<${pr.html_url}|${r.name} #${pr.number}>`)
      } catch (err) {
        core.warning(`${r.name}: couldn't open the stage sync PR: ${err.message}`)
        syncs.push(`${r.name}: sync PR failed, compare main with stage by hand`)
      }
    }

    s.status = 'released'
    s.took = duration(Date.now() - started)
    s.note = [
      syncs.length ? `main has changes stage doesn't: merge ${syncs.join(', ')} into stage.` : '',
      s.kind === 'hotfix' ? 'Make the same fix on develop if it applies.' : '',
    ].filter(Boolean).join(' ')
    await publish(s)
    save(s)
    return
  }

  if (e.PHASE === 'cancel') {
    s.status = 'cancelled'
    s.note = `Branches${s.repos.some((r) => r.pr) ? ' and PRs' : ''} kept; delete or close them if not needed.`
    await publish(s)
    return
  }

  throw new Error(`unknown phase ${e.PHASE}`)
}

module.exports.pickVersion = pickVersion
