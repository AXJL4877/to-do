import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { buildExtensionPack } from '../server/extensionPacks.mjs'
const dir=path.resolve('examples/extensions/corner-chain'), output=path.resolve('deliverables/corner-chain.todoext')
mkdirSync(dir,{recursive:true});mkdirSync(path.dirname(output),{recursive:true})
const pack=JSON.parse(readFileSync('server/skills/dynamic-text/skill.json','utf8'))
Object.assign(pack,{id:'studio.corner-chain',name:'转角推进',version:'1.2.1',author:'TO DO Studio',description:'纯文字口播：句尾90°衔接；按句序轮换八套镜头与文字编排，独立平移、旋转、放大节奏，甩镜、追字、折页、轮廓纵深、重击急停。保留可编辑文字。'})
const keep=['voice','cloneId','split','segmentChars','size','tail','fps','subtitles','subtitleChars','motion','font','textColor','accent']
pack.params=pack.params.filter(p=>keep.includes(p.id)).map(p=>{
  if(['textColor','accent'].includes(p.id))delete p.when
  if(p.id==='split')p.default='paragraph'
  if(p.id==='subtitles')p.default='off'
  if(p.id==='motion')p.default=.9
  if(p.id==='textColor')p.default='#ffffff'
  if(p.id==='accent'){p.default='#b5b5b5';p.label='历史文字颜色'}
  if(p.id==='font')p.options=[{value:'MicrosoftYaHei',label:'微软雅黑'},{value:'SimHei',label:'黑体'},{value:'SmileySans',label:'得意黑'},{value:'KaiTi',label:'楷体'},{value:'SimSun',label:'宋体'},{value:'Arial',label:'Arial'},{value:'custom',label:'本机自定义字体'}]
  return p
})
const select=(id,label,group,values,defaultValue)=>({id,type:'select',group,label,default:defaultValue,options:values.map(([value,label])=>({value,label}))})
const number=(id,label,group,min,max,step,value)=>({id,type:'number',group,label,min,max,step,default:value})
pack.params.push(
  select('effect','文字引擎','scene',[['corner-chain','90°转角推进']],'corner-chain'),
  select('direction','转角方向','scene',[['clockwise','连续顺时针'],['alternate','左右交替'],['mixed','混合转向']],'alternate'),
  select('variant','表现变化','scene',[['mix','自动混合'],['type','打字机与光标'],['pop','逐字弹出'],['mask','遮罩逐字升入'],['slam','冲击压缩'],['ribbon','逐字弹簧'],['echo','文字残影'],['focus','失焦推进']],'mix'),
  select('easing','缓动曲线','timing',[['spring','弹簧震荡'],['back','强回弹'],['expo','指数推进']],'spring'),
  number('zoom','放大力度','timing',.6,1.4,.05,1),number('transition','转角时长','timing',.15,1.8,.05,1.05),
  number('stagger','逐字间隔','timing',0,.08,.002,.018),number('trail','保留前句','scene',1,4,1,3),
  select('fontWeight','字重','text',[['400','常规'],['700','粗体'],['900','特粗']],'900'),
  {id:'customFont',type:'text',group:'text',label:'本机字体名称',default:'Microsoft YaHei',maxLength:64,pattern:'^[^"\\\\\\r\\n]{1,64}$',when:{font:['custom']}},
  select('background','背景','scene',[['style','纯色背景'],['transparent','透明叠加']],'style'),
  {id:'backgroundColor',type:'text',group:'scene',label:'背景颜色',default:'#101010',maxLength:7,pattern:'^#[0-9a-fA-F]{6}$',when:{background:['style']}},
)
pack.quick=['font','variant','easing','direction','motion','size']
pack.planner={maxElements:1,system:'严格按配音短句时间戳保留口播原文，按顺序安排文字镜头；下一句从上一句末端以九十度衔接，文字不能省略或改写。'}
writeFileSync(path.join(dir,'skill.json'),JSON.stringify(pack,null,2)+'\n')
if(process.argv.includes('--source-only'))console.log(JSON.stringify({ok:true,manifest:path.join(dir,'skill.json')}))
else {writeFileSync(output,buildExtensionPack(dir));console.log(JSON.stringify({ok:true,file:output,bytes:readFileSync(output).length}))}
