const SLACK = 'https://slack.com/api/'
const TIMEOUT = 10000

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

  // Read methods take form parameters, not JSON.
  const lookupByEmail = async (email) => {
    try {
      const res = await fetch(`${SLACK}users.lookupByEmail?email=${encodeURIComponent(email)}`, {
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
  const app = e.DEPLOY_APP || repo
  const envName = e.DEPLOY_ENV || branch
  const site = e.DEPLOY_URL || ''
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const { data: commit } = await github.rest.repos.getCommit({ owner, repo, ref: sha })
  const commitAuthor = {
    login: commit.author?.login,
    email: commit.commit.author?.email,
    name: commit.commit.author?.name,
  }
  const manual = context.eventName === 'workflow_dispatch'
  const starter = manual ? { login: context.actor } : commitAuthor

  // Mentions ping; the running message names people, only a failure reply mentions them.
  const resolve = async (p) => {
    let user = null
    if (p.email && !p.email.endsWith('@users.noreply.github.com')) user = await lookupByEmail(p.email)
    const id = user?.id || (p.login && userMap[p.login]) || null
    const name = user?.profile?.display_name || user?.real_name || p.name || p.login || 'unknown'
    return { key: id || p.login || p.email, id, name, mention: id ? `<@${id}>` : p.login || name }
  }

  const header = (icon, text, tail = '') => `${icon} ${text} · *${app}* → ${envName}${tail}`

  const buildBody = async () => {
    const who = await resolve(starter)
    const title = esc(commit.commit.message.split('\n')[0].slice(0, 120))
    let changes = ''
    try {
      const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: context.runId })
      const { data: prev } = await github.rest.actions.listWorkflowRuns({
        owner, repo, workflow_id: run.workflow_id, branch, status: 'success', per_page: 10,
      })
      const last = prev.workflow_runs.find((r) => r.id !== run.id && r.head_sha !== sha)
      if (last) {
        const { data: cmp } = await github.rest.repos.compareCommitsWithBasehead({
          owner, repo, basehead: `${last.head_sha}...${sha}`,
        })
        const n = cmp.total_commits
        changes = ` · <${repoUrl}/compare/${last.head_sha.slice(0, 7)}...${short}|${n} commit${n === 1 ? '' : 's'} since last deploy>`
      }
    } catch (err) {
      core.info(`no change summary: ${err.message}`)
    }
    const via = manual ? ' (manual run)' : ''
    return `${esc(who.name)}${via} · ${esc(branch)} · <${repoUrl}/commit/${sha}|${short}> ${title}${changes} · <${runUrl}|run>`
  }

  if (e.PHASE === 'start') {
    const body = await buildBody()
    const res = await slack('chat.postMessage', {
      channel, text: `${header('🟡', 'Deploying')}\n${body}`, unfurl_links: false, unfurl_media: false,
    })
    core.setOutput('ts', res.ts)
    core.setOutput('body', body)
    return
  }

  if (e.PHASE !== 'finish') throw new Error(`unknown phase ${e.PHASE}`)

  const needs = JSON.parse(e.NEEDS || '{}')
  const results = [needs.build?.result, needs.deploy?.result]
  const outcome = results.includes('failure') ? 'failure' : needs.deploy?.result === 'success' ? 'success' : 'cancelled'

  const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: context.runId })
  const secs = Math.max(0, Math.round((Date.now() - new Date(run.run_started_at).getTime()) / 1000))
  const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
  const host = site.replace(/^https?:\/\//, '').replace(/\/$/, '')

  const first = {
    success: header('✅', 'Deployed', ` · ${took}${site ? ` · <${site}|${host}>` : ''}`),
    failure: header('❌', 'Deploy failed', ` · ${took}`),
    cancelled: header('⚪', 'Deploy cancelled', ` · ${took}`),
  }[outcome]

  const body = e.SLACK_BODY || (await buildBody())
  const text = `${first}\n${body}`
  let ts = e.SLACK_TS
  if (ts) {
    await slack('chat.update', { channel, ts, text })
  } else {
    ts = (await slack('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false })).ts
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
  try {
    const { data: prs } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: sha })
    const pr = prs.find((p) => p.merged_at) || prs[0]
    if (pr) {
      const login = pr.user.login
      const { data: commits } = await github.rest.pulls.listCommits({ owner, repo, pull_number: pr.number, per_page: 100 })
      const own = commits.find((c) => c.author?.login === login)
      people.push({ login, email: own?.commit.author?.email })
    }
  } catch (err) {
    core.info(`no pull request author: ${err.message}`)
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
    text: `❌ Failed at *${esc(where)}*. The previous version keeps serving. ${mentions.join(' ')} · <${logs}|logs>`,
  })
}
