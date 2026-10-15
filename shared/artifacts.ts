// Artifacts: small HTML pages over data that agents make (server/artifacts.ts).
// The shape is Prolifica's, so one can be published there as it is.

// A tool call that wrote an artifact's files, or showed it: where in which session.
export type ArtifactTouch = { sid: string; seq: number; ts: number }

export type Artifact = {
  name: string            // its folder under ~/.codinger/artifacts
  title: string
  description?: string
  mtime: number           // the latest change to any of its files
  created?: ArtifactTouch // the first tool call Codinger saw write it
  edits: ArtifactTouch[]  // every one since, oldest first (the last 100)
  published?: ArtifactPublished
  error?: string          // its artifact.json could not be read
}

// data: what each data file was when it went up (sha256), and its dataset id there.
export type ArtifactPublished = {
  id: string; url: string; version: number; at: number; mtime: number
  visibility: Visibility; data: Record<string, { sha: string; id: string }>
}
export type Visibility = 'public' | 'unlisted' | 'private'

// What the preview pane of a session shows: an artifact, or a page a dev server serves.
export type PreviewTarget = { artifact: string } | { url: string }

// The Prolifica account Codinger publishes with, once connected.
export type ProlificaState = { handle: string | null; origin: string } | null
