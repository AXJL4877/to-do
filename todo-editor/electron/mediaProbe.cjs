const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const fail = (backend, code, message) => ({ ok: false, backend, error: { code, message } })
function valid(result) {
  return result && typeof result.ok === 'boolean' && (result.ok
    ? Number.isFinite(result.duration) && result.duration >= 0 && typeof result.hasVideo === 'boolean' && typeof result.hasAudio === 'boolean' && (result.hasVideo || result.hasAudio) && ['width', 'height', 'frameRate'].every(k => result[k] === undefined || (Number.isFinite(result[k]) && result[k] >= 0))
    : typeof result.error?.code === 'string' && typeof result.error?.message === 'string')
}
function normalize(raw) {
  if (!Array.isArray(raw.streams)) throw new Error('missing streams')
  const video = raw.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = raw.streams.find(s => s.codec_type === 'audio')
  if (!video && !audio) return { ok: false, error: { code: 'NO_MEDIA_STREAM', message: '没有音视频流' } }
  const durations = [raw.format?.duration, ...raw.streams.map(s => s.duration)].map(Number).filter(n => Number.isFinite(n) && n >= 0)
  const result = { ok: true, duration: Math.max(0, ...durations), format: raw.format?.format_name || '', hasVideo: !!video, hasAudio: !!audio }
  if (video) {
    result.width = video.width; result.height = video.height
    const [n, d] = String(video.avg_frame_rate || '0/1').split('/').map(Number)
    result.frameRate = d && Number.isFinite(n / d) ? n / d : 0
  }
  return result
}
// Only absence of the executable selects the transitional backend. Native runtime
// errors (including missing DLLs/corrupt media) must never silently fall back.
function defaultFfprobe() {
  if (process.env.FFPROBE) return process.env.FFPROBE
  const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Links/ffprobe.exe')
  return process.platform === 'win32' && fs.existsSync(winget) ? winget : 'ffprobe'
}
function createMediaProbe({
  enginePath,
  nativePath,
  ffprobePath = defaultFfprobe(),
  run = execFile,
}) {
  let active = 0
  let warnedTransition = false
  return async function probe(payload = {}) {
    const engine = enginePath && fs.existsSync(enginePath)
    const legacy = nativePath && fs.existsSync(nativePath)
    const backend = engine ? 'todo-cpp-ffmpeg' : legacy ? 'native-libavformat' : 'ffprobe-transition'
    const { filePath, timeoutMs = 10000 } = payload || {}
    try {
      if (typeof filePath !== 'string' || filePath.includes('\0') || !path.isAbsolute(filePath) || !fs.statSync(filePath).isFile()) throw new Error('invalid path')
    } catch { return fail(backend, 'INVALID_PATH', '媒体路径无效') }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) return fail(backend, 'INVALID_TIMEOUT', '超时必须为 100–30000 毫秒整数')
    if (active >= 4) return fail(backend, 'BUSY', '探测任务繁忙，请稍后重试')
    if (backend === 'ffprobe-transition' && !warnedTransition) {
      warnedTransition = true
      console.warn('[media-probe] C/C++ 原生引擎尚未构建，暂用 ffprobe-transition')
    }
    const exe = engine ? enginePath : legacy ? nativePath : ffprobePath
    const args = engine
      ? ['probe', filePath, String(timeoutMs)]
      : legacy
        ? [filePath, String(timeoutMs)]
        : ['-v', 'error', '-protocol_whitelist', 'file', '-probesize', '8388608', '-analyzeduration', '5000000', '-show_entries', 'format=duration,format_name:stream=codec_type,width,height,duration,avg_frame_rate:stream_disposition=attached_pic', '-of', 'json', '-i', filePath]
    active++
    try {
      return await new Promise(resolve => {
        run(exe, args, { windowsHide: true, shell: false, encoding: 'utf8', timeout: timeoutMs + 1000, killSignal: 'SIGKILL', maxBuffer: 65536 }, (error, stdout) => {
          if (error?.killed) return resolve(fail(backend, 'PROBE_TIMEOUT', '媒体探测超时'))
          if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve(fail(backend, 'OUTPUT_LIMIT', '探测输出超过限制'))
          if (error && backend === 'ffprobe-transition') {
            return resolve(fail(backend, error.code === 'ENOENT' ? 'BACKEND_UNAVAILABLE' : 'PROBE_FAILED', error.code === 'ENOENT' ? '原生程序未构建，且找不到过渡 ffprobe；请将 ffprobe 加入 PATH 或设置 FFPROBE' : 'ffprobe 无法读取该媒体'))
          }
          try {
            const result = backend === 'ffprobe-transition' ? normalize(JSON.parse(stdout)) : JSON.parse(stdout)
            if (!valid(result) || (error && result.ok)) throw new Error('invalid result')
            resolve({ ...result, backend })
          } catch { resolve(fail(backend, 'INVALID_OUTPUT', '探测器输出无效或启动失败')) }
        })
      })
    } catch (error) { return fail(backend, 'SPAWN_FAILED', error.message) }
    finally { active-- }
  }
}
module.exports = { createMediaProbe }
