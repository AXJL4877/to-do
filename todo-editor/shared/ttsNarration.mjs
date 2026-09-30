/** Voice completion is independent of the later picture-generation status. */
export function availableNarration(job) {
  for (const n of [job?.params?.output?.narration, job?.params?.partial?.voice]) {
    if (typeof n?.text === 'string' && n.text.trim()
      && typeof n.audio === 'string' && n.audio
      && typeof n.timing === 'string' && n.timing) return n
  }
  return null
}

export function narrationJobId(url) {
  return typeof url === 'string' ? /(?:\/|\\)(s_[A-Za-z0-9]+_[A-Za-z0-9]+)(?:_voice\.wav|\.webm|\.mp4)(?:[?#].*)?$/.exec(url)?.[1] ?? null : null
}

/** Server-side fallback also recognizes project-local copies sent by older clients. */
export function subtitleNarrationSource(body, findJob) {
  const candidates = [...new Set([body.sourceJobId, narrationJobId(body.sourceMedia?.url), narrationJobId(body.sourceMedia?.path)].filter(Boolean))]
  for (const id of candidates) {
    const job = findJob(id)
    const n = availableNarration(job)
    if (n) return { mode: 'script', jobId: job.id, text: n.text, audio: n.audio, timing: n.timing, duration: n.duration }
  }
  return null
}
