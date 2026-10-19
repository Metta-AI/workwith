// The panel beside a session, one tab at a time: what its agent showed (Preview, Artifacts.tsx),
// its files (Files, FileBrowser.tsx), and its questions and items (Items, AttentionPanel.tsx).
// wide: it takes the conversation's place too, because you asked or because the two do not fit
// side by side (auto). A tab you opened stays mounted, so it keeps its place when you come back.

import { useState } from 'react'
import { type PanelTab } from '../store.ts'
import { useItems } from '../items.ts'
import { ArtifactIcon, ArtifactPane, NarrowIcon, WideIcon } from './Artifacts.tsx'
import { AttentionPanel, ItemCount } from './AttentionPanel.tsx'
import { FileBrowser } from './FileBrowser.tsx'
import { FolderIcon, PanelIcon, XIcon } from './Icons.tsx'
import type { SessionMeta } from '../../../shared/types.ts'

const LABEL: Record<PanelTab, string> = { preview: 'Preview', files: 'Files', items: 'Items' }
const ICON: Record<PanelTab, React.ReactNode> = { preview: <ArtifactIcon size={13} />, files: <FolderIcon size={13} />, items: <PanelIcon size={13} /> }

type Props = { m: SessionMeta; tab: PanelTab; tabs: PanelTab[]; width: number; wide: boolean; auto: boolean; onTab(t: PanelTab): void; onWide(): void; onHide(): void }

export function SidePanel({ m, tab, tabs, width, wide, auto, onTab, onWide, onHide }: Props) {
  const [seen, setSeen] = useState<Set<PanelTab>>(() => new Set([tab]))
  if (!seen.has(tab)) setSeen(new Set([...seen, tab]))
  const waiting = useItems(m.id).filter((i) => i.status === 'open')
  return (
    <aside className={`side-panel${wide ? ' wide' : ''}`} style={wide ? undefined : { width }} data-pid="side-panel">
      <div className="panel-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={t === tab} className={`panel-tab${t === tab ? ' on' : ''}`} data-pid={`panel-tab-${t}`} onClick={() => onTab(t)}>
            {ICON[t]}<span>{LABEL[t]}</span>{t === 'items' && waiting.length > 0 && <ItemCount items={waiting} />}
          </button>
        ))}
        <span className="grow" />
        {!auto && <button className="icon-btn" data-tip={wide ? 'Show the conversation' : 'Use the full width'} onClick={onWide}>{wide ? <NarrowIcon size={14} /> : <WideIcon size={14} />}</button>}
        <button className="icon-btn" data-tip="Hide" onClick={onHide}><XIcon size={13} /></button>
      </div>
      {tabs.filter((t) => seen.has(t)).map((t) => (
        <div key={t} className="panel-body" hidden={t !== tab}>
          {t === 'preview' ? <ArtifactPane sid={m.id} /> : t === 'files' ? <FileBrowser m={m} /> : <AttentionPanel sid={m.id} />}
        </div>
      ))}
    </aside>
  )
}
