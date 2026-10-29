// Codinger keeps itself up to date with origin/main (server/update.ts): a push to
// main is a release. The page shows a banner that offers an update, or while one
// waits, runs or stops. Settings.autoUpdate: ask first (the default), always or never.
//
// behind: commits on origin/main that this checkout does not have; head: origin/main's
// short hash (a banner you close stays closed until the next one); subject: its message.
export type UpdateMode = 'ask' | 'always' | 'never'

export type UpdateStatus =
  | { state: 'current' }
  | { state: 'offer'; behind: number; head: string; subject: string }    // ask: install it?
  | { state: 'waiting'; behind: number; head: string; subject: string }  // until no session is working
  | { state: 'updating'; behind: number; head: string; subject: string }
  | { state: 'blocked'; behind: number; head: string; subject: string; why: string } // the checkout stops it; an agent can do it
  | { state: 'failed'; behind: number; head: string; subject: string; why: string }
