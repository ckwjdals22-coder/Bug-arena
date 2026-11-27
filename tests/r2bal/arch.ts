import { ARCHETYPES } from '../../shared/content/archetypes'
import { PITCH_LINES } from '../../shared/content/lines'
import { OFFER_ITEMS } from '../../shared/content/offerings'
for (const a of ARCHETYPES as any[]) console.log(a.id, 'w', a.weight, 'base', a.base, 'like', JSON.stringify(a.like), 'flee', a.flee, 'ign', a.ignore, 'cur', a.curious, a.special ?? '', a.recruitable===false?'NOREC':'')
const byRank: Record<number, number> = {}
for (const l of PITCH_LINES) byRank[l.rank] = (byRank[l.rank] ?? 0) + 1
console.log('lines per rank', byRank, 'total', PITCH_LINES.length)
const r: Record<number, number> = {}
for (const o of OFFER_ITEMS as any[]) r[o.rarity] = (r[o.rarity] ?? 0) + 1
console.log('offer rarities', r, OFFER_ITEMS.length)
for (let k = 0; k <= 5; k++) { const ls = PITCH_LINES.filter(l => l.rank === k); console.log('rank', k, 'avg power', (ls.reduce((a, l) => a + l.power, 0) / ls.length).toFixed(3), 'max', Math.max(...ls.map(l => l.power)), 'cats', [...new Set(ls.map(l=>l.cat))].join(',')) }
