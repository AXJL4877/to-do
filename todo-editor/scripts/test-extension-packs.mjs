import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { zipSync, unzipSync, strToU8 } from 'fflate'

const temp = mkdtempSync(path.join(tmpdir(), 'todo-extension-test-'))
process.env.TODO_DATA_DIR = path.join(temp, 'data')
try {
  const { buildExtensionPack, installExtensionPack, uninstallExtensionPack } = await import('../server/extensionPacks.mjs')
  const { listSkillPacks, getSkillEntry } = await import('../server/skillPacks.mjs')
  const source = path.join(temp, 'source')
  mkdirSync(source)
  const manifest = JSON.parse(readFileSync(new URL('../server/skills/dynamic-text/skill.json', import.meta.url), 'utf8'))
  Object.assign(manifest, { id: 'example.package-tests', name: '纸片标题', author: 'Example', version: '1.0.0' })
  writeFileSync(path.join(source, 'skill.json'), JSON.stringify(manifest))
  const packed = buildExtensionPack(source)
  const result = installExtensionPack(packed)
  assert.equal(result.id, manifest.id)
  assert.equal(result.kind, 'skill')
  assert.equal(result.action, 'installed')
  const listed = listSkillPacks().skills.find(p => p.id === manifest.id)
  assert(listed, 'installed pack must enter the existing registry')
  assert.equal(listed.installed, true, 'user-installed packs are removable')
  assert.equal(installExtensionPack(packed).action, 'unchanged')
  assert.throws(() => uninstallExtensionPack({ kind: 'skill', id: 'builtin.chalk-hand' }), /内置/)
  assert.equal(uninstallExtensionPack({ kind: 'skill', id: manifest.id }).action, 'removed')
  assert(!listSkillPacks().skills.some(p => p.id === manifest.id), 'removed pack leaves the registry')
  assert.throws(() => uninstallExtensionPack({ kind: 'skill', id: manifest.id }), /未安装/)
  assert.equal(installExtensionPack(packed).action, 'installed')
  const example = installExtensionPack(readFileSync(new URL('../examples/extensions/paper-titles.todoext', import.meta.url)))
  assert.equal(example.id, 'example.paper-titles')
  assert.equal(example.action, 'installed')
  const { createProduction } = await import('../server/production/job.mjs')
  const { runProduction } = await import('../server/production/runner.mjs')
  const entry = getSkillEntry(manifest.id)
  const doc = createProduction({ skillId: manifest.id, script: '新的扩展使用同一个口播时间轴。', params: { subtitles: 'off' } })
  const outDir = path.join(temp, 'generated'); mkdirSync(outDir)
  await runProduction(doc, { entry, outDir, phase: () => {}, services: {
    synth: async (text, options) => {
      const wav = Buffer.alloc(44 + 16000 * 4 * 2)
      wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
      wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
      wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
      writeFileSync(options.audioFile, wav)
      writeFileSync(options.timingFile, JSON.stringify({ duration: 4, sentences: [{ text, start: 0, end: 4 }] }))
    },
    chat: async () => { throw new Error('offline fallback') },
    image: async () => { throw new Error('must not generate images') },
    render: async () => { throw new Error('must use host text renderer') },
  } })
  assert.equal(doc.status.failed.length, 0)
  assert(doc.segments.every(segment => segment.boards.every(board => board.render.result.dynamicText)), 'installed custom ID must produce editable timed text')
  for (const [kind, name, fixture, registry, list] of [
    ['style', 'style.json', '../server/styles/crayon-doodle/style.json', '../server/stylePacks.mjs', 'listStylePacks'],
    ['animation', 'anim.json', '../server/anims/doodle-figure/anim.json', '../server/animPacks.mjs', 'listAnimPacks'],
  ]) {
    const dir = path.join(temp, kind); mkdirSync(dir)
    const data = JSON.parse(readFileSync(new URL(fixture, import.meta.url), 'utf8'))
    data.id = `example.${kind}`; delete data.previews
    writeFileSync(path.join(dir, name), JSON.stringify(data))
    assert.equal(installExtensionPack(buildExtensionPack(dir)).kind, kind)
    const module = await import(registry)
    assert(JSON.stringify(module[list]()).includes(data.id), `${kind} must enter existing registry`)
  }
  const installed = path.join(process.env.TODO_DATA_DIR, 'skills', manifest.id, 'skill.json')
  const old = readFileSync(installed, 'utf8')
  const entries = unzipSync(packed)
  entries['skill.json'] = strToU8('{}')
  assert.throws(() => installExtensionPack(zipSync(entries)), /校验|完整|hash|SHA|大小/)
  assert.equal(readFileSync(installed, 'utf8'), old, 'bad upgrade must preserve installed files')
  manifest.description += ' changed'
  writeFileSync(path.join(source, 'skill.json'), JSON.stringify(manifest))
  assert.throws(() => installExtensionPack(buildExtensionPack(source)), /同版本/)
  assert.equal(readFileSync(installed, 'utf8'), old)
  assert.throws(() => installExtensionPack(zipSync({ '../outside.txt': strToU8('bad') })), /路径/)
  assert(!existsSync(path.join(temp, 'outside.txt')))
  assert.throws(() => installExtensionPack(zipSync({ 'CON.txt': strToU8('bad') })), /路径/)
  assert.throws(() => installExtensionPack(zipSync({ 'skill.json': strToU8('{}') })), /extension.json/)
  manifest.version = '1.1.0'
  writeFileSync(path.join(source, 'skill.json'), JSON.stringify(manifest))
  assert.equal(installExtensionPack(buildExtensionPack(source)).action, 'updated')
  assert.throws(() => installExtensionPack(packed), /旧版本|降级/)
  manifest.id = 'builtin.dynamic-text'
  writeFileSync(path.join(source, 'skill.json'), JSON.stringify(manifest))
  assert.throws(() => buildExtensionPack(source), /builtin|内置/)
  manifest.id = 'example.http-titles'
  writeFileSync(path.join(source, 'skill.json'), JSON.stringify(manifest))
  const upload = buildExtensionPack(source)
  const uploadPath = path.join(temp, 'http.todoext')
  writeFileSync(uploadPath, upload)
  execFileSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import {createServer} from 'node:http';
  import {readFileSync} from 'node:fs';
  const upload = readFileSync(${JSON.stringify(uploadPath)});
  const {createAiMiddleware} = await import(${JSON.stringify(new URL('../server/aiHttp.mjs', import.meta.url).href)});
  const middleware = createAiMiddleware();
  const server = createServer((req,res) => { void middleware(req,res,() => { res.statusCode=404; res.end() }) });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/ai-extensions/import'
    const binary = { 'Content-Type': 'application/octet-stream' }
    let response = await fetch(endpoint, { method: 'POST', body: upload, headers: binary })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).extension.action, 'installed')
    response = await fetch(endpoint.replace('/ai-extensions/import', '/ai-skills'))
    assert((await response.json()).skills.some(p => p.id === 'example.http-titles'))
    response = await fetch(endpoint, { method: 'POST', body: upload, headers: { ...binary, Origin: 'null' } })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).extension.action, 'unchanged')
    response = await fetch(endpoint, { method: 'POST', body: upload, headers: { Origin: 'null', 'Content-Type': 'text/plain' } })
    assert.equal(response.status, 415, 'opaque origins must not install with a browser simple request')
    response = await fetch(endpoint, { method: 'POST', body: upload, headers: { Origin: 'https://foreign.example' } })
    assert.equal(response.status, 403)
    response = await fetch(endpoint, { method: 'POST', body: 'not a zip', headers: binary })
    assert.equal(response.status, 400)
    const removeUrl = endpoint.replace('/ai-extensions/import', '/ai-extensions/uninstall')
    response = await fetch(removeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null' }, body: JSON.stringify({ kind: 'skill', id: 'example.http-titles' }) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).extension.action, 'removed')
    response = await fetch(removeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: JSON.stringify({ kind: 'skill', id: 'example.http-titles' }) })
    assert.equal(response.status, 403)
  } finally { await new Promise(resolve => server.close(resolve)) }
  `], { env: process.env, stdio: 'inherit', windowsHide: true })
  console.log('Extension package validation, atomic install, discovery, upgrades, integrity and path guards passed')
} finally {
  assert(path.resolve(temp).startsWith(path.resolve(tmpdir()) + path.sep))
  rmSync(temp, { recursive: true, force: true })
}
