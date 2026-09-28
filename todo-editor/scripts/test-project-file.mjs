/** 工程文件读写自检：relPath 写入、整体搬家后找回、.bak 备份、最近工程列表 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createRecentProjects, writeProjectFile, readProjectFile } = require('../electron/projectFile.cjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-projfile-'))
try {
  const projDir = path.join(root, 'job')
  fs.mkdirSync(path.join(projDir, 'media'), { recursive: true })
  const clip = path.join(projDir, 'media', 'a.mp4')
  fs.writeFileSync(clip, 'x')
  const file = path.join(projDir, 'job.todo.json')

  writeProjectFile(file, {
    version: 2,
    media: [
      { id: 'm1', name: 'a.mp4', url: 'file:///old', path: clip },
      { id: 'm2', name: 'gone.mp4', url: 'file:///gone', path: path.join(root, 'nowhere', 'gone.mp4') },
      { id: 'm3', name: 'data', url: 'data:image/png;base64,' },
    ],
  })
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.media[0].relPath, 'media/a.mp4')
  assert.ok(saved.savedAt)
  assert.ok(!fs.existsSync(`${file}.tmp`))
  assert.ok(!fs.existsSync(`${file}.bak`), '首次保存不应有 .bak')

  writeProjectFile(file, { version: 2, media: saved.media, marker: 2 })
  assert.ok(fs.existsSync(`${file}.bak`), '覆盖保存应留 .bak')
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).marker, undefined)

  const moved = path.join(root, 'moved')
  fs.renameSync(projDir, moved)
  const r = readProjectFile(path.join(moved, 'job.todo.json'))
  assert.equal(r.relinked, 1)
  assert.equal(r.missing, 1)
  assert.equal(r.data.media[0].path, path.join(moved, 'media', 'a.mp4'))
  assert.ok(r.data.media[0].url.startsWith('file:'))
  assert.equal(r.data.media[2].url, 'data:image/png;base64,')

  const recent = createRecentProjects(() => path.join(root, 'recent.json'))
  recent.push('C:\\a\\one.todo.json')
  recent.push('C:\\a\\two.todo.json')
  recent.push('c:\\A\\ONE.todo.json')
  assert.deepEqual(recent.list(), ['c:\\A\\ONE.todo.json', 'C:\\a\\two.todo.json'])
  recent.remove('C:\\a\\two.todo.json')
  assert.deepEqual(recent.list(), ['c:\\A\\ONE.todo.json'])

  console.log('project-file: ok')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
