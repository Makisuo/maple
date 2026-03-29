// @vitest-environment jsdom

import { Atom, Registry, RegistryContext, Result } from "@/lib/effect-atom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useRetainedRefreshableResultValue } from "./use-retained-refreshable-result-value";

function createWrapper() {
  const registry = Registry.make();

  return function Wrapper({ children }: { children: ReactNode }) {
    return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
  };
}

const successAtom = Atom.make(Result.success({ rows: ["ready"] }));
const initialAtom = Atom.make(Result.initial<{ rows: string[] }, never>());

function Harness() {
  const [currentAtom, setCurrentAtom] =
    useState<Atom.Atom<Result.Result<{ rows: string[] }, never>>>(successAtom);
  const result = useRetainedRefreshableResultValue(currentAtom);

  return (
    <div>
      <button onClick={() => setCurrentAtom(initialAtom)}>swap</button>
      <div data-testid="state">{result._tag}</div>
      <div data-testid="waiting">{String(result.waiting)}</div>
      <div data-testid="row">
        {Result.builder(result)
          .onSuccess((value) => value.rows[0] ?? "none")
          .orElse(() => "none")}
      </div>
    </div>
  );
}

describe("useRetainedRefreshableResultValue", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the last successful payload visible when the next atom is initial", async () => {
    render(<Harness />, { wrapper: createWrapper() });

    expect(screen.getByTestId("state").textContent).toBe("Success");
    expect(screen.getByTestId("waiting").textContent).toBe("false");
    expect(screen.getByTestId("row").textContent).toBe("ready");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "swap" }));
      await Promise.resolve();
    });

    expect(screen.getByTestId("state").textContent).toBe("Success");
    expect(screen.getByTestId("waiting").textContent).toBe("true");
    expect(screen.getByTestId("row").textContent).toBe("ready");
  });
});
