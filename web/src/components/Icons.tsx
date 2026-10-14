// Line icons, drawn on a 16px grid with a 1.5px stroke in currentColor.

type P = { size?: number; className?: string; title?: string }

function Svg({ size = 14, className, title, children }: P & { children: React.ReactNode }) {
  return (
    <svg className={`icon${className ? ' ' + className : ''}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {children}
    </svg>
  )
}

export const XIcon = (p: P) => <Svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></Svg>
export const ImageIcon = (p: P) => <Svg {...p}><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1.1" /><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" /></Svg>
export const TerminalIcon = (p: P) => <Svg {...p}><path d="M3 4.5l3 3-3 3M8 11.5h5" /></Svg>
export const FileIcon = (p: P) => <Svg {...p}><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></Svg>
export const PencilIcon = (p: P) => <Svg {...p}><path d="M10.5 2.5l3 3L6 13H3v-3z" /><path d="M9 4l3 3" /></Svg>
export const SearchIcon = (p: P) => <Svg {...p}><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></Svg>
export const GlobeIcon = (p: P) => <Svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c-2 2.2-2 8.8 0 11M8 2.5c2 2.2 2 8.8 0 11" /></Svg>
export const AgentsIcon = (p: P) => <Svg {...p}><circle cx="5.5" cy="6" r="2" /><circle cx="11" cy="6" r="2" /><path d="M2 13c.5-2 2-3 3.5-3s3 1 3.5 3M8.5 12c.5-1.4 1.4-2 2.5-2 1.5 0 2.6 1 3 3" /></Svg>
export const ListIcon = (p: P) => <Svg {...p}><path d="M6 4.5h7M6 8h7M6 11.5h7" /><path d="M3 4.5h.01M3 8h.01M3 11.5h.01" /></Svg>
export const ToolIcon = (p: P) => <Svg {...p}><circle cx="8" cy="8" r="2" /><path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M3.8 12.2l1.4-1.4M10.8 5.2l1.4-1.4" /></Svg>
export const FolderIcon = (p: P) => <Svg {...p}><path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3A1 1 0 002 4.5z" /></Svg>
export const UpIcon = (p: P) => <Svg {...p}><path d="M8 13V3M4 7l4-4 4 4" /></Svg>
export const ArchiveIcon = (p: P) => <Svg {...p}><rect x="2" y="3" width="12" height="3" rx="1" /><path d="M3 6v6.5a1 1 0 001 1h8a1 1 0 001-1V6M6.5 8.5h3" /></Svg>
export const CheckIcon = (p: P) => <Svg {...p}><path d="M3 8.5l3 3 7-7" /></Svg>
export const BlockIcon = (p: P) => <Svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M4.2 11.8l7.6-7.6" /></Svg>
export const DashIcon = (p: P) => <Svg {...p}><path d="M4 8h8" /></Svg>
export const BackIcon = (p: P) => <Svg {...p}><path d="M10 3L5 8l5 5" /></Svg>
export const ChevronIcon = (p: P) => <Svg {...p}><path d="M6 3.5l4.5 4.5L6 12.5" /></Svg>
export const GearIcon = (p: P) => <Svg {...p}><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" /><circle cx="8" cy="8" r="4.2" /></Svg>
export const CommentIcon = (p: P) => <Svg {...p}><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></Svg>
export const UndoIcon = (p: P) => <Svg {...p}><path d="M5 6.5H10a3 3 0 010 6H7" /><path d="M7 4L4.5 6.5 7 9" /></Svg>
export const TrashIcon = (p: P) => <Svg {...p}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></Svg>
export const PanelIcon = (p: P) => <Svg {...p}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M10 3v10" /></Svg>
export const TimerIcon = (p: P) => <Svg {...p}><circle cx="8" cy="9" r="5" /><path d="M8 9V6.5M6.5 2h3M12 4.5l1 -1" /></Svg>
export const OpenIcon = (p: P) => <Svg {...p}><path d="M9.5 2.5h4v4M13.5 2.5L8 8" /><path d="M11.5 9.5v3a1 1 0 01-1 1h-7a1 1 0 01-1-1v-7a1 1 0 011-1h3" /></Svg>
export const MoreIcon = (p: P) => <Svg {...p}><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.2" /></Svg>
