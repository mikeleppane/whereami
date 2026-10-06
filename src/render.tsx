import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  TextProps,
  UiPressArgument,
} from 'claude-code'
import { WHY_TEXT } from './feature'
import { bandText, cut, type View } from './text'
import type { ItemStatus } from './types'

// The elements the pane draws with: what `$.ui.resolve(e)` hands the caller. No `$` here: the engine never
// follows it across an import, so the caller resolves the elements and owns every press.
export type PaneElements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

const NOTE = 80

function row(i: ItemStatus): string {
  return [
    `${i.key} ${i.title}`,
    i.state,
    ...(i.reviewed ? ['reviewed'] : []),
    ...(i.fixRound ? [`fix round ${i.fixRound[0]}/${i.fixRound[1]}`] : []),
    ...(i.parked ? [`${i.parked} parked`] : []),
    ...(i.waitingOn?.length ? [`waiting on ${i.waitingOn.join(', ')}`] : []),
    ...(i.type ? [`type ${i.type}`] : []),
    ...i.evidence.map((e) => `${e.strength}: ${e.text}`),
    ...(i.differsOn ?? []).map((b) => `differs on ${b}`),
  ].join(' · ')
}

const day = (ms: number) => (ms > 0 ? [`changed ${new Date(ms).toISOString().slice(0, 10)}`] : [])

// The /whereami pane (spec section 7). Every Button is keyed (`draft`, `choose:<id>`, `unlink`, `forget`) and
// pressed through `press`; the user's notice from the last press shows first.
export function paneTree(
  ui: PaneElements,
  v: View | null,
  notice: string | null,
  press: (e: UiPressArgument) => void,
) {
  const { Box, Text, Button } = ui
  const lines: string[] = []
  const buttons: [string, string][] = []
  if (v === null) lines.push('whereami: nothing to show here')
  else if (v.kind === 'choose') {
    lines.push(bandText(v, Number.POSITIVE_INFINITY))
    for (const c of v.candidates) {
      lines.push(`${c.id}: ${[...c.why.map((w) => WHY_TEXT[w]), ...day(c.lastChange)].join('; ')}`)
      buttons.push([`choose:${c.id}`, `This is ${c.id}`])
    }
  } else {
    const items = [...(v.sp?.items ?? []), ...(v.matt?.items ?? [])]
    const notes = [...(v.sp?.notes ?? []), ...(v.matt?.notes ?? [])]
    const docs = Object.entries(v.docs).filter(([, p]) => p !== undefined)
    lines.push(
      bandText(v, Number.POSITIVE_INFINITY),
      ...docs.map(([kind, path]) => `${kind}: ${path}`),
      ...items.flatMap((i) => [
        row(i),
        ...(i.findings ?? []).map((f) => `finding: ${cut(f, NOTE)}`),
      ]),
      ...notes.map((n) => `note: ${cut(n, NOTE)}`),
      ...[v.sp, v.matt].flatMap((r) =>
        r?.unsupported === undefined ? [] : [`${r.library}: unsupported format: ${r.unsupported}`],
      ),
      ...v.notices,
    )
    if (v.next !== null)
      lines.push(
        `next: ${v.next.text}${v.next.missing === undefined ? '' : ` (not installed: ${v.next.missing})`}`,
      )
    if (v.next?.command !== undefined) buttons.push(['draft', `Draft ${v.next.command}`])
    if (v.switchedFrom !== undefined)
      buttons.push([`choose:${v.switchedFrom}`, `This is ${v.switchedFrom}`])
    buttons.push(['unlink', 'Not this feature'], ['forget', 'Forget'])
  }
  return (
    <Box flexDirection="column">
      {notice === null ? null : <Text bold>{notice}</Text>}
      {lines.map((l) => (
        <Text>{l}</Text>
      ))}
      {buttons.map(([key, label]) => (
        <Button key={key} label={label} onPress={press} />
      ))}
    </Box>
  )
}
