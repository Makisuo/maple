#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer } from "effect"
import * as Command from "effect/unstable/cli/Command"
import { cli } from "./cli"
import { CliConfig } from "./services/CliConfig"
import { MapleClient } from "./services/MapleClient"

const MainLayer = MapleClient.layer.pipe(
  Layer.provideMerge(CliConfig.layer),
  Layer.provideMerge(BunServices.layer),
)

Command.run(cli, { version: "0.1.0" }).pipe(
  Effect.provide(MainLayer),
  BunRuntime.runMain,
)
