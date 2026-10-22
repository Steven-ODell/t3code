import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { agentSessionImport } from "../state/agentSessions";
import { useAtomCommand } from "../state/use-atom-command";

interface HistoryProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

/**
 * Turns the Claude Code and Codex sessions that ran in a project's folder
 * outside T3 (a terminal, a voice assistant) into threads with their messages.
 * Sessions already imported or owned by a T3 thread are left alone, so it is
 * safe to run again. Reports the outcome as a toast.
 */
export function useImportAgentHistory() {
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });

  return useCallback(
    async (projects: ReadonlyArray<HistoryProject>) => {
      let importedCount = 0;
      let skippedCount = 0;
      for (const project of projects) {
        const result = await importThreads({
          environmentId: project.environmentId,
          input: { projectId: project.id, expectedWorkspaceRoot: project.workspaceRoot },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to import Claude history",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return;
        }
        importedCount += result.value.importedCount;
        skippedCount += result.value.skippedCount;
      }
      const skipped =
        skippedCount === 0
          ? ""
          : // Empty or unreadable transcripts, or the rest of a batch past the
            // per-import limit, which the next import picks up.
            `${skippedCount} ${skippedCount === 1 ? "session was" : "sessions were"} skipped. Import again to continue a large batch.`;
      toastManager.add({
        type: skippedCount === 0 ? "success" : "warning",
        title:
          importedCount === 0
            ? "No Claude history to import"
            : `${importedCount} ${importedCount === 1 ? "thread" : "threads"} from Claude history`,
        description:
          skipped ||
          (importedCount === 0
            ? "No sessions from the last 30 days ran in this folder outside T3."
            : (projects[0]?.title ?? "")),
      });
    },
    [importThreads],
  );
}
