// Estimates and what the work took (server/estimates.ts), for the cost panel.

export type EstimateRow = {
  id: string; t: number; sid: string; title?: string; task: string; minutes: number; usd?: number; humanHours?: number
  actual?: { minutes: number; usd: number; calls: number; note?: string }
}
// The medians the prompt quotes, over n pairs: actual over estimate, and per human hour.
export type EstimatesFound = { n: number; time?: number; cost?: number; perHour?: number; usdPerHour?: number }
export type EstimatesReply = { rows: EstimateRow[]; found: EstimatesFound }
