// Codinger keeps itself up to date with origin/main (server/update.ts): a push to
// main is a release. The page shows a banner while an update waits, runs or stops.
//
// behind: commits on origin/main that this checkout does not have; head: origin/main's
// short hash (a banner you close stays closed until the next one); subject: its message.
export type UpdateStatus =
  | { state: 'current' }
  | { state: 'waiting'; behind: number; head: string; subject: string }  // until no session is working
  | { state: 'updating'; behind: number; head: string; subject: string }
  | { state: 'blocked'; behind: number; head: string; subject: string; why: string } // the checkout stops it; an agent can do it
  | { state: 'failed'; behind: number; head: string; subject: string; why: string }
