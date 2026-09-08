/**
 * 水害イベントの索引。
 *
 * 元データは 1 イベント = 1 Shapefile で分かれており、変換後も `src_file` 属性に
 * 残っている。イベント名（disastName）と範囲はタイルの見えている部分からしか
 * 引けないため、変換結果から静的な索引を書き出して使う。
 * 生成は `uv run python viewer/scripts/build_events.py`。
 */

export interface FloodEvent {
  /** 元 Shapefile 名。タイルの `src_file` 属性と一致する絞り込みキー。 */
  src: string
  year: number | null
  /** '09' や '08-09'（複数月にまたがるイベント）。月不明は null。 */
  month: string | null
  /** 元号ラベル（m29 / s56 / h11 / r1 など）。 */
  era: string | null
  typhoon: boolean
  /** 災害名。元データが NULL のイベントもある。 */
  name: string | null
  count: number
  /** [minLon, minLat, maxLon, maxLat] */
  bounds: [number, number, number, number]
}

export interface EventIndex {
  features: number
  year_bins: number[]
  /** 年代凡例の階級ごとの件数。 */
  bin_counts: number[]
  bounds: [number, number, number, number]
  events: FloodEvent[]
}

export async function loadEventIndex(): Promise<EventIndex> {
  const res = await fetch(`${import.meta.env.BASE_URL}events.json`)
  if (!res.ok) throw new Error(`events.json を読めない: ${res.status}`)
  return (await res.json()) as EventIndex
}

/** '08-09' → '8・9月'、'09' → '9月'、null → ''。 */
export function monthLabel(month: string | null): string {
  if (!month) return ''
  const parts = month.split('-').map((m) => String(Number(m)))
  return `${parts.join('・')}月`
}

/** イベント選択リストに出す1行。年月を先頭に置いて時系列で読めるようにする。 */
export function eventLabel(e: FloodEvent): string {
  const when = `${e.year ?? '????'}年${monthLabel(e.month)}`
  const name = e.name ?? '（災害名なし）'
  return `${when} ${name}（${e.count.toLocaleString('ja-JP')}件）`
}
