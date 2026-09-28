/**
 * 写出 tests/fixtures/*.json（对齐 editGraph.ts buildEditGraph 字段）。
 * 运行：node scripts/write-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clip, graph, videoTracks } from './lib/fixtureGraph.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const outDir = resolve(root, 'tests/fixtures')
mkdirSync(outDir, { recursive: true })

const MEDIA = 'tests/media/gop250.mp4'
const INTRA = 'tests/media/intra.mp4'
const UHD = 'tests/media/4k.mp4'
const ALPHA = 'tests/media/alpha_circle.png'
const ALPHA2 = 'tests/media/alpha_checker.png'

const fixtures = {
  single: graph({
    clips: [clip({ mediaPath: MEDIA, duration: 5, outPoint: 5 })],
    tracks: videoTracks('v1'),
    workOut: 5,
  }),

  two_layer_normal: graph({
    clips: [
      clip({
        mediaPath: MEDIA, trackId: 'v2', duration: 5, outPoint: 5,
        opacity: 1, blend: 'normal',
      }),
      clip({
        mediaPath: ALPHA, trackId: 'v1', kind: 'image', duration: 5, outPoint: 5,
        scaleX: 0.7, scaleY: 0.7, x: 0.15, y: -0.1, blend: 'normal',
      }),
    ],
    tracks: videoTracks('v1', 'v2'),
    workOut: 5,
  }),

  blend_multiply_screen_add: graph({
    clips: [
      clip({ mediaPath: MEDIA, trackId: 'v4', duration: 4, outPoint: 4 }),
      clip({
        mediaPath: INTRA, trackId: 'v3', duration: 4, outPoint: 4,
        scaleX: 0.55, scaleY: 0.55, x: -0.35, y: -0.2, blend: 'multiply', opacity: 0.9,
      }),
      clip({
        mediaPath: ALPHA, trackId: 'v2', kind: 'image', duration: 4, outPoint: 4,
        scaleX: 0.5, scaleY: 0.5, x: 0.3, y: -0.15, blend: 'screen', opacity: 0.85,
      }),
      clip({
        mediaPath: ALPHA2, trackId: 'v1', kind: 'image', duration: 4, outPoint: 4,
        scaleX: 0.45, scaleY: 0.45, x: 0.05, y: 0.25, blend: 'add', opacity: 0.7,
      }),
    ],
    tracks: videoTracks('v1', 'v2', 'v3', 'v4'),
    workOut: 4,
  }),

  transform_keyframes: graph({
    clips: [clip({
      mediaPath: MEDIA, duration: 4, outPoint: 4,
      x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1,
      keyframes: {
        x: [{ t: 0, value: -0.4 }, { t: 2, value: 0.4 }, { t: 4, value: 0 }],
        y: [{ t: 0, value: 0.2 }, { t: 2, value: -0.2 }, { t: 4, value: 0 }],
        scale: [{ t: 0, value: 0.6 }, { t: 2, value: 1.1 }, { t: 4, value: 0.8 }],
        scaleY: [{ t: 0, value: 0.6 }, { t: 2, value: 1.1 }, { t: 4, value: 0.8 }],
        rotation: [{ t: 0, value: -15 }, { t: 2, value: 20 }, { t: 4, value: 0 }],
        opacity: [{ t: 0, value: 0.4 }, { t: 1, value: 1 }, { t: 4, value: 0.7 }],
      },
    })],
    tracks: videoTracks('v1'),
    workOut: 4,
  }),

  /**
   * B1.2b：各 ease + bezier（基线由新插值逻辑生成）。
   * x=linear, y=easeIn, scale=easeOut, scaleY=easeInOut, rotation=hold, opacity=bezier
   */
  transform_ease: graph({
    clips: [clip({
      mediaPath: MEDIA, duration: 4, outPoint: 4,
      x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1,
      keyframes: {
        x: [
          { t: 0, value: -0.3 },
          { t: 2, value: 0.3 },
          { t: 4, value: 0 },
        ],
        y: [
          { t: 0, value: 0.25, ease: 'easeIn' },
          { t: 2, value: -0.25, ease: 'easeIn' },
          { t: 4, value: 0, ease: 'easeIn' },
        ],
        scale: [
          { t: 0, value: 0.7, ease: 'easeOut' },
          { t: 2, value: 1.15, ease: 'easeOut' },
          { t: 4, value: 0.9, ease: 'easeOut' },
        ],
        scaleY: [
          { t: 0, value: 0.7, ease: 'easeInOut' },
          { t: 2, value: 1.15, ease: 'easeInOut' },
          { t: 4, value: 0.9, ease: 'easeInOut' },
        ],
        rotation: [
          { t: 0, value: -20, ease: 'hold' },
          { t: 2, value: 25, ease: 'hold' },
          { t: 4, value: 0, ease: 'linear' },
        ],
        opacity: [
          {
            t: 0, value: 0.3, ease: 'bezier',
            oh: { x: 0.42, y: 0 }, ih: { x: -0.42, y: 0 },
          },
          {
            t: 2, value: 1, ease: 'bezier',
            oh: { x: 0.42, y: 0 }, ih: { x: -0.42, y: 0 },
          },
          {
            t: 4, value: 0.6, ease: 'bezier',
            oh: { x: 1 / 3, y: 1 / 3 }, ih: { x: -1 / 3, y: -1 / 3 },
          },
        ],
      },
    })],
    tracks: videoTracks('v1'),
    workOut: 4,
  }),

  /** B1.2a：同 transform_keyframes，关键帧带未知字段；解析须成功且合成像素一致 */
  transform_keyframes_unknown_fields: graph({
    clips: [clip({
      mediaPath: MEDIA, duration: 4, outPoint: 4,
      x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1,
      keyframes: {
        x: [
          { t: 0, value: -0.4, ease: 'linear', oh: 0, ih: 0 },
          { t: 2, value: 0.4, ease: 'linear', oh: 0, ih: 0 },
          { t: 4, value: 0, ease: 'linear', oh: 0, ih: 0 },
        ],
        y: [
          { t: 0, value: 0.2, ease: 'linear', oh: 0, ih: 0 },
          { t: 2, value: -0.2, ease: 'linear', oh: 0, ih: 0 },
          { t: 4, value: 0, ease: 'linear', oh: 0, ih: 0 },
        ],
        scale: [
          { t: 0, value: 0.6, ease: 'linear', oh: 0, ih: 0 },
          { t: 2, value: 1.1, ease: 'linear', oh: 0, ih: 0 },
          { t: 4, value: 0.8, ease: 'linear', oh: 0, ih: 0 },
        ],
        scaleY: [
          { t: 0, value: 0.6, ease: 'linear', oh: 0, ih: 0 },
          { t: 2, value: 1.1, ease: 'linear', oh: 0, ih: 0 },
          { t: 4, value: 0.8, ease: 'linear', oh: 0, ih: 0 },
        ],
        rotation: [
          { t: 0, value: -15, ease: 'linear', oh: 0, ih: 0 },
          { t: 2, value: 20, ease: 'linear', oh: 0, ih: 0 },
          { t: 4, value: 0, ease: 'linear', oh: 0, ih: 0 },
        ],
        opacity: [
          { t: 0, value: 0.4, ease: 'linear', oh: 0, ih: 0 },
          { t: 1, value: 1, ease: 'linear', oh: 0, ih: 0 },
          { t: 4, value: 0.7, ease: 'linear', oh: 0, ih: 0 },
        ],
      },
    })],
    tracks: videoTracks('v1'),
    workOut: 4,
  }),

  crop: graph({
    clips: [clip({
      mediaPath: MEDIA, duration: 4, outPoint: 4,
      cropL: 0.12, cropR: 0.18, cropT: 0.08, cropB: 0.1,
    })],
    tracks: videoTracks('v1'),
    workOut: 4,
  }),

  speed2x: graph({
    clips: [clip({
      mediaPath: MEDIA, duration: 4, inPoint: 0, outPoint: 8, speed: 2, reverse: false,
    })],
    tracks: videoTracks('v1'),
    workOut: 4,
  }),

  reverse: graph({
    clips: [clip({
      mediaPath: INTRA, duration: 4, inPoint: 0, outPoint: 4, speed: 1, reverse: true,
    })],
    tracks: videoTracks('v1'),
    workOut: 4,
  }),

  transition_dissolve: graph({
    clips: [clip({
      mediaPath: MEDIA, duration: 3, outPoint: 3,
      transitionIn: { type: 'dissolve', duration: 0.8 },
      transitionOut: { type: 'dissolve', duration: 0.8 },
    })],
    tracks: videoTracks('v1'),
    workOut: 3,
  }),

  transition_push: graph({
    clips: [clip({
      mediaPath: MEDIA, duration: 3, outPoint: 3,
      transitionIn: { type: 'push', duration: 0.7 },
      transitionOut: { type: 'push', duration: 0.7 },
    })],
    tracks: videoTracks('v1'),
    workOut: 3,
  }),

  transition_wipe: graph({
    clips: [clip({
      mediaPath: MEDIA, duration: 3, outPoint: 3,
      transitionIn: { type: 'wipe', duration: 0.7 },
      transitionOut: { type: 'wipe', duration: 0.7 },
    })],
    tracks: videoTracks('v1'),
    workOut: 3,
  }),

  fade_black: graph({
    clips: [clip({
      mediaPath: MEDIA, duration: 3, outPoint: 3,
      transitionIn: { type: 'fadeBlack', duration: 0.9 },
      transitionOut: { type: 'fadeBlack', duration: 0.9 },
    })],
    tracks: videoTracks('v1'),
    workOut: 3,
  }),

  letterbox_odd_aspect: graph({
    clips: [clip({
      mediaPath: UHD, duration: 4, outPoint: 4,
    })],
    tracks: videoTracks('v1'),
    // 奇数宽高：compose 侧会 & ~1 对齐；验证 letterbox 进非常规画幅
    settings: { width: 853, height: 401, fps: 30 },
    workOut: 4,
  }),

  four_layer: graph({
    clips: [
      clip({ mediaPath: UHD, trackId: 'v4', duration: 4, outPoint: 4, opacity: 1 }),
      clip({
        mediaPath: MEDIA, trackId: 'v3', duration: 4, outPoint: 4,
        scaleX: 0.55, scaleY: 0.55, x: -0.3, y: 0.15, rotation: -8, blend: 'normal', opacity: 0.95,
      }),
      clip({
        mediaPath: INTRA, trackId: 'v2', duration: 4, outPoint: 4,
        scaleX: 0.5, scaleY: 0.5, x: 0.35, y: -0.2, rotation: 12, blend: 'multiply', opacity: 0.85,
      }),
      clip({
        mediaPath: ALPHA, trackId: 'v1', kind: 'image', duration: 4, outPoint: 4,
        scaleX: 0.65, scaleY: 0.65, x: 0, y: 0.05, blend: 'screen', opacity: 0.9,
        mask: { type: 'ellipse', feather: 0.15, expand: 0.05, invert: false },
      }),
    ],
    tracks: videoTracks('v1', 'v2', 'v3', 'v4'),
    settings: { width: 960, height: 540, fps: 30 },
    workOut: 4,
  }),
}

for (const [name, g] of Object.entries(fixtures)) {
  const p = resolve(outDir, `${name}.json`)
  writeFileSync(p, JSON.stringify(g, null, 2) + '\n', 'utf8')
  console.log('wrote', name)
}

console.log(`fixtures: ${Object.keys(fixtures).length} → ${outDir}`)
