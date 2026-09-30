/**
 * 节目预览二级缓存（磁盘，IndexedDB）：RAM 放不下的帧压 JPEG 落盘，重开工程也能复用。
 * 同一时刻只服务一个内容键（当前序列 + 缓存分辨率 + 素材文件），旧键按最近使用淘汰。
 */

const DB_NAME = 'todo-preview-cache'
const FRAMES = 'frames'
const KEYS = 'keys'
const GB = 1024 * 1024 * 1024
const DEFAULT_LIMIT = 10 * GB
const EXPIRE_MS = 7 * 24 * 3600 * 1000
const JPEG_QUALITY = 0.9
const MAX_PENDING_WRITES = 6
const MAX_PENDING_READS = 4

type FrameRec = { k: string; f: number; blob: Blob }
type KeyRec = { k: string; bytes: number; used: number }

let dbPromise: Promise<IDBDatabase | null> | null = null
let userLimit = DEFAULT_LIMIT
let quotaLimit = Infinity
let limitBytes = DEFAULT_LIMIT
const keyBytes = new Map<string, number>()
let keysLoaded: Promise<void> | null = null
/** 各键占用读回之前不写盘，免得记账错乱 */
let keysReady = false

let currentKey = ''
let index = new Set<number>()
let indexReady: Promise<void> = Promise.resolve()
let pendingWrites = 0
const pendingReads = new Set<number>()
let metaTimer = 0
let pruning = false

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => {
      const db = open.result
      if (!db.objectStoreNames.contains(FRAMES)) db.createObjectStore(FRAMES, { keyPath: ['k', 'f'] })
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS, { keyPath: 'k' })
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => resolve(null)
    open.onblocked = () => resolve(null)
  })
  void navigator.storage?.estimate?.().then((e) => {
    if (e.quota) quotaLimit = Math.floor(e.quota * 0.5)
    limitBytes = Math.min(userLimit, quotaLimit)
  }).catch(() => {})
  return dbPromise
}

/** 用户设定的磁盘上限（GB）；实际上限还受系统配额一半约束，调小立即按最近使用淘汰 */
export function setDiskCacheLimitGb(gb: number) {
  userLimit = Math.max(1, gb) * GB
  limitBytes = Math.min(userLimit, quotaLimit)
  void loadKeys().then(() => pruneOldKeys())
}

function loadKeys(): Promise<void> {
  if (keysLoaded) return keysLoaded
  keysLoaded = (async () => {
    const db = await openDb()
    if (!db) return
    const recs = await req(db.transaction(KEYS).objectStore(KEYS).getAll() as IDBRequest<KeyRec[]>)
    const cutoff = Date.now() - EXPIRE_MS
    const expired = recs.filter((r) => r.used < cutoff && r.k !== currentKey)
    for (const r of recs) if (!expired.includes(r)) keyBytes.set(r.k, r.bytes)
    keysReady = true
    if (expired.length) await deleteKeys(db, expired.map((r) => r.k))
  })().catch(() => {})
  return keysLoaded
}

async function deleteKeys(db: IDBDatabase, keys: string[]) {
  const tx = db.transaction([FRAMES, KEYS], 'readwrite')
  for (const k of keys) {
    tx.objectStore(FRAMES).delete(frameRange(k))
    tx.objectStore(KEYS).delete(k)
  }
  await txDone(tx).catch(() => {})
}

function frameRange(k: string) {
  return IDBKeyRange.bound([k, -Infinity], [k, Infinity])
}

export function totalDiskBytes() {
  let n = 0
  for (const b of keyBytes.values()) n += b
  return n
}

function scheduleMetaFlush() {
  if (metaTimer) return
  metaTimer = window.setTimeout(() => {
    metaTimer = 0
    void flushMeta()
  }, 1000)
}

async function flushMeta() {
  const db = await openDb()
  if (!db || !currentKey) return
  const tx = db.transaction(KEYS, 'readwrite')
  tx.objectStore(KEYS).put({ k: currentKey, bytes: keyBytes.get(currentKey) ?? 0, used: Date.now() } satisfies KeyRec)
  await txDone(tx).catch(() => {})
}

