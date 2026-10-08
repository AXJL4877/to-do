import catalog from '../../../shared/jizura-catalog.json'
export const JIZURA_CATALOG = catalog
export type JizuraGroup = keyof typeof catalog.groups
export const JIZURA_GROUP_NAMES: Record<JizuraGroup, string> = {
  layout: '排版', enter: '入场', hold: '持续运动', exit: '退场', decor: '装饰',
  treat: '文字质感', bg: '背景图形', cam: '镜头', fx: '后期效果', trans: '转场',
}
