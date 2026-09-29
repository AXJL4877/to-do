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

/** 切换当前内容键：异步读回该键已落盘的帧号 */
export function useDiskKey(key: string): Promise<void> {
  if (key === currentKey) return indexReady
  if (currentKey) void flushMeta()
  currentKey = key
  index = new Set()
  pendingReads.clear()
  const mine = index
  indexReady = (async () => {
    await loadKeys()
    const db = await openDb()
    if (!db || currentKey !== key) return
    const keys = await req(db.transaction(FRAMES).objectStore(FRAMES).getAllKeys(frameRange(key)))
    if (currentKey !== key) return
    for (const k of keys) mine.add((k as [string, number])[1])
    scheduleMetaFlush()
    void pruneOldKeys()
  })().catch(() => {})
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

/** 画布内容在调用瞬间快照，调用后可立即复用 source；落盘成功才进索引 */
export function diskWrite(frame: number, source: HTMLCanvasElement): Promise<boolean> {
  const key = currentKey
  if (!key || index.has(frame) || !diskWritable()) return Promise.resolve(false)
  pendingWrites++
  return new Promise<Blob | null>((resolve) => source.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
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
