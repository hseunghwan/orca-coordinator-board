// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { BoardView, ProjectChoice, ReplyResult } from './model'

declare module 'orca' {
  interface PluginRequests {
    /** Selected projects with their sessions, pull requests and the decisions waiting for a person. */
    'board.read': { input: { refresh?: boolean; locale?: string }; output: BoardView }
    /** Every project Orca knows, and which ones the board shows. */
    'board.projects': { output: { projects: ProjectChoice[]; selected: string[] } }
    'board.select-projects': { input: { projectIds: string[] }; output: { selected: string[] } }
    /**
     * Types the person's own reply into a session's terminal. The worker re-reads the agent first
     * and refuses a session waiting for permission, a busy one, or one whose state changed.
     */
    'board.reply': {
      input: {
        workspaceId: string
        terminalId: string
        text: string
        expectedSince: number
        projectName: string
        workspaceName: string
        title: string
      }
      output: ReplyResult
    }
    /** Shows a session: its terminal, or its workspace when it has none (a chat tab). */
    /**
     * Resumes a closed session in a new terminal and types the person's reply into it. The worker
     * reads the session's workspace and history again first and refuses one that is open again.
     */
    'board.resume-reply': {
      input: {
        workspaceId: string
        sessionId: string
        agent: string
        text: string
        projectName: string
        workspaceName: string
        title: string
      }
      output: ReplyResult
    }
    'board.focus': { input: { terminalId?: string | null; workspaceId?: string }; output: { focused: boolean } }
    /** Hides a reply or review card until its session or pull request changes. */
    'board.dismiss': { input: { key: string }; output: { ok: true } }
  }
  interface PluginPanelEvents {
    /** Posted after a reply, a dismissal or a project change, so every open panel reloads. */
    'board.changed': { at: number }
  }
}
