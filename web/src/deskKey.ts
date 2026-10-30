// Desks of one site share an address under their own paths (CODINGER_BASE), and so one localStorage.
// What names a server's sessions is kept per path: shared, a desk opens on another's session, and
// a desk with none leaves every other desk on "No session selected".
export const deskKey = (key: string, root: string | undefined) => root ? `${key}@${root}` : key

// A desk opens on its conversation: past a narrow width the panel takes the conversation's place,
// and a console around the desk (its rail, its settings) makes that an ordinary width.
export const firstPanel = (root: string | undefined, phone: boolean) => root || phone ? null : 'items' as const
