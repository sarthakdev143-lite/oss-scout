/**
 * opencode V1 entry (`server(input, options)`, opencode >= 1.18.29 reads it from the default export).
 * V1 plugins cannot register slash commands, so approval in V1 is CLI-only:
 * `bun src/cli.ts approve <id> <digest>` in an interactive terminal. The tools are read-only +
 * reject/edit, never approve. Config: never read from the location (see loadPluginConfig).
 * Type-only imports from @opencode-ai/plugin; zod is a runtime dependency of oss-scout itself.
 */
import type { Hooks, Plugin as V1Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { z } from "zod"
import { createApp, type App } from "../app.ts"
import type { LoadedConfig } from "../config/load.ts"
import { ConfigError } from "../config/schema.ts"
import { errorMessage, type Logger } from "../util/log.ts"
import { redact } from "../util/redact.ts"
import { createV1LlmHost } from "./llm-v1.ts"
import { agentSessions, BLOCKED_MESSAGE } from "./llm-v2.ts"
import {
  createOptionsFrom,
  guardBlocks,
  isTaskLocation,
  loadEntryConfig,
  looksLikeTaskLocation,
  pathsFor,
  shouldAutostart,
  TOOL_SPECS,
  type EntryAppOptions,
  type ToolSpec,
} from "./v2.ts"

/** Tool descriptions are read by the model: name the rule, never a command line it could run. */
const CLI_ONLY_APPROVAL =
  "Approval is human-only: under opencode V1 the user approves in an interactive terminal with the oss-scout CLI. Tools and agents cannot approve."

const queueId = z.number().int().min(1).describe("Queue item id")

/** zod raw shapes for the V1 tool map (same inputs as the V2 JSON Schemas). */
const V1_ARGS: Record<string, z.ZodRawShape> = {
  status: {},
  queue_list: {
    status: z
      .enum(["pending", "all", "approved", "submitted", "rejected", "failed", "superseded"])
      .optional()
      .describe("Which items to list (default pending)"),
  },
  queue_show: { id: queueId },
  queue_reject: { id: queueId, reason: z.string().min(1).describe("Why it is rejected") },
  queue_edit: { id: queueId, field: z.enum(["title", "body"]), text: z.string().min(1).describe("New title or body") },
}

function v1Tool(app: App, spec: ToolSpec): ToolDefinition {
  return {
    description: `${spec.description} ${CLI_ONLY_APPROVAL}`,
    args: V1_ARGS[spec.name] ?? {},
    async execute(args, context) {
      if (agentSessions.has(context.sessionID)) return `error: ${BLOCKED_MESSAGE}`
      let call: { command: string; args: string }
      try {
        call = spec.toCommand(args)
      } catch (err) {
        return `error: invalid input for oss_scout_${spec.name}: ${errorMessage(err)}`
      }
      return app.commands.run(call.command, call.args, "tool")
    },
  }
}

/** The V1 tool map: oss_scout_status, oss_scout_queue_list, …_show, …_reject, …_edit (no approve). */
export function buildV1Tools(app: App): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {}
  for (const spec of TOOL_SPECS) tools[`oss_scout_${spec.name}`] = v1Tool(app, spec)
  return tools
}

function guardHook(everySession: boolean, log?: Pick<Logger, "debug">): NonNullable<Hooks["tool.execute.before"]> {
  return async (input, output) => {
    if (guardBlocks(input.tool, input.sessionID, everySession, output?.args, log)) throw new Error(BLOCKED_MESSAGE)
  }
}

function logSetupFailure(err: unknown): void {
  const reason = err instanceof ConfigError ? err.message : `oss-scout failed to start: ${errorMessage(err)}`
  console.error(`[oss-scout] ${redact(reason)} (run "bun src/cli.ts doctor" in the oss-scout directory for details)`)
}

/** V1 `server` plugin function. Never throws into opencode. */
export const serverV1: V1Plugin = (input, options) => createServerV1()(input, options)

/** Build the V1 `server` function with extra createApp options (tests: env, fetch, exec, fakes). */
export function createServerV1(appOptions: EntryAppOptions = {}): V1Plugin {
  return async (input, options) => {
    const directory = input.directory
    // The location (the project opencode was opened in) is never a config source.
    let loaded: LoadedConfig
    try {
      loaded = loadEntryConfig(options ?? null, appOptions)
    } catch (err) {
      logSetupFailure(err)
      // oss-scout's own agent sessions stay guarded even when it cannot start.
      return { "tool.execute.before": guardHook(looksLikeTaskLocation(directory)) }
    }
    const paths = pathsFor(loaded)

    // Never act inside a task workspace: only guard the (untrusted) sessions located there.
    if (isTaskLocation(directory, paths)) return { "tool.execute.before": guardHook(true) }

    let app: App
    try {
      app = createApp({
        ...createOptionsFrom(appOptions),
        directory,
        pluginOptions: options ?? null,
        loaded,
        llm: (log) => createV1LlmHost(input.client, paths.stateDir, { log }),
      })
    } catch (err) {
      logSetupFailure(err)
      return { "tool.execute.before": guardHook(looksLikeTaskLocation(directory)) }
    }

    let autostart: ReturnType<typeof setTimeout> | null = null
    if (shouldAutostart(app.ctx.config, directory)) {
      autostart = setTimeout(() => {
        autostart = null
        try {
          app.scheduler.start()
        } catch (err) {
          app.ctx.log.error("scheduler failed to start", { error: errorMessage(err) })
        }
      }, 0)
    }
    app.ctx.log.info("oss-scout plugin ready (opencode v1)", { directory, mode: app.ctx.config.mode, autostart: autostart !== null })

    return {
      tool: buildV1Tools(app),
      "tool.execute.before": guardHook(false, app.ctx.log),
      dispose: async () => {
        if (autostart) clearTimeout(autostart)
        autostart = null
        await app.close()
      },
    }
  }
}
