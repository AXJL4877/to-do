// 验证：选中「海绵宝宝口播」包后，成片卡片与我们新加的「重试」按钮是否出现
const pick = [...document.querySelectorAll('[data-testid]')]
  .find((e) => e.dataset.testid === 'skill-pick-studio.spongebob-koubo')
if (!pick) return JSON.stringify({ err: '找不到海绵宝宝口播条目', ids: [...document.querySelectorAll('[data-testid]')].map((e) => e.dataset.testid).slice(0, 24) })
pick.click()
await new Promise((r) => setTimeout(r, 5000))

const sec = [...document.querySelectorAll('[data-testid]')].find((e) => e.dataset.testid === 'skill-productions')
const cards = [...document.querySelectorAll('[data-testid]')].filter((e) => e.dataset.testid.startsWith('production-card-'))
const retries = [...document.querySelectorAll('[data-testid]')].filter((e) => e.dataset.testid.startsWith('production-retry-'))
return JSON.stringify({
  sectionPresent: !!sec,
  cardIds: cards.map((e) => e.dataset.testid),
  cardText: cards.length ? cards[0].innerText.replace(/\n/g, ' | ').slice(0, 100) : null,
  retryCount: retries.length,
  retryTitle: retries.length ? retries[0].title : null,
  retryDisabled: retries.length ? retries[0].disabled : null,
}, null, 2)
