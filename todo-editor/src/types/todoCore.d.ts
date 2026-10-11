/**
 * 无 UI 核心层（server/spec、server/core）的类型声明。
 *
 * 这些模块是纯 JS（.mjs），但被渲染进程 import（共享核心），所以在这里给出**最小而准确**的
 * 类型签名：既让 TS 编译通过，也让调用方拿到参数校验（写错参数名 TS 就会报）。
 * 类型与实现同步的责任在这里——改核心层导出时，这个文件也要改。
 */
declare module '*/server/spec/projectSpec.mjs' {
  export const SPEC_PROJECT_V2: string
  export const TOP_LEVEL: Record<string, 'meta' | 'document' | 'session'>
  export interface SpecIssue { code: string; path: string; message: string; hint?: string }
  export interface SpecStats { seqCount: number; trackCount: number; clipCount: number; mediaCount: number; productionCount: number }
  export interface SpecReport { ok: boolean; spec: string; errors: SpecIssue[]; warnings: SpecIssue[]; stats: SpecStats }
  export function detectSpec(doc: unknown): string
  export function validateProject(doc: unknown): SpecReport
  export function summarizeProject(doc: unknown, opts?: { maxMedia?: number }): {
    ok: boolean
    spec: string
    name: string | null
    canvas: { width: number | null; height: number | null; fps: number | null; background: string | null }
    activeSeqId: string | null
    sequences: Array<{ id: string; name: string | null; duration: number; trackCount: number; clips: number; markers: number }>
    productions: Array<{ id: string; t0: number | null; auto: boolean; placed: number }>
    media: { total: number; byKind: Record<string, number>; sample: unknown[]; truncated: number }
  }
}

declare module '*/server/core/commands.mjs' {
  export interface CommandResult {
    ok: true
    doc: Record<string, unknown>
    changed: string[]
    created: string[]
    summary: string
    undoable: boolean
  }
  export interface CommandError {
    ok: false
    error: { code: string; message: string; hint?: string; details?: unknown }
  }
  export interface CommandDescriptor {
    id: string
    label: string
    category: string
    destructive: boolean
    params?: Record<string, unknown>
  }
  export const COMMAND_IDS: string[]
  export function describeCommands(opts?: { withParams?: boolean }): CommandDescriptor[]
  export function applyCommand(
    doc: unknown,
    id: string,
    args?: Record<string, unknown>,
    opts?: { newId?: (prefix: string) => string; validateAfter?: boolean },
  ): CommandResult | CommandError
}

declare module '*/server/spec/capabilities.mjs' {
  export const CAPABILITIES_SPEC: string
  export const ERROR_CODES: Record<string, string>
  export function capabilities(opts?: { version?: string | null; aiBaseUrl?: string | null; view?: 'catalog' | 'full' }): {
    spec: string
    view: string
    operations: Array<{ id: string; method: string; path: string; status: string; summary: string }>
    commands: Record<string, unknown>
  }
}
