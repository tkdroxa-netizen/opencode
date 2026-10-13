export * as ConfigDiscovery from "./discovery.js"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "../location.js"
import { AbsolutePath } from "../schema.js"
import type { Options } from "../config.js"

export const names = ["opencode.json", "opencode.jsonc"]

/** Eligible sources in priority order, including paths that may appear later. */
export interface Sources {
  readonly system?: { readonly path: AbsolutePath; readonly present: boolean }
  readonly global?: AbsolutePath
  readonly explicit?: AbsolutePath
  readonly direct: readonly AbsolutePath[]
  readonly project: readonly { readonly path: AbsolutePath; readonly present: boolean }[]
  readonly claude: readonly AbsolutePath[]
  readonly agents: readonly AbsolutePath[]
}

/** Platform system configuration directory (`/Library/Application Support/opencode`, `/etc/opencode`, `%ProgramData%\opencode`). */
export function systemDirectory(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
  if (platform === "darwin") return AbsolutePath.make("/Library/Application Support/opencode")
  if (platform === "win32") return AbsolutePath.make(path.join(env.ProgramData || "C:\\ProgramData", "opencode"))
  return AbsolutePath.make("/etc/opencode")
}

export const discover = Effect.fn("ConfigDiscovery.discover")(function* (options?: Options) {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const location = yield* Location.Service
  const system =
    options?.system === false
      ? undefined
      : typeof options?.system === "string"
        ? AbsolutePath.make(path.resolve(options.system))
        : systemDirectory()
  const globalDirectory = AbsolutePath.make(global.config)
  const globalAgentsDirectory = AbsolutePath.make(path.join(global.home, ".agents"))
  const globalClaudeDirectory = AbsolutePath.make(path.join(global.home, ".claude"))
  const configDirectories = [...(system ? [system] : []), globalDirectory]
  const globalRoots = yield* Effect.forEach(
    [...configDirectories, globalClaudeDirectory, globalAgentsDirectory],
    (item) => fs.resolve(item),
  )
  const current = yield* fs.resolve(location.directory)
  const directories =
    globalRoots.slice(0, configDirectories.length).includes(current) || options?.project === false
      ? []
      : yield* fs.up({ targets: ["."], start: location.directory }).pipe(Effect.orDie)
  const discovered = yield* Effect.forEach(directories, (directory) =>
    Effect.gen(function* () {
      // Resolve the parent too: missing children must honor symlinked global roots.
      const parent = yield* fs.resolve(directory)
      return yield* Effect.forEach([".claude", ".agents", ".opencode", ...names.toReversed()], (name) =>
        fs
          .resolve(path.join(parent, name))
          .pipe(Effect.map((resolved) => ({ item: AbsolutePath.make(path.join(directory, name)), resolved }))),
      )
    }),
  ).pipe(
    Effect.map((items) => items.flat()),
    Effect.orDie,
  )

  const globalEnabled = options?.global !== false
  const globalFiles = yield* Effect.forEach(
    configDirectories.flatMap((directory) => names.map((name) => path.join(directory, name))),
    (file) => fs.resolve(file),
  )
  // Global sources must not re-enter through the project walk.
  const visible = discovered
    .filter(({ resolved }) =>
      globalEnabled
        ? !globalRoots.includes(resolved) && !globalFiles.includes(resolved)
        : !globalRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep)),
    )
    .map(({ item }) => item)

  return {
    system: globalEnabled && system ? { path: system, present: yield* fs.isDir(system) } : undefined,
    global: globalEnabled ? globalDirectory : undefined,
    explicit: options?.file ? AbsolutePath.make(path.resolve(options.file)) : undefined,
    direct: visible.filter((item) => ![".agents", ".claude", ".opencode"].includes(path.basename(item))).toReversed(),
    project: yield* Effect.forEach(
      visible.filter((item) => path.basename(item) === ".opencode").toReversed(),
      (directory) => fs.isDir(directory).pipe(Effect.map((present) => ({ path: directory, present }))),
    ),
    claude: [
      ...new Set([
        ...(globalEnabled ? [globalClaudeDirectory] : []),
        ...visible.filter((item) => path.basename(item) === ".claude").toReversed(),
      ]),
    ],
    agents: [
      ...new Set([
        ...(globalEnabled ? [globalAgentsDirectory] : []),
        ...visible.filter((item) => path.basename(item) === ".agents").toReversed(),
      ]),
    ],
  } satisfies Sources
})
