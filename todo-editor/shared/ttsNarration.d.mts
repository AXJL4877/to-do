export interface Narration {
  text: string
  audio: string
  timing: string
  duration: number
}
export function availableNarration(job: unknown): Narration | null
export function narrationJobId(url: unknown): string | null
export function subtitleNarrationSource(body: { sourceJobId?: string; sourceMedia?: { url?: string; path?: string } }, findJob: (id: string) => unknown): (Narration & { mode: 'script'; jobId: string }) | null
