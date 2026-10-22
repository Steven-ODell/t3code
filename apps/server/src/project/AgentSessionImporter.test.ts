import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
          nativeHeadId: null,
        },
      }),
  });
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getBoundNativeThreadIds: () => Effect.succeed(new Set<string>()),
        }),
        IdAllocator.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(layerTest));
});

const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const OWNED_SESSION = "11111111-1111-4111-8111-111111111111";
const STRAY_SESSION = "22222222-2222-4222-8222-222222222222";
const VOICE_SESSION = "33333333-3333-4333-8333-333333333333";

function claudeSession(sessionId: string): AgentSessionScanner.AgentSessionRecentThread {
  return {
    _tag: "Importable",
    source: {
      provider: "claudeAgent",
      providerInstanceId: claudeInstanceId,
      providerSessionId: sessionId,
      filePath: `/home/user/.claude/projects/-home-user/${sessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: "claudeAgent",
      providerInstanceId: claudeInstanceId,
      providerSessionId: sessionId,
      title: "Voice session",
      model: "claude-opus-5-5",
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:01:00.000Z",
      messages: [
        { role: "user", text: "Hello", createdAt: "2026-09-01T10:00:00.000Z" },
        { role: "assistant", text: "Hi", createdAt: "2026-09-01T10:01:00.000Z" },
      ],
      nativeHeadId: `${sessionId}-head`,
    },
  };
}

function claudeImportLayer(input: {
  readonly sessions: ReadonlyArray<AgentSessionScanner.AgentSessionRecentThread>;
  readonly boundNativeIds: ReadonlySet<string>;
  readonly runtimeRows?: ReadonlyArray<unknown>;
  readonly requested: Array<ReadonlyArray<string> | undefined>;
  readonly writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>>;
}) {
  return AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          AgentSessionScanner.AgentSessionScanner,
          AgentSessionScanner.AgentSessionScanner.of({
            scan: Effect.die("unused"),
            recentThreads: (_root, _completed, options) => {
              input.requested.push(options?.providerSessionIds);
              return Stream.fromIterable(input.sessions);
            },
          }),
        ),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/home/user" } as never)),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (threadId) =>
            Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (write) => Effect.sync(() => (input.writes.push(write.events), [])),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed((input.runtimeRows ?? []) as never),
          upsert: () => Effect.void,
          recordImportedTranscript: () => Effect.void,
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getBoundNativeThreadIds: () => Effect.succeed(input.boundNativeIds),
        }),
        IdAllocator.layer,
      ),
    ),
  );
}

it.effect("leaves sessions another thread already resumes alone", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const layerTest = claudeImportLayer({
    sessions: [claudeSession(OWNED_SESSION), claudeSession(STRAY_SESSION)],
    boundNativeIds: new Set([OWNED_SESSION]),
    requested: [],
    writes,
  });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(writes.map((events) => events[0]?.threadId)).toEqual([
      ThreadId.make(`import:${claudeInstanceId}:${STRAY_SESSION}`),
    ]);
  }).pipe(Effect.provide(layerTest));
});

it.effect("leaves sessions a thread from before the V2 store resumes alone", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const layerTest = claudeImportLayer({
    sessions: [claudeSession(OWNED_SESSION), claudeSession(STRAY_SESSION)],
    boundNativeIds: new Set(),
    // V1 threads keep their original session only in the runtime's cursor.
    runtimeRows: [
      {
        threadId: ThreadId.make("v1-thread"),
        providerName: "claudeAgent",
        resumeCursor: { threadId: "v1-thread", resume: OWNED_SESSION },
        runtimePayload: null,
      },
    ],
    requested: [],
    writes,
  });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(writes.map((events) => events[0]?.threadId)).toEqual([
      ThreadId.make(`import:${claudeInstanceId}:${STRAY_SESSION}`),
    ]);
  }).pipe(Effect.provide(layerTest));
});

it.effect("imports a requested Claude session as an active thread that resumes at its head", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const requested: Array<ReadonlyArray<string> | undefined> = [];
  const layerTest = claudeImportLayer({
    sessions: [claudeSession(VOICE_SESSION)],
    boundNativeIds: new Set(),
    requested,
    writes,
  });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(
      yield* importer.importRecentAgentThreads({
        projectId,
        providerSessionIds: [VOICE_SESSION],
      }),
    ).toEqual({ importedCount: 1, skippedCount: 0 });
    expect(requested).toEqual([[VOICE_SESSION]]);

    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({ settledOverride: null, settledAt: null });
    expect(providerThread?.payload).toMatchObject({
      nativeThreadRef: { driver: "claudeAgent", nativeId: VOICE_SESSION, strength: "strong" },
      nativeConversationHeadRef: {
        driver: "claudeAgent",
        nativeId: `${VOICE_SESSION}-head`,
        strength: "weak",
      },
    });
  }).pipe(Effect.provide(layerTest));
});
