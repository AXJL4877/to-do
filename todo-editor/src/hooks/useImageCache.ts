import { useEffect, useRef, useState } from 'react'
import type { MediaItem } from '../types'
import type { ImageCache } from '../lib/monitorDraw'
import { ensureVideo, setVideoCacheListener } from '../lib/videoCache'
import { onFancyTextureLoaded } from '../lib/fancyText'

/** 图片 + 视频素材缓存：首帧就绪后 bump；seek 中不靠清预览缓存防闪 */
export function useImageCache(media: MediaItem[]) {
  const cache = useRef<ImageCache>(new Map())
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let raf = 0
    setVideoCacheListener(() => {
      // 合帧 bump，避免 seeked 连发导致闪烁
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setVersion((v) => v + 1)
      })
    })
    const offTexture = onFancyTextureLoaded(() => setVersion((v) => v + 1))
    return () => {
      setVideoCacheListener(null)
      offTexture()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(() => {
    for (const m of media) {
      if (m.kind === 'image' || m.kind === 'sticker') {
        const existing = cache.current.get(m.id)
        if (existing?.complete && existing.naturalWidth && existing.dataset.src === m.url) continue
        const img = new Image()
        img.onload = () => {
          cache.current.set(m.id, img)
          setVersion((v) => v + 1)
        }
        img.onerror = () => setVersion((v) => v + 1)
        img.dataset.src = m.url
        img.src = m.url
        cache.current.set(m.id, img)
      } else if (m.kind === 'video') {
        ensureVideo(m)
      }
    }
  }, [media])

  return { cache, version }
}