/** 超额时按最近使用淘汰旧内容键；当前键永不淘汰 */
async function pruneOldKeys() {
  if (pruning || totalDiskBytes() <= limitBytes) return
  pruning = true
  try {
    const db = await openDb()
    if (!db) return
    const recs = await req(db.transaction(KEYS).objectStore(KEYS).getAll() as IDBRequest<KeyRec[]>)
    recs.sort((a, b) => a.used - b.used)
    for (const r of recs) {
      if (totalDiskBytes() <= limitBytes * 0.9) break
      if (r.k === currentKey) continue
      await deleteKeys(db, [r.k])
      keyBytes.delete(r.k)
    }
  } finally {
    pruning = false
  }
}

/** 旧键上还没挪完的帧：连续改动时合并筛选条件，从最初那份旧键一次挪到位 */
let carry: { from: string; keep: (frame: number) => boolean } | null = null
let carryChain: Promise<void> = Promise.resolve()

/** 把旧键上画面没变的帧改挂到新键（只改键不重编码），其余旧帧删掉 */
async function moveFrames(db: IDBDatabase, from: string, to: string, keep: (frame: number) => boolean, have: Set<number>) {
  const moved: number[] = []
  let bytes = 0
  const tx = db.transaction(FRAMES, 'readwrite')
  const store = tx.objectStore(FRAMES)
  const cursor = store.openCursor(frameRange(from))
  cursor.onsuccess = () => {
    const c = cursor.result
    if (!c) return
    const rec = c.value as FrameRec
    if (keep(rec.f) && !have.has(rec.f)) {
      store.put({ k: to, f: rec.f, blob: rec.blob } satisfies FrameRec)
      moved.push(rec.f)
      bytes += rec.blob.size
    }
    c.delete()
    c.continue()
  }
  await txDone(tx)
  const del = db.transaction(KEYS, 'readwrite')
  del.objectStore(KEYS).delete(from)
  await txDone(del).catch(() => {})
  keyBytes.delete(from)
  keyBytes.set(to, (keyBytes.get(to) ?? 0) + bytes)
  return moved
}

/** 切换当前内容键：异步读回该键已落盘的帧号；给了 keep 就把上一个键里仍有效的帧带过来 */
export function useDiskKey(key: string, keep?: (frame: number) => boolean): Promise<void> {
  if (key === currentKey) return indexReady
  const prev = currentKey
  if (prev) void flushMeta()
  if (carry && carry.from !== key && keep) {
    const before = carry.keep
    carry = { from: carry.from, keep: (f) => before(f) && keep(f) }
  } else carry = prev && keep && prev !== key ? { from: prev, keep } : null
  currentKey = key
  index = new Set()
  pendingReads.clear()
  const mine = index
  const job = carry
  indexReady = carryChain = carryChain.then(async () => {
    await loadKeys()
    const db = await openDb()
    if (!db || currentKey !== key) return
    const keys = await req(db.transaction(FRAMES).objectStore(FRAMES).getAllKeys(frameRange(key)))
    if (currentKey !== key) return
    for (const k of keys) mine.add((k as [string, number])[1])
    if (job && carry === job) {
      for (const f of await moveFrames(db, job.from, key, job.keep, mine)) mine.add(f)
      if (carry === job) carry = null
    }
    scheduleMetaFlush()
    void pruneOldKeys()
  }).catch(() => {})
  return indexReady
}

export function diskReady() {
  return indexReady
}

export function diskHas(frame: number) {
  return index.has(frame)
}

export function diskFrames(): Iterable<number> {
  return index
}

/** 磁盘已满（当前键独占也超额）或不可用时返回 false，调用方就别再往盘上塞 */
export function diskWritable() {
  return keysReady && !!currentKey && totalDiskBytes() < limitBytes
}

export function diskBusy() {
  return pendingWrites >= MAX_PENDING_WRITES
}

const ENCODER_SRC = `
const c = new OffscreenCanvas(1, 1)
const g = c.getContext('2d')
onmessage = async (e) => {
  const { id, bmp, q } = e.data
  try {
    if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height }
    g.drawImage(bmp, 0, 0)
    bmp.close()
    postMessage({ id, blob: await c.convertToBlob({ type: 'image/jpeg', quality: q }) })
  } catch { postMessage({ id, blob: null }) }
}`

