/** 17 模块 × 160+ 能力 → 真实 data-testid 验收映射 */
export type CapabilityItem = {
  module: number
  moduleName: string
  feature: string
  selector: string
  kind?: 'click' | 'exists'
}

export const CAPABILITY_MANIFEST: CapabilityItem[] = [
  // 1 工程与界面 (26)
  { module: 1, moduleName: '工程与界面', feature: '草稿管理', selector: '[data-testid="btn-drafts"]' },
  { module: 1, moduleName: '工程与界面', feature: '新建项目', selector: '[data-testid="btn-new-project"]' },
  { module: 1, moduleName: '工程与界面', feature: '保存', selector: '[data-testid="btn-save"]' },
  { module: 1, moduleName: '工程与界面', feature: '另存为', selector: '[data-testid="btn-save-as"]' },
  { module: 1, moduleName: '工程与界面', feature: '工程设置', selector: '[data-testid="btn-settings"]' },
  { module: 1, moduleName: '工程与界面', feature: '偏好设置', selector: '[data-testid="btn-prefs"]' },
  { module: 1, moduleName: '工程与界面', feature: '编辑+节目双窗', selector: '[data-testid="monitor-view-dual"]' },
  { module: 1, moduleName: '工程与界面', feature: '编辑窗', selector: '[data-testid="monitor-view-edit"]' },
  { module: 1, moduleName: '工程与界面', feature: '节目窗', selector: '[data-testid="monitor-view-program"]' },
  { module: 1, moduleName: '工程与界面', feature: '源监视器', selector: '[data-testid="monitor-view-source"]' },
  { module: 1, moduleName: '工程与界面', feature: '播放', selector: '[data-testid="btn-play"]' },
  { module: 1, moduleName: '工程与界面', feature: '安全框', selector: '[data-testid="btn-safe-frame"]' },
  { module: 1, moduleName: '工程与界面', feature: '撤销', selector: '[data-testid="btn-undo"]' },
  { module: 1, moduleName: '工程与界面', feature: '重做', selector: '[data-testid="btn-redo"]' },
  { module: 1, moduleName: '工程与界面', feature: '快捷键', selector: '[data-testid="btn-shortcuts"]' },
  { module: 1, moduleName: '工程与界面', feature: '全屏', selector: '[data-testid="btn-fullscreen"]' },
  { module: 1, moduleName: '工程与界面', feature: '插入覆盖', selector: '[data-testid="btn-edit-mode"]' },
  { module: 1, moduleName: '工程与界面', feature: '代理模式', selector: '[data-testid="set-proxy"]', kind: 'exists' },
  { module: 1, moduleName: '工程与界面', feature: '硬件加速', selector: '[data-testid="set-hwaccel"]', kind: 'exists' },
  { module: 1, moduleName: '工程与界面', feature: '清理缓存', selector: '[data-testid="btn-clear-cache"]', kind: 'exists' },
  { module: 1, moduleName: '工程与界面', feature: '画幅', selector: '[data-testid="set-aspect"]', kind: 'exists' },
  { module: 1, moduleName: '工程与界面', feature: '画布背景', selector: '[data-testid="set-canvas-bg"]', kind: 'exists' },
  { module: 1, moduleName: '工程与界面', feature: '布局拖拽', selector: '[data-testid="resize-timeline"]', kind: 'exists' },
  { module: 1, moduleName: '工程与界面', feature: '性能偏好', selector: '[data-testid="pref-performance"]', kind: 'exists' },
  { module: 1, moduleName: '工程与界面', feature: '逐帧退', selector: '[data-testid="btn-step-back"]' },
  { module: 1, moduleName: '工程与界面', feature: '逐帧进', selector: '[data-testid="btn-step-fwd"]' },
  { module: 1, moduleName: '工程与界面', feature: '循环', selector: '[data-testid="btn-loop"]' },
  { module: 1, moduleName: '工程与界面', feature: '节目画布', selector: '[data-testid="program-canvas"]', kind: 'exists' },
  { module: 1, moduleName: '工程与界面', feature: '品牌标识', selector: '[data-testid="brand-logo"]', kind: 'exists' },

  // 2 素材 (15)
  { module: 2, moduleName: '素材与媒体库', feature: '导入', selector: '[data-testid="btn-import"]' },
  { module: 2, moduleName: '素材与媒体库', feature: '截帧', selector: '[data-testid="btn-capture-frame"]' },
  { module: 2, moduleName: '素材与媒体库', feature: '字体导入', selector: '[data-testid="btn-import-font"]' },
  { module: 2, moduleName: '素材与媒体库', feature: '最近', selector: '[data-testid="lib-tab-recent"]' },
  { module: 2, moduleName: '素材与媒体库', feature: '收藏', selector: '[data-testid="btn-favorite"]', kind: 'exists' },
  { module: 2, moduleName: '素材与媒体库', feature: '媒体页', selector: '[data-testid="lib-tab-media"]' },
  { module: 2, moduleName: '素材与媒体库', feature: '音频库', selector: '[data-testid="lib-tab-audio"]' },
  { module: 2, moduleName: '素材与媒体库', feature: '文字库', selector: '[data-testid="lib-tab-text"]' },
  { module: 2, moduleName: '素材与媒体库', feature: '转场库', selector: '[data-testid="lib-tab-transition"]' },
  { module: 2, moduleName: '素材与媒体库', feature: '特效库', selector: '[data-testid="lib-tab-effect"]' },
  { module: 2, moduleName: '素材与媒体库', feature: '滤镜库', selector: '[data-testid="lib-tab-filter"]' },
  { module: 2, moduleName: '素材与媒体库', feature: '预设库', selector: '[data-testid="lib-tab-preset"]' },
  { module: 2, moduleName: '素材与媒体库', feature: '字体库', selector: '[data-testid="lib-tab-font"]' },
  { module: 2, moduleName: '素材与媒体库', feature: '媒体网格', selector: '[data-testid="media-grid"]', kind: 'exists' },
  { module: 2, moduleName: '素材与媒体库', feature: '贴纸', selector: '[data-testid="sticker-emoji"]' },

  // 3 时间线 (29)
  { module: 3, moduleName: '时间线与剪辑', feature: '分割', selector: '[data-testid="tl-split"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '吸附', selector: '[data-testid="tl-snap"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '磁性', selector: '[data-testid="tl-magnetic"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '关空隙', selector: '[data-testid="tl-close-gaps"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '标记', selector: '[data-testid="tl-marker"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '工作区', selector: '[data-testid="tl-workarea"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '多序列', selector: '[data-testid="tl-add-seq"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '多机位', selector: '[data-testid="tl-multicam"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '剃刀', selector: '[data-testid="tool-razor"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '滑移', selector: '[data-testid="tool-slip"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '修剪', selector: '[data-testid="tool-trim"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '选择', selector: '[data-testid="tool-select"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '手型', selector: '[data-testid="tool-hand"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '工具吸附', selector: '[data-testid="tool-snap"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '复制粘贴', selector: '[data-testid="tl-copy"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '链接', selector: '[data-testid="tl-link"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '解链', selector: '[data-testid="tl-unlink"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '入点', selector: '[data-testid="btn-mark-in"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '出点', selector: '[data-testid="btn-mark-out"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '三点剪辑', selector: '[data-testid="btn-three-point"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '加轨道', selector: '[data-testid="tl-add-track"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '放大', selector: '[data-testid="tl-zoom-in"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '缩小', selector: '[data-testid="tl-zoom-out"]' },
  { module: 3, moduleName: '时间线与剪辑', feature: '粘贴属性', selector: '[data-testid="btn-paste-attrs"]', kind: 'exists' },
  { module: 3, moduleName: '时间线与剪辑', feature: '分组', selector: '[data-testid="btn-group"]', kind: 'exists' },
  { module: 3, moduleName: '时间线与剪辑', feature: '匹配帧', selector: '[data-testid="btn-match-frame"]', kind: 'exists' },
  { module: 3, moduleName: '时间线与剪辑', feature: '定格', selector: '[data-testid="btn-freeze"]', kind: 'exists' },
  { module: 3, moduleName: '时间线与剪辑', feature: '倒放', selector: '[data-testid="btn-reverse"]', kind: 'exists' },
  { module: 3, moduleName: '时间线与剪辑', feature: '删除', selector: '[data-testid="tl-delete"]' },

  // 4 变换 (13)
  { module: 4, moduleName: '画面与变换', feature: '位置X', selector: '[data-testid="tf-x"]', kind: 'exists' },
  { module: 4, moduleName: '画面与变换', feature: '位置Y', selector: '[data-testid="tf-y"]', kind: 'exists' },
  { module: 4, moduleName: '画面与变换', feature: '缩放', selector: '[data-testid="tf-scale"]', kind: 'exists' },
  { module: 4, moduleName: '画面与变换', feature: '旋转', selector: '[data-testid="tf-rot"]', kind: 'exists' },
  { module: 4, moduleName: '画面与变换', feature: '锚点', selector: '[data-testid="tf-anchor-x"]', kind: 'exists' },
  { module: 4, moduleName: '画面与变换', feature: '透明度', selector: '[data-testid="tf-opacity"]', kind: 'exists' },
  { module: 4, moduleName: '画面与变换', feature: '速度', selector: '[data-testid="tf-speed"]', kind: 'exists' },
  { module: 4, moduleName: '画面与变换', feature: '适应', selector: '[data-testid="tf-fit"]', kind: 'exists' },
  { module: 4, moduleName: '画面与变换', feature: '混合', selector: '[data-testid="tf-blend"]', kind: 'exists' },
  { module: 4, moduleName: '画面与变换', feature: '水平翻转', selector: '[data-testid="tf-flip-h"]', kind: 'exists' },
  { module: 4, moduleName: '画面与变换', feature: '垂直翻转', selector: '[data-testid="tf-flip-v"]', kind: 'exists' },
  { module: 4, moduleName: '画面与变换', feature: '裁剪', selector: '[data-testid="tf-crop-l"]', kind: 'exists' },
  { module: 4, moduleName: '画面与变换', feature: '复制属性', selector: '[data-testid="btn-copy-attrs"]', kind: 'exists' },

  // 5 关键帧 (6)
  { module: 5, moduleName: '关键帧', feature: '透明度KF', selector: '[data-testid="kf-opacity"]', kind: 'exists' },
  { module: 5, moduleName: '关键帧', feature: '缩放KF', selector: '[data-testid="kf-scale"]', kind: 'exists' },
  { module: 5, moduleName: '关键帧', feature: '位置KF', selector: '[data-testid="kf-x"]', kind: 'exists' },
  { module: 5, moduleName: '关键帧', feature: '旋转KF', selector: '[data-testid="kf-rot"]', kind: 'exists' },
  { module: 5, moduleName: '关键帧', feature: '音量KF', selector: '[data-testid="kf-volume"]', kind: 'exists' },
  { module: 5, moduleName: '关键帧', feature: '缓动', selector: '[data-testid="kf-ease"]', kind: 'exists' },

  // 6 文字 (10)
  { module: 6, moduleName: '文字', feature: '新建文本', selector: '[data-testid="text-preset-title"]' },
  { module: 6, moduleName: '文字', feature: '字幕条', selector: '[data-testid="text-preset-subtitle"]' },
  { module: 6, moduleName: '文字', feature: '下三分之一', selector: '[data-testid="text-preset-lower"]' },
  { module: 6, moduleName: '文字', feature: 'ASR', selector: '[data-testid="btn-asr"]', kind: 'exists' },
  { module: 6, moduleName: '文字', feature: '导出SRT', selector: '[data-testid="btn-export-srt"]', kind: 'exists' },
  { module: 6, moduleName: '文字', feature: '颜色', selector: '[data-testid="text-color"]', kind: 'exists' },
  { module: 6, moduleName: '文字', feature: '对齐', selector: '[data-testid="text-align"]', kind: 'exists' },
  { module: 6, moduleName: '文字', feature: '入场动画', selector: '[data-testid="text-anim-in"]', kind: 'exists' },
  { module: 6, moduleName: '文字', feature: '双语', selector: '[data-testid="text-bilingual"]', kind: 'exists' },
  { module: 6, moduleName: '文字', feature: '内容', selector: '[data-testid="text-content"]', kind: 'exists' },

  // 7 转场 (6)
  { module: 7, moduleName: '转场', feature: '叠化', selector: '[data-testid="transition-dissolve"]' },
  { module: 7, moduleName: '转场', feature: '闪黑', selector: '[data-testid="transition-fadeBlack"]' },
  { module: 7, moduleName: '转场', feature: '闪白', selector: '[data-testid="transition-fadeWhite"]' },
  { module: 7, moduleName: '转场', feature: '推拉', selector: '[data-testid="transition-push"]' },
  { module: 7, moduleName: '转场', feature: '擦除', selector: '[data-testid="transition-wipe"]' },
  { module: 7, moduleName: '转场', feature: '时长', selector: '[data-testid="transition-duration"]', kind: 'exists' },

  // 8 特效 (9)
  { module: 8, moduleName: '特效滤镜', feature: '模糊', selector: '[data-testid="fx-add-blur"]', kind: 'exists' },
  { module: 8, moduleName: '特效滤镜', feature: '锐化', selector: '[data-testid="fx-add-sharpen"]', kind: 'exists' },
  { module: 8, moduleName: '特效滤镜', feature: '暗角', selector: '[data-testid="fx-add-vignette"]', kind: 'exists' },
  { module: 8, moduleName: '特效滤镜', feature: '光效', selector: '[data-testid="fx-add-glow"]', kind: 'exists' },
  { module: 8, moduleName: '特效滤镜', feature: '故障', selector: '[data-testid="fx-add-glitch"]', kind: 'exists' },
  { module: 8, moduleName: '特效滤镜', feature: '马赛克', selector: '[data-testid="fx-add-mosaic"]', kind: 'exists' },
  { module: 8, moduleName: '特效滤镜', feature: '降噪', selector: '[data-testid="fx-add-noiseReduce"]', kind: 'exists' },
  { module: 8, moduleName: '特效滤镜', feature: '滤镜', selector: '[data-testid="fx-add-filter"]', kind: 'exists' },
  { module: 8, moduleName: '特效滤镜', feature: '库模糊', selector: '[data-testid="effect-模糊"]' },

  // 9 蒙版 (10)
  { module: 9, moduleName: '蒙版抠像', feature: '矩形', selector: '[data-testid="mask-rect"]', kind: 'exists' },
  { module: 9, moduleName: '蒙版抠像', feature: '圆形', selector: '[data-testid="mask-ellipse"]', kind: 'exists' },
  { module: 9, moduleName: '蒙版抠像', feature: '线性', selector: '[data-testid="mask-linear"]', kind: 'exists' },
  { module: 9, moduleName: '蒙版抠像', feature: '钢笔', selector: '[data-testid="mask-pen"]', kind: 'exists' },
  { module: 9, moduleName: '蒙版抠像', feature: '文字蒙版', selector: '[data-testid="mask-text"]', kind: 'exists' },
  { module: 9, moduleName: '蒙版抠像', feature: '色度抠像', selector: '[data-testid="btn-chroma"]', kind: 'exists' },
  { module: 9, moduleName: '蒙版抠像', feature: '智能抠像', selector: '[data-testid="btn-smart-matte"]', kind: 'exists' },
  { module: 9, moduleName: '蒙版抠像', feature: '轨道蒙版', selector: '[data-testid="btn-track-matte"]', kind: 'exists' },
  { module: 9, moduleName: '蒙版抠像', feature: '剪贴蒙版', selector: '[data-testid="btn-clipping-mask"]', kind: 'exists' },
  { module: 9, moduleName: '蒙版抠像', feature: '反转', selector: '[data-testid="mask-invert"]', kind: 'exists' },

  // 10 画中画 (7)
  { module: 10, moduleName: '画中画合成', feature: '左上小窗', selector: '[data-testid="pip-tl"]', kind: 'exists' },
  { module: 10, moduleName: '画中画合成', feature: '右下小窗', selector: '[data-testid="pip-br"]', kind: 'exists' },
  { module: 10, moduleName: '画中画合成', feature: '左右分屏', selector: '[data-testid="pip-split"]', kind: 'exists' },
  { module: 10, moduleName: '画中画合成', feature: '全画幅', selector: '[data-testid="pip-full"]', kind: 'exists' },
  { module: 10, moduleName: '画中画合成', feature: '置于顶层', selector: '[data-testid="btn-bring-front"]', kind: 'exists' },
  { module: 10, moduleName: '画中画合成', feature: '混合模式', selector: '[data-testid="tf-blend"]', kind: 'exists' },
  { module: 10, moduleName: '画中画合成', feature: '不透明度', selector: '[data-testid="tf-opacity"]', kind: 'exists' },

  // 11 调色 (17)
  { module: 11, moduleName: '调色', feature: '曝光', selector: '[data-testid="color-exposure"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '对比度', selector: '[data-testid="color-contrast"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '饱和度', selector: '[data-testid="color-sat"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '色温', selector: '[data-testid="color-temp"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '色调', selector: '[data-testid="color-tint"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '高光', selector: '[data-testid="color-hl"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '阴影', selector: '[data-testid="color-sh"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: 'HSL', selector: '[data-testid="color-hue"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '白色', selector: '[data-testid="color-whites"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '黑色', selector: '[data-testid="color-blacks"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: 'LUT', selector: '[data-testid="color-lut"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '色轮', selector: '[data-testid="color-wheels"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '曲线', selector: '[data-testid="color-curve"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '示波器', selector: '[data-testid="scopes"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '一键校色', selector: '[data-testid="btn-auto-color"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '白平衡', selector: '[data-testid="btn-wb-pick"]', kind: 'exists' },
  { module: 11, moduleName: '调色', feature: '色彩匹配', selector: '[data-testid="btn-color-match"]', kind: 'exists' },

  // 12 音频 (18)
  { module: 12, moduleName: '音频', feature: '增益', selector: '[data-testid="audio-gain"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '声像', selector: '[data-testid="audio-pan"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '淡入', selector: '[data-testid="audio-fade-in"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '淡出', selector: '[data-testid="audio-fade-out"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: 'EQ低', selector: '[data-testid="audio-eq-low"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: 'EQ中', selector: '[data-testid="audio-eq-mid"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: 'EQ高', selector: '[data-testid="audio-eq-high"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '压缩', selector: '[data-testid="audio-compress"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '降噪', selector: '[data-testid="audio-denoise"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '混响', selector: '[data-testid="audio-reverb"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '音调', selector: '[data-testid="audio-pitch"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '闪避', selector: '[data-testid="audio-duck"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '静音', selector: '[data-testid="audio-mute"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '提取音频', selector: '[data-testid="btn-extract-audio"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '波形同步', selector: '[data-testid="btn-sync-audio"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '人声增强', selector: '[data-testid="btn-voice-enhance"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '响度统一', selector: '[data-testid="btn-loudness"]', kind: 'exists' },
  { module: 12, moduleName: '音频', feature: '电平表', selector: '[data-testid="level-meter"]', kind: 'exists' },
  { module: 10, moduleName: '画中画合成', feature: '水印设计', selector: '[data-testid="btn-watermark"]', kind: 'exists' },
  { module: 16, moduleName: '导出发布', feature: '抖音发布台', selector: '[data-testid="btn-douyin"]', kind: 'exists' },

  // 13 跟踪 (3)
  { module: 13, moduleName: '跟踪运镜', feature: '运动跟踪', selector: '[data-testid="btn-track"]', kind: 'exists' },
  { module: 13, moduleName: '跟踪运镜', feature: '防抖', selector: '[data-testid="btn-stabilize"]', kind: 'exists' },
  { module: 13, moduleName: '跟踪运镜', feature: '自动重构图', selector: '[data-testid="btn-reframe"]', kind: 'exists' },

  // 14 多机位 (3)
  { module: 14, moduleName: '多机位多时间线', feature: '多机位', selector: '[data-testid="tl-multicam"]' },
  { module: 14, moduleName: '多机位多时间线', feature: '多序列', selector: '[data-testid="tl-add-seq"]' },
  { module: 14, moduleName: '多机位多时间线', feature: '音频同步', selector: '[data-testid="btn-sync-audio"]', kind: 'exists' },

  // 15 模板预设 (7)
  { module: 15, moduleName: '模板与预设', feature: '预设列表', selector: '[data-testid="preset-list"]', kind: 'exists' },
  { module: 15, moduleName: '模板与预设', feature: '动效预设', selector: '[data-testid="motion-presets"]', kind: 'exists' },
  { module: 15, moduleName: '模板与预设', feature: '动效参数', selector: '[data-testid="motion-detail"]', kind: 'exists' },
  { module: 15, moduleName: '模板与预设', feature: '应用动效', selector: '[data-testid="motion-apply"]', kind: 'exists' },
  { module: 15, moduleName: '模板与预设', feature: '存运动预设', selector: '[data-testid="btn-save-motion-preset"]', kind: 'exists' },
  { module: 15, moduleName: '模板与预设', feature: '存调色预设', selector: '[data-testid="btn-save-color-preset"]', kind: 'exists' },
  { module: 15, moduleName: '模板与预设', feature: '存文字预设', selector: '[data-testid="btn-save-text-preset"]', kind: 'exists' },

  // 16 导出 (6)
  { module: 16, moduleName: '导出', feature: '打开导出', selector: '[data-testid="btn-export"]' },
  { module: 16, moduleName: '导出', feature: '1080p', selector: '[data-testid="export-1080p"]' },
  { module: 16, moduleName: '导出', feature: '竖屏9:16', selector: '[data-testid="export-9x16"]' },
  { module: 16, moduleName: '导出', feature: '仅音频', selector: '[data-testid="export-audio"]' },
  { module: 16, moduleName: '导出', feature: '区间导出', selector: '[data-testid="export-range"]' },
  { module: 16, moduleName: '导出', feature: '静帧封面', selector: '[data-testid="export-frame"]' },

  // 17 AI 生成 (8)
  { module: 17, moduleName: 'AI生成', feature: 'AI+页', selector: '[data-testid="lib-tab-ai"]' },
  { module: 17, moduleName: 'AI生成', feature: 'AI面板', selector: '[data-testid="ai-panel"]', kind: 'exists' },
  { module: 17, moduleName: 'AI生成', feature: '生图模式', selector: '[data-testid="ai-mode-image"]' },
  { module: 17, moduleName: 'AI生成', feature: '生视频模式', selector: '[data-testid="ai-mode-video"]' },
  { module: 17, moduleName: 'AI生成', feature: '面板截帧', selector: '[data-testid="ai-ref-capture"]' },
  { module: 17, moduleName: 'AI生成', feature: '监视器截帧', selector: '[data-testid="btn-capture-frame-monitor"]' },
  { module: 17, moduleName: 'AI生成', feature: '提示词', selector: '[data-testid="ai-prompt"]', kind: 'exists' },
  { module: 17, moduleName: 'AI生成', feature: '生成按钮', selector: '[data-testid="ai-generate"]' },
  { module: 17, moduleName: 'AI生成', feature: '弹出AI', selector: '[data-testid="btn-ai-float"]' },
  { module: 17, moduleName: 'AI生成', feature: '冷库列表', selector: '[data-testid="ai-cold-list"]', kind: 'exists' },
  { module: 17, moduleName: 'AI生成', feature: '队列面板', selector: '[data-testid="ai-queue"]', kind: 'exists' },
]

export async function runCapabilityCheck(
  clickFn: (sel: string) => Promise<boolean>,
  existsFn: (sel: string) => boolean,
) {
  const results: { item: CapabilityItem; ok: boolean }[] = []
  for (const item of CAPABILITY_MANIFEST) {
    const ok = item.kind === 'exists' ? existsFn(item.selector) : await clickFn(item.selector)
    results.push({ item, ok })
  }
  const pass = results.filter((r) => r.ok).length
  return { pass, total: results.length, results, byModule: groupByModule(results) }
}

function groupByModule(results: { item: CapabilityItem; ok: boolean }[]) {
  const m = new Map<number, { name: string; pass: number; total: number }>()
  for (const r of results) {
    const cur = m.get(r.item.module) ?? { name: r.item.moduleName, pass: 0, total: 0 }
    cur.total++
    if (r.ok) cur.pass++
    m.set(r.item.module, cur)
  }
  return Object.fromEntries(m)
}
