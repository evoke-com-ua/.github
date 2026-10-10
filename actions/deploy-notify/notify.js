const SLACK = 'https://slack.com/api/'
const TIMEOUT = 10000

const STATES = {
  start: { icon: '🟡', label: 'Deploying', color: '#ecb22e' },
  success: { icon: '✅', label: 'Deployed', color: '#2eb67d' },
  failure: { icon: '❌', label: 'Deploy failed', color: '#e01e5a' },
  cancelled: { icon: '⚪', label: 'Deploy cancelled', color: '#9e9ea6' },
}

const RELEASES = {
  release: {
    icon: '🚀',
    label: { start: 'Releasing', success: 'Released', failure: 'Release', cancelled: 'Release' },
    suffix: { failure: ' failed', cancelled: ' cancelled' },
  },
  hotfix: {
    icon: '🩹',
    label: { start: 'Deploying hotfix', success: 'Hotfix', failure: 'Hotfix', cancelled: 'Hotfix' },
    suffix: { success: ' deployed', failure: ' failed', cancelled: ' cancelled' },
  },
}
const RELEASE_COLOR = '#7c3aed'

module.exports = async ({ github, context, core }) => {
  try {
    await run({ github, context, core })
  } catch (err) {
    core.warning(`Slack notification skipped: ${err.message}`)
  }
}