let encoder: Worker | null | undefined
let encodeSeq = 0
const encodeWaits = new Map<number, (b: Blob | null) => void>()

function jpegWorker(): Worker | null {
  if (encoder !== undefined) return encoder
  encoder = null
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null
  try {
    const w = new Worker(URL.createObjectURL(new Blob([ENCODER_SRC], { type: 'text/javascript' })))
    w.onmessage = (e: MessageEvent<{ id: number; blob: Blob | null }>) => {
      encodeWaits.get(e.data.id)?.(e.data.blob)
      encodeWaits.delete(e.data.id)
    }
    w.onerror = () => {
      encoder = null
      encodeWaits.forEach((cb) => cb(null))
      encodeWaits.clear()
    }
    encoder = w
  } catch { /* */ }
  return encoder
}

/** JPEG 编码放 Worker：主线程 toBlob 一帧几十毫秒，会卡住拖播放头和缩放 */
function encodeJpeg(source: HTMLCanvasElement): Promise<Blob | null> {
  const w = jpegWorker()
  if (!w) return new Promise((resolve) => source.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
  // createImageBitmap 在调用瞬间取像素，之后 source 可立即复用
  return createImageBitmap(source).then((bmp) => new Promise<Blob | null>((resolve) => {
    const id = ++encodeSeq
    encodeWaits.set(id, resolve)
    w.postMessage({ id, bmp, q: JPEG_QUALITY }, [bmp])
  }), () => null)
}

/** 画布内容在调用瞬间快照，调用后可立即复用 source；落盘成功才进索引 */
export function diskWrite(frame: number, source: HTMLCanvasElement): Promise<boolean> {
  const key = currentKey
  if (!key || index.has(frame) || !diskWritable()) return Promise.resolve(false)
  pendingWrites++
  return encodeJpeg(source)
    .then(async (blob) => {
      if (!blob) return false
      const db = await openDb()
      if (!db) return false
      const tx = db.transaction(FRAMES, 'readwrite')
      tx.objectStore(FRAMES).put({ k: key, f: frame, blob } satisfies FrameRec)
      await txDone(tx)
      keyBytes.set(key, (keyBytes.get(key) ?? 0) + blob.size)
      if (currentKey !== key) return false
      index.add(frame)
      scheduleMetaFlush()
      if (totalDiskBytes() > limitBytes) void pruneOldKeys()
      return true
    })
    .catch(() => false)
    .finally(() => { pendingWrites-- })
}

/** 读回并解码一帧；键已切换、并发满或读失败返回 null */
export async function diskRead(frame: number): Promise<ImageBitmap | null> {
  const key = currentKey
  if (!index.has(frame) || pendingReads.has(frame) || pendingReads.size >= MAX_PENDING_READS) return null
  pendingReads.add(frame)
  try {
    const db = await openDb()
    if (!db) return null
    const rec = await req(db.transaction(FRAMES).objectStore(FRAMES).get([key, frame]) as IDBRequest<FrameRec | undefined>)
    if (!rec || currentKey !== key) return null
    const bmp = await createImageBitmap(rec.blob)
    if (currentKey !== key) {
      bmp.close()
      return null
    }
    return bmp
  } catch {
    return null
  } finally {
    pendingReads.delete(frame)
  }
}

export function diskReadSlots() {
  return MAX_PENDING_READS - pendingReads.size
}

export function diskReadPending(frame: number) {
  return pendingReads.has(frame)
}

export async function clearDiskCache() {
  const db = await openDb()
  index.clear()
  keyBytes.clear()
  if (!db) return
  const tx = db.transaction([FRAMES, KEYS], 'readwrite')
  tx.objectStore(FRAMES).clear()
  tx.objectStore(KEYS).clear()
  await txDone(tx).catch(() => {})
}

/** 同步字符串哈希（cyrb53），用来把很长的内容指纹压成短键 */
export function hashKey(str: string) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}
