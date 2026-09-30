import assert from 'node:assert/strict'
import { availableNarration, narrationJobId, subtitleNarrationSource } from '../shared/ttsNarration.mjs'

const narration = { text: '已有配音', audio: '/ai-generated/s_test_voice_voice.wav', timing: '/ai-generated/s_test_voice_timing.json', duration: 6 }
assert.deepEqual(availableNarration({ status: 'running', params: { partial: { voice: narration }, output: null } }), narration,
  'completed TTS stage must remain usable while pictures are still generating')
assert.deepEqual(availableNarration({ status: 'error', params: { partial: { voice: narration } } }), narration,
  'a later image-generation failure must not discard completed TTS timing')
assert.deepEqual(availableNarration({ status: 'imported', params: { output: { narration } } }), narration)
assert.equal(availableNarration({ status: 'done', params: { output: { narration: { ...narration, timing: '' } } } }), null)
assert.equal(availableNarration({ status: 'running', params: { partial: { voice: { ...narration, audio: '' } } } }), null)
assert.equal(availableNarration({ status: 'done', params: {} }), null)
assert.equal(narrationJobId('file:///D:/project/ai-generated/s_test_voice_voice.wav'), 's_test_voice')
assert.equal(narrationJobId('D:\\project\\ai-generated\\s_test_voice_voice.wav'), 's_test_voice')
assert.equal(narrationJobId('/ai-generated/s_test_voice.webm?x=1'), 's_test_voice')
assert.equal(narrationJobId('external-interview.wav'), null)
const sourceJob = { id: 's_test_voice', status: 'running', params: { partial: { voice: narration } } }
const lookup = id => id === sourceJob.id ? sourceJob : null
const expected = { ...narration, mode: 'script', jobId: sourceJob.id }
assert.deepEqual(subtitleNarrationSource({ sourceJobId: sourceJob.id }, lookup), expected)
assert.deepEqual(subtitleNarrationSource({ sourceMedia: { url: 'file:///D:/project/ai-generated/s_test_voice_voice.wav' } }, lookup), expected,
  'older callers sending only project-local media must still prefer existing TTS timing')
assert.equal(subtitleNarrationSource({ sourceMedia: { url: 'file:///D:/interview.wav' } }, lookup), null,
  'external audio without TTS timing remains eligible for ASR')
console.log('TTS completed/partial-stage subtitle source checks passed')
