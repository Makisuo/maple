import { beforeAll, deploy, expect, test } from "alchemy-effect/Test/Bun";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const stack = beforeAll(deploy(Stack));

// afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "integ",
  Effect.gen(function* () {
    const { url } = yield* stack;

    expect(url).toBeString();
  }),
);