async function run({ github, context, core }) {
  const e = process.env
  const token = e.SLACK_TOKEN
  const channel = e.SLACK_CHANNEL
  if (!token || !channel) {
    core.warning('SLACK_TOKEN or SLACK_CHANNEL is empty; nothing posted')
    return
  }

  const slack = async (method, body) => {
    const res = await fetch(SLACK + method, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const json = await res.json()
    if (!json.ok) throw new Error(`${method}: ${json.error}`)
    return json
  }

  // Read methods take query parameters, not JSON; a miss is not an error.
  const slackUser = async (method, params) => {
    try {
      const res = await fetch(`${SLACK}${method}?${new URLSearchParams(params)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT),
      })
      const json = await res.json()
      return json.ok ? json.user : null
    } catch {
      return null
    }
  }

  let userMap = {}
  try {
    userMap = JSON.parse(e.SLACK_USER_MAP || '{}')
  } catch {
    core.warning('SLACK_USER_MAP is not valid JSON; ignored')
  }

  const { owner, repo } = context.repo
  const repoUrl = `${context.serverUrl}/${owner}/${repo}`
  const runUrl = `${repoUrl}/actions/runs/${context.runId}`
  const sha = context.sha
  const short = sha.slice(0, 7)
  const branch = context.ref.replace(/^refs\/heads\//, '')
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const app = esc(e.DEPLOY_APP || repo)
  const envName = esc(e.DEPLOY_ENV || branch)
  const site = e.DEPLOY_URL || ''
  const host = site.replace(/^https?:\/\//, '').replace(/\/$/, '')

  const { data: commit } = await github.rest.repos.getCommit({ owner, repo, ref: sha })
  const commitAuthor = {
    login: commit.author?.login,
    email: commit.commit.author?.email,
    name: commit.commit.author?.name,
  }
  const manual = context.eventName === 'workflow_dispatch'
  const starter = manual ? { login: context.actor } : commitAuthor

  // The Slack name is shown everywhere; only a failure reply mentions (pings) people.
  const resolve = async (p) => {
    let user = null
    if (p.email && !p.email.endsWith('@users.noreply.github.com')) user = await slackUser('users.lookupByEmail', { email: p.email })
    const id = user?.id || (p.login && userMap[p.login]) || null
    if (id && !user) user = await slackUser('users.info', { user: id })
    const name = user?.profile?.display_name || user?.real_name || p.name || p.login || 'unknown'
    return { key: id || p.login || p.email, id, name, mention: id ? `<@${id}>` : p.login || name }
  }

  // Where the commit came from: its merged pull request, else GitHub's merge message, else the commit itself.
  const source = async () => {
    const [subject, ...rest] = commit.commit.message.split('\n')
    let pr = null
    try {
      const { data: prs } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: sha })
      pr = prs.find((p) => p.merge_commit_sha === sha) || prs.find((p) => p.merged_at) || null
    } catch (err) {
      core.info(`no pull request: ${err.message}`)
    }
    if (pr) return { pr, number: pr.number, from: pr.head.ref, title: pr.title }
    const merge = subject.match(/^Merge pull request #(\d+) from [^/\s]+\/(\S+)/)
    if (merge) return { number: +merge[1], from: merge[2], title: rest.find((l) => l.trim()) || subject }
    const squash = subject.match(/^(.*) \(#(\d+)\)$/)
    if (squash) return { number: +squash[2], title: squash[1] }
    return { title: subject }
  }

  // The parts of the message that don't change when the run ends; passed from start to finish.
  const buildView = async (src) => {
    const who = await resolve(starter)
    const pr = src.number ? `<${repoUrl}/pull/${src.number}|#${src.number}> ` : ''
    const rel = branch === 'main' && src.from?.match(/^(release|hotfix)\/(\d+\.\d+\.\d+)$/)
    return {
      release: rel ? { kind: rel[1], tag: `v${rel[2]}` } : null,
      branch: `🌿 \`${esc(branch)}\`${src.from ? ` ← \`${esc(src.from)}\`` : ''}${manual ? ' · manual run' : ''}`,
      title: pr + esc(src.title.trim().slice(0, 150)),
      who: esc(who.name),
    }
  }

  const message = (state, view, tail = '') => {
    let { icon, label, color } = STATES[state]
    let title = view.title
    const rel = view.release
    if (rel) {
      const r = RELEASES[rel.kind]
      if (state === 'start' || state === 'success') icon = r.icon
      if (state === 'start') color = RELEASE_COLOR
      label = `${r.label[state]} ${rel.tag}${r.suffix[state] || ''}`
      if (state === 'success') title += ` · <${repoUrl}/releases/tag/${rel.tag}|Release notes>`
    }
    const meta = [view.who, `<${repoUrl}/commit/${sha}|${short}>`, `<${runUrl}|View run>`]
    if (state === 'success' && site) meta.push(`<${site}|${host}>`)
    return {
      text: `${icon} *${label}* · *${app}* · *${envName}*${tail}`,
      attachments: [{
        color,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `${view.branch}\n${title}` } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: meta.join(' · ') }] },
        ],
      }],
      unfurl_links: false,
      unfurl_media: false,
    }
  }

  if (e.PHASE === 'start') {
    const view = await buildView(await source())
    const res = await slack('chat.postMessage', { channel, ...message('start', view) })
    core.setOutput('ts', res.ts)
    core.setOutput('body', JSON.stringify(view))
    return
  }

  if (e.PHASE !== 'finish') throw new Error(`unknown phase ${e.PHASE}`)

  const needs = JSON.parse(e.NEEDS || '{}')
  const results = [needs.build?.result, needs.deploy?.result]
  const outcome = results.includes('failure') ? 'failure' : needs.deploy?.result === 'success' ? 'success' : 'cancelled'

  const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: context.runId })
  const secs = Math.max(0, Math.round((Date.now() - new Date(run.run_started_at).getTime()) / 1000))
  const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`

  // A start from before this format passed a plain text line; rebuild in that case.
  let view = null
  try {
    view = JSON.parse(e.SLACK_BODY)
  } catch {}
  const src = !view?.branch || outcome === 'failure' ? await source() : null
  if (!view?.branch) view = await buildView(src)

  const msg = message(outcome, view, ` · ${took}`)
  let ts = e.SLACK_TS
  if (ts) {
    await slack('chat.update', { channel, ts, text: msg.text, attachments: msg.attachments })
  } else {
    ts = (await slack('chat.postMessage', { channel, ...msg })).ts
  }
  core.setOutput('ts', ts)

  if (outcome !== 'failure') return

  // An edit notifies nobody, so the failure goes out as a broadcast reply that mentions people.
  let where = 'unknown step'
  let logs = runUrl
  try {
    const { data } = await github.rest.actions.listJobsForWorkflowRun({
      owner, repo, run_id: context.runId, filter: 'latest', per_page: 100,
    })
    const job = data.jobs.find((j) => j.conclusion === 'failure')
    if (job) {
      const step = (job.steps || []).find((s) => s.conclusion === 'failure')
      where = step ? `${job.name} / ${step.name}` : job.name
      logs = job.html_url
    }
  } catch (err) {
    core.info(`no failed step: ${err.message}`)
  }

  const people = [starter]
  if (manual) people.push(commitAuthor)
  if (src.pr) {
    const login = src.pr.user.login
    let email
    try {
      const { data: commits } = await github.rest.pulls.listCommits({ owner, repo, pull_number: src.pr.number, per_page: 100 })
      email = commits.find((c) => c.author?.login === login)?.commit.author?.email
    } catch (err) {
      core.info(`no pull request author email: ${err.message}`)
    }
    people.push({ login, email })
  }

  const seen = new Set()
  const mentions = []
  for (const p of people) {
    if (!p.login && !p.email) continue
    const r = await resolve(p)
    if (seen.has(r.key)) continue
    seen.add(r.key)
    mentions.push(r.mention)
  }

  await slack('chat.postMessage', {
    channel,
    thread_ts: ts,
    reply_broadcast: true,
    unfurl_links: false,
    text: `❌ Failed at *${esc(where)}*. The previous version keeps serving.\n${mentions.join(' ')} · <${logs}|View logs>`,
  })
}
