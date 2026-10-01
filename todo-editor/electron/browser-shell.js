/** 内置浏览器：F1 开截图模式；选区在外壳 overlay 上完成，再裁切入库 */
(function () {
  const view = document.getElementById('view')
  const urlInput = document.getElementById('url')
  const backBtn = document.getElementById('back')
  const forwardBtn = document.getElementById('forward')
  const reloadBtn = document.getElementById('reload')
  const goBtn = document.getElementById('go')
  const shotToggle = document.getElementById('shot-toggle')
  const overlay = document.getElementById('overlay')
  const boxesEl = document.getElementById('boxes')
  const march = document.getElementById('march')
  const banner = document.getElementById('banner')
  const msg = document.getElementById('msg')
  const hint = document.getElementById('hint')

  const api = window.todoBrowser
  if (!api) {
    hint.textContent = '桌面桥未就绪'
    return
  }

  let shotOn = false
  let busy = false
  let drag = null

  function setMsg(text, kind) {
    msg.textContent = text || ''
    msg.className = kind || ''
  }

  function normalizeUrl(raw) {
    const s = String(raw || '').trim()
    if (!s) return ''
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s
    if (s.startsWith('//')) return 'https:' + s
    return 'https://' + s
  }

  function syncNav() {
    try {
      backBtn.disabled = !view.canGoBack()
      forwardBtn.disabled = !view.canGoForward()
    } catch {
      backBtn.disabled = true
      forwardBtn.disabled = true
    }
  }

  function navigate(raw) {
    const u = normalizeUrl(raw)
    if (!u) return
    if (u.startsWith('file:') || u.startsWith('javascript:')) {
      setMsg('不允许打开本地或脚本地址', 'err')
      return
    }
    exitShot()
    urlInput.value = u
    hint.textContent = '加载中…'
    view.src = u
  }

  function clearBoxes() {
    boxesEl.innerHTML = ''
  }

  function drawBoxes(boxes) {
    clearBoxes()
    const vw = view.clientWidth
    const vh = view.clientHeight
    for (const b of boxes || []) {
      if (!(b.width > 8 && b.height > 8)) continue
      // 检测脚本返回的是页面视口坐标，与 webview 内容区一致
      if (b.x > vw || b.y > vh || b.x + b.width < 0 || b.y + b.height < 0) continue
      const el = document.createElement('div')
      el.className = 'smart-box'
      el.style.left = Math.max(0, b.x) + 'px'
      el.style.top = Math.max(0, b.y) + 'px'
      el.style.width = Math.min(b.width, vw - Math.max(0, b.x)) + 'px'
      el.style.height = Math.min(b.height, vh - Math.max(0, b.y)) + 'px'
      const span = document.createElement('span')
      span.textContent = b.label || '内容框'
      el.appendChild(span)
      el.title = (b.label || '内容框') + ' · 点击截取'
      el.addEventListener('pointerenter', () => el.classList.add('hot'))
      el.addEventListener('pointerleave', () => el.classList.remove('hot'))
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        void commitRect({
          x: Math.max(0, Math.round(b.x)),
          y: Math.max(0, Math.round(b.y)),
          width: Math.round(b.width),
          height: Math.round(b.height),
        }, b.label || '内容框')
      })
      boxesEl.appendChild(el)
    }
  }

  async function enterShot() {
    if (busy) return
    shotOn = true
    overlay.classList.add('on')
    banner.classList.add('on')
    shotToggle.classList.add('active-shot')
    shotToggle.textContent = '退出截图'
    hint.textContent = '截图模式 · 点蓝框或拖拽框选 · Esc / F1 退出'
    setMsg('正在识别内容框…')
    clearBoxes()
    try {
      const det = await api.detectBoxes()
      if (!shotOn) return
      if (det?.ok && det.boxes?.length) {
        drawBoxes(det.boxes)
        setMsg('识别到 ' + det.boxes.length + ' 个内容框', 'ok')
        banner.textContent = '识别到 ' + det.boxes.length + ' 个框 · 点击截取，或拖拽自选 · Esc 退出'
      } else {
        setMsg(det?.error ? '识别失败，可直接拖拽框选' : '未识别到明显框，请拖拽框选')
        banner.textContent = '拖拽框选区域 · Esc / F1 退出'
      }
    } catch {
      if (!shotOn) return
      setMsg('识别失败，可直接拖拽框选')
      banner.textContent = '拖拽框选区域 · Esc / F1 退出'
    }
  }

  function exitShot() {
    shotOn = false
    drag = null
    overlay.classList.remove('on')
    banner.classList.remove('on')
    march.style.display = 'none'
    shotToggle.classList.remove('active-shot')
    shotToggle.textContent = '截图'
    clearBoxes()
    if (!busy) {
      hint.textContent = '就绪 · 按 F1 进入截图模式'
      if (!msg.classList.contains('ok') && !msg.classList.contains('err')) setMsg('')
    }
  }

  function toggleShot() {
    if (shotOn) exitShot()
    else void enterShot()
  }

  async function commitRect(rect, label) {
    if (busy) return
    if (!rect || rect.width < 8 || rect.height < 8) {
      setMsg('选区太小', 'err')
      return
    }
    busy = true
    shotToggle.disabled = true
    setMsg('正在截图…')
    hint.textContent = '截取中…'
    try {
      const title = (document.title || '').replace(/^TO DO ·\s*/, '').trim() || '网页'
      const r = await api.captureAndImport({
        mode: 'region',
        rect,
        label: label || '框选',
        title,
        pageUrl: urlInput.value,
        viewWidth: view.clientWidth,
        viewHeight: view.clientHeight,
      })
      if (r?.canceled) {
        setMsg('已取消')
      } else if (!r?.ok) {
        throw new Error(r?.error || '导入失败')
      } else {
        setMsg('已导入媒体库 · ' + r.name + (r.label ? '（' + r.label + '）' : ''), 'ok')
      }
    } catch (err) {
      setMsg(String(err && err.message ? err.message : err), 'err')
    } finally {
      busy = false
      shotToggle.disabled = false
      exitShot()
      hint.textContent = '就绪 · 按 F1 继续截图'
    }
  }

  // 拖拽框选
  overlay.addEventListener('pointerdown', (e) => {
    if (!shotOn || busy || e.button !== 0) return
    if (e.target.closest('.smart-box')) return
    e.preventDefault()
    drag = { x0: e.offsetX, y0: e.offsetY }
    march.style.display = 'block'
    march.style.left = drag.x0 + 'px'
    march.style.top = drag.y0 + 'px'
    march.style.width = '0px'
    march.style.height = '0px'
    overlay.setPointerCapture(e.pointerId)
  })
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return
    const x = Math.min(drag.x0, e.offsetX)
    const y = Math.min(drag.y0, e.offsetY)
    const w = Math.abs(e.offsetX - drag.x0)
    const h = Math.abs(e.offsetY - drag.y0)
    march.style.left = x + 'px'
    march.style.top = y + 'px'
    march.style.width = w + 'px'
    march.style.height = h + 'px'
  })
  overlay.addEventListener('pointerup', (e) => {
    if (!drag) return
    const x = Math.min(drag.x0, e.offsetX)
    const y = Math.min(drag.y0, e.offsetY)
    const w = Math.abs(e.offsetX - drag.x0)
    const h = Math.abs(e.offsetY - drag.y0)
    drag = null
    try { overlay.releasePointerCapture(e.pointerId) } catch { /* */ }
    march.style.display = 'none'
    void commitRect({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }, '框选')
  })

  goBtn.addEventListener('click', () => navigate(urlInput.value))
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); navigate(urlInput.value) }
  })
  backBtn.addEventListener('click', () => { try { view.goBack() } catch { /* */ } })
  forwardBtn.addEventListener('click', () => { try { view.goForward() } catch { /* */ } })
  reloadBtn.addEventListener('click', () => { try { view.reload() } catch { /* */ } })
  shotToggle.addEventListener('click', () => toggleShot())

  // 外壳按键
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
      e.preventDefault()
      toggleShot()
      return
    }
    if (e.key === 'Escape' && shotOn) {
      e.preventDefault()
      exitShot()
      setMsg('已退出截图模式')
    }
  }, true)

  // 主进程：网页焦点时 F1 也会转到这里
  if (api.onToggleShot) {
    api.onToggleShot(() => toggleShot())
  }

  view.addEventListener('did-start-loading', () => {
    exitShot()
    hint.textContent = '加载中…'
  })
  view.addEventListener('did-stop-loading', () => {
    hint.textContent = '就绪 · 按 F1 进入截图模式'
    syncNav()
  })
  view.addEventListener('did-navigate', (e) => {
    if (e.url) urlInput.value = e.url
    syncNav()
  })
  view.addEventListener('did-navigate-in-page', (e) => {
    if (e.url) urlInput.value = e.url
    syncNav()
  })
  view.addEventListener('page-title-updated', (e) => {
    document.title = e.title ? `TO DO · ${e.title}` : 'TO DO · 浏览器'
  })
  view.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return
    hint.textContent = '加载失败'
    setMsg(e.errorDescription || '无法打开页面', 'err')
  })
  view.addEventListener('new-window', (e) => {
    e.preventDefault()
    if (e.url) navigate(e.url)
  })

  syncNav()
})()
