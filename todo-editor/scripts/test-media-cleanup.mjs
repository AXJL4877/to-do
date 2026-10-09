import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'

const module = await import('../server/mediaCleanup.mjs').catch(() => ({}))
assert.equal(typeof module.createMediaCleanup, 'function', 'safe media cleanup service must exist')
const root = mkdtempSync(path.join(os.tmpdir(), 'todo-cleanup-test-'))
try {
  let records = { productions: [], jobs: [] }
  let clock = 100
  const out = path.join(root, 'ai-generated'); mkdirSync(out)
  const file = (name, content = 'test') => writeFileSync(path.join(out, name), content)
  const cleanup = module.createMediaCleanup({ outDir: out, getRecords: () => records, now: () => clock, tokenTtlMs: 20 })
  file('old.png'); file('keep.wav'); file('keep.timing.json', '{}'); file('job.mp4'); file('active_raw'); file('prod.png')
  mkdirSync(path.join(out, 'nested'))
  records = { productions: [{ id: 'p_example', segments: [{ file: 'prod.png' }] }], jobs: [{ id: 'job', status: 'imported', result_name: 'job.mp4' }, { id: 'active', status: 'running' }] }
  const preview = cleanup.preview({ retainedFiles: ['/ai-generated/keep.wav'] })
  assert.deepEqual(preview.candidates.map(x => x.name), ['old.png'])
  for (const name of ['keep.wav', 'keep.timing.json', 'job.mp4', 'active_raw', 'prod.png', 'nested']) assert.ok(preview.blocked.some(x => x.name === name), `${name} protected`)
  const result = cleanup.execute({ token: preview.token, retainedFiles: ['/ai-generated/keep.wav'] })
  assert.deepEqual(result.deleted, ['old.png']); assert.equal(result.freedBytes, 4)
  assert.equal(existsSync(path.join(out, 'old.png')), false)
  assert.throws(() => cleanup.execute({ token: preview.token, retainedFiles: [] }), /预览|token/)
  file('changed.png'); const changed = cleanup.preview({ files: ['changed.png'], retainedFiles: [] }); file('changed.png', 'changed')
  assert.ok(cleanup.execute({ token: changed.token, retainedFiles: [] }).blocked.some(x => x.name === 'changed.png'))
  file('new-ref.png'); const fresh = cleanup.preview({ files: ['new-ref.png'], retainedFiles: [] })
  records.jobs.push({ id: 'new', status: 'done', result_url: '/ai-generated/new-ref.png' })
  assert.ok(cleanup.execute({ token: fresh.token, retainedFiles: [] }).blocked.some(x => x.name === 'new-ref.png'))
  const expired = cleanup.preview({ files: [], retainedFiles: [] }); clock += 21
  assert.throws(() => cleanup.execute({ token: expired.token, retainedFiles: [] }), /过期|预览|token/)
  assert.throws(() => cleanup.preview({ files: Array(10001).fill('x.png'), retainedFiles: [] }), /数量/)
  const bad = cleanup.preview({ files: ['../outside.png', '%2e%2e%2foutside.png', 'C:\\outside.png'], retainedFiles: [] })
  assert.equal(bad.candidates.length, 0); assert.equal(bad.blocked.length, 3)
  writeFileSync(path.join(root, 'outside.png'), 'outside')
  try {
    symlinkSync(path.join(root, 'outside.png'), path.join(out, 'linked.png'))
    assert.ok(cleanup.preview({ files: ['linked.png'], retainedFiles: [] }).blocked.some(x => x.name === 'linked.png'))
  } catch (error) { if (error.code !== 'EPERM') throw error }
  file('voice.mp3'); file('voice.json', JSON.stringify({ timing: 'voice.timing.json' })); file('voice.timing.json', '{}')
  const audio = cleanup.preview({ retainedFiles: ['voice.mp3'] })
  assert.ok(audio.blocked.some(x => x.name === 'voice.json')); assert.ok(audio.blocked.some(x => x.name === 'voice.timing.json'))
  file('s_fixture_voice.wav'); file('s_fixture_timing.json', '{}'); file('s_fixture_script.txt')
  const nativeAudio = cleanup.preview({ files: ['s_fixture_timing.json', 's_fixture_script.txt'], retainedFiles: ['s_fixture_voice.wav'] })
  assert.equal(nativeAudio.blocked.length, 2, 'native voice timing and script names remain protected with audio')
  records.productions.push({ id: 'p_locked', lock: { job: 'x' } }); file('p_locked_new.png')
  assert.ok(cleanup.preview({ files: ['p_locked_new.png'], retainedFiles: [] }).blocked.length)
  const db = new DatabaseSync(path.join(root, 'ai-assets.sqlite'))
  db.exec('CREATE TABLE ai_jobs (id TEXT, status TEXT, params TEXT, ref_path TEXT, result_name TEXT, result_url TEXT)')
  db.prepare('INSERT INTO ai_jobs VALUES (?, ?, ?, ?, ?, ?)').run('old', 'imported', '{}', path.join(out, 'prod.png'), 'job.mp4', null)
  db.close()
  mkdirSync(path.join(root, 'productions'))
  writeFileSync(path.join(root, 'productions', 'p_fixture.json'), JSON.stringify({ id: 'p_fixture', file: 'new-ref.png' }))
  const audited = module.createMediaCleanup({ outDir: out })
  const audit = audited.preview({ files: ['job.mp4', 'prod.png', 'new-ref.png'], retainedFiles: [] })
  assert.equal(audit.blocked.length, 3, 'real SQLite outputs, ref_path and production JSON protected')
  writeFileSync(path.join(root, 'productions', 'p_fixture.json'), '{invalid')
  assert.throws(() => audited.preview({ retainedFiles: [] }), /核对/)
  const httpRoot = path.join(root, 'http'); mkdirSync(httpRoot)
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    import path from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    const { handleAiHttp } = await import(${JSON.stringify(new URL('../server/aiHttp.mjs', import.meta.url).href)});
    const call = async (method, action, body, headers = { 'content-type': 'application/json' }, route = '/api/ai-media-cleanup/' + action) => {
      let data; const res = { statusCode: 0, setHeader() {}, end(s) { data = JSON.parse(s) } };
      await handleAiHttp({ method, url: route, headers, async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }, res);
      return { status: res.statusCode, ...data };
    };
    writeFileSync(path.join(process.env.TODO_DATA_DIR, 'ai-generated', 'http-old.png'), 'fixture');
    const preview = await call('POST', 'preview', { retainedFiles: [] });
    assert.equal(preview.status, 200); assert.equal(preview.candidates[0].name, 'http-old.png');
    const execute = await call('POST', 'execute', { token: preview.token, retainedFiles: [] });
    assert.deepEqual(execute.deleted, ['http-old.png']);
    assert.equal((await call('GET', 'preview', {})).status, 405);
    assert.equal((await call('POST', 'preview', { retainedFiles: [] }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await call('POST', 'preview', { retainedFiles: [] }, { 'content-type': 'application/json', origin: 'https://example.com' })).status, 403);
    const db = new DatabaseSync(path.join(process.env.TODO_DATA_DIR, 'ai-assets.sqlite'));
    const insert = db.prepare('INSERT INTO ai_jobs (id, kind, status, prompt, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const remove = (route) => call('DELETE', '', {}, undefined, route);
    for (const status of ['queued', 'running']) {
      const id = 'stale_' + status;
      insert.run(id, 'image', 'done', '', '{}', 1, 1);
      db.prepare('UPDATE ai_jobs SET status=? WHERE id=?').run(status, id);
      const result = await remove('/api/ai-jobs/' + id + '?terminalOnly=1');
      assert.equal(result.status, 409, 'stale terminal job transitioning to ' + status + ' must reject deletion');
      assert.equal(db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(id).status, status);
    }
    const { saveProduction, productionExists } = await import(${JSON.stringify(new URL('../server/production/doc.mjs', import.meta.url).href)});
    const prod = 'p_fixture_abcd';
    saveProduction({ id: prod, segments: [], status: { running: false }, lock: null });
    insert.run('production_queue', 'skill', 'queued', '', JSON.stringify({ request: { productionId: prod } }), 1, 1);
    assert.equal((await remove('/api/ai-productions/' + prod + '?terminalOnly=1')).status, 409);
    assert.equal(productionExists(prod), true);
    assert.equal(db.prepare('SELECT status FROM ai_jobs WHERE id=?').get('production_queue').status, 'queued');
    db.prepare('UPDATE ai_jobs SET status=? WHERE id=?').run('running', 'production_queue');
    saveProduction({ id: prod, segments: [], status: { running: true }, lock: { jobId: 'production_queue' } });
    assert.equal((await remove('/api/ai-productions/' + prod + '?terminalOnly=1')).status, 409);
    assert.equal(productionExists(prod), true);
    assert.equal(db.prepare('SELECT status FROM ai_jobs WHERE id=?').get('production_queue').status, 'running');
    for (const status of ['done', 'error', 'imported']) {
      const id = 'terminal_' + status;
      insert.run(id, 'image', status, '', '{}', 1, 1);
      assert.equal((await remove('/api/ai-jobs/' + id + '?terminalOnly=1')).status, 200);
      assert.equal(db.prepare('SELECT id FROM ai_jobs WHERE id=?').get(id), undefined);
    }
    db.prepare('UPDATE ai_jobs SET status=? WHERE id=?').run('done', 'production_queue');
    assert.equal((await remove('/api/ai-productions/' + prod + '?terminalOnly=1')).status, 200);
    assert.equal(productionExists(prod), false);
    const defaultProd = 'p_default_abcd';
    saveProduction({ id: defaultProd, segments: [], status: { running: false }, lock: null });
    insert.run('default_production_queue', 'skill', 'queued', '', JSON.stringify({ request: { productionId: defaultProd } }), 1, 1);
    assert.equal((await remove('/api/ai-productions/' + defaultProd)).status, 200);
    assert.equal(productionExists(defaultProd), false);
    assert.equal(db.prepare('SELECT id FROM ai_jobs WHERE id=?').get('default_production_queue'), undefined);
    insert.run('default_queued', 'image', 'queued', '', '{}', 1, 1);
    assert.equal((await remove('/api/ai-jobs/default_queued')).status, 200);
    assert.equal(db.prepare('SELECT id FROM ai_jobs WHERE id=?').get('default_queued'), undefined);
    db.close();
  `], { env: { ...process.env, TODO_DATA_DIR: httpRoot, MISHI_ROOT: path.join(root, 'mishi') }, stdio: 'pipe' })
  console.log('media cleanup: safe deletion, references, sidecars, tokens, paths and revalidation passed')
} finally { rmSync(root, { recursive: true, force: true }) }
