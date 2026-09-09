import { eventLabel, monthLabel, type FloodEvent } from './events'

/**
 * 水害イベントの検索付き選択（コンボボックス）。
 *
 * イベントは60件あり、素の <select> では目的の災害（例: 2000年の東海豪雨）を
 * 探すのに一覧を目で追うことになる。災害名・年・元号・ファイル名を対象に
 * 絞り込めるようにする。
 *
 * ARIA の combobox パターンに沿う: input[role=combobox] が ul[role=listbox] を
 * aria-controls で指し、キーボード操作中の候補を aria-activedescendant で示す。
 */

/**
 * 検索用に文字列を正規化する。
 *
 * 元データは全角括弧「（平成12）」と半角括弧「(平成8)」が混在し、
 * 全角数字を含むものもある。NFKC でこれらを半角へ寄せ、記号と空白を落として
 * 「2000平成12年9月台風14号東海豪雨」のような1本の文字列に均す。
 * これで "東海"、"2000"、"平成12" のどれでも当たる。
 */
const norm = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・()［］\[\]「」、。,.-]/g, '')

/**
 * 1イベント分の検索対象を1本の正規化済み文字列にまとめる。
 * 災害名・年月・元号ラベル・元ファイル名を対象にする。
 */
export function eventHaystack(e: FloodEvent): string {
  const when = `${e.year ?? ''}年${monthLabel(e.month)}`
  return norm([e.name ?? '', when, e.era ?? '', e.src].join(' '))
}

/**
 * 空白区切りの各語をすべて含むか（AND）。空クエリは全件に当たる。
 * 語の分割は正規化前のクエリで行う（norm() が空白を落とすため）。
 */
export function matchesQuery(hay: string, query: string): boolean {
  const words = query.trim().split(/\s+/).map(norm).filter(Boolean)
  return words.every((w) => hay.includes(w))
}

interface Entry {
  event: FloodEvent
  label: string
  /** 検索対象を1本にまとめた正規化済み文字列。 */
  hay: string
}

export interface EventPicker {
  /** 外から選択状態を反映する（`?event=` の復元など）。 */
  setSelected(src: string | null): void
}

export interface EventPickerOptions {
  input: HTMLInputElement
  list: HTMLUListElement
  clearBtn: HTMLButtonElement
  events: FloodEvent[]
  /** 選択が変わったときに呼ばれる。null は「すべてのイベント」。 */
  onSelect: (src: string | null) => void
}

const ALL_LABEL = 'すべてのイベント'

export function createEventPicker(o: EventPickerOptions): EventPicker {
  const entries: Entry[] = o.events.map((event) => ({
    event,
    label: eventLabel(event),
    hay: eventHaystack(event),
  }))

  let selected: string | null = null
  /** いま候補として並んでいるもの。キーボード操作の対象。 */
  let shown: Entry[] = []
  /** shown の中で選択中の位置。-1 は「すべてのイベント」行。 */
  let active = -1
  let open = false

  const labelOf = (src: string | null): string =>
    src === null ? '' : (entries.find((e) => e.event.src === src)?.label ?? '')

  const filterEntries = (query: string): Entry[] =>
    entries.filter((e) => matchesQuery(e.hay, query))

  function renderList(query: string): void {
    shown = filterEntries(query)
    const rows: HTMLLIElement[] = []

    const allRow = document.createElement('li')
    allRow.id = 'event-opt-all'
    allRow.className = 'combo-opt combo-opt-all'
    allRow.setAttribute('role', 'option')
    allRow.setAttribute('aria-selected', String(selected === null))
    allRow.textContent = ALL_LABEL
    allRow.addEventListener('mousedown', (ev) => {
      // blur より先に拾う。blur が先に走ると閉じてクリックが届かない
      ev.preventDefault()
      choose(null)
    })
    rows.push(allRow)

    shown.forEach((e, i) => {
      const li = document.createElement('li')
      li.id = `event-opt-${i}`
      li.className = 'combo-opt'
      li.setAttribute('role', 'option')
      li.setAttribute('aria-selected', String(selected === e.event.src))
      li.dataset.src = e.event.src
      li.textContent = e.label
      li.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        choose(e.event.src)
      })
      rows.push(li)
    })

    if (shown.length === 0) {
      const li = document.createElement('li')
      li.className = 'combo-empty'
      li.textContent = '該当する災害がありません'
      rows.push(li)
    }

    o.list.replaceChildren(...rows)
    syncActive()
  }

  /** キーボードで選んでいる行に印を付け、見える位置まで送る。 */
  function syncActive(): void {
    const opts = [...o.list.querySelectorAll<HTMLElement>('.combo-opt')]
    // index 0 が「すべて」行なので、active -1 → 0 番目に対応する
    const at = active + 1
    opts.forEach((li, i) => li.classList.toggle('active', i === at))
    const el = opts[at]
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
      o.input.setAttribute('aria-activedescendant', el.id)
    } else {
      o.input.removeAttribute('aria-activedescendant')
    }
  }

  function setOpen(next: boolean): void {
    open = next
    o.list.hidden = !next
    o.input.setAttribute('aria-expanded', String(next))
    if (!next) {
      active = -1
      o.input.removeAttribute('aria-activedescendant')
    }
  }

  function choose(src: string | null): void {
    selected = src
    o.input.value = labelOf(src)
    o.clearBtn.hidden = src === null
    setOpen(false)
    o.onSelect(src)
  }

  o.input.addEventListener('focus', () => {
    // 選択済みのラベルが入ったままだと絞り込みの邪魔になるので、
    // 打ち始めたら置き換わるように全選択しておく
    o.input.select()
    renderList('')
    setOpen(true)
  })

  o.input.addEventListener('input', () => {
    active = -1
    renderList(o.input.value)
    setOpen(true)
  })

  o.input.addEventListener('blur', () => {
    // 打ちかけのクエリを残さない。選択済みならそのラベルに戻す
    o.input.value = labelOf(selected)
    setOpen(false)
  })

  o.input.addEventListener('keydown', (ev) => {
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault()
        if (!open) {
          renderList(o.input.value)
          setOpen(true)
        } else {
          active = Math.min(active + 1, shown.length - 1)
          syncActive()
        }
        break
      case 'ArrowUp':
        ev.preventDefault()
        active = Math.max(active - 1, -1)
        syncActive()
        break
      case 'Enter':
        if (!open) break
        ev.preventDefault()
        choose(active < 0 ? null : shown[active].event.src)
        break
      case 'Escape':
        if (!open) break
        ev.preventDefault()
        o.input.value = labelOf(selected)
        setOpen(false)
        break
    }
  })

  o.clearBtn.addEventListener('click', () => {
    choose(null)
    o.input.focus()
  })

  o.clearBtn.hidden = true

  return {
    setSelected(src: string | null): void {
      selected = src
      o.input.value = labelOf(src)
      o.clearBtn.hidden = src === null
      setOpen(false)
    },
  }
}
