// @vitest-environment jsdom

import { Registry, RegistryContext } from "@/lib/effect-atom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PageRefreshProvider,
  usePageRefreshContext,
} from "@/components/time-range-picker/page-refresh-context";

import { useTableRefreshTimeRange } from "./use-table-refresh-time-range";

function createWrapper() {
  const registry = Registry.make();

  return function Wrapper({ children }: { children: ReactNode }) {
    return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
  };
}

function Controls() {
  const { reload } = usePageRefreshContext();

  return <button onClick={reload}>reload</button>;
}

function Probe(props: {
  startTime?: string;
  endTime?: string;
  timePreset?: string;
  defaultRange?: string;
}) {
  const range = useTableRefreshTimeRange(props);

  return (
    <>
      <Controls />
      <div data-testid="start">{range.startTime}</div>
      <div data-testid="end">{range.endTime}</div>
    </>
  );
}

describe("useTableRefreshTimeRange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("advances relative preset ranges on reload without route mutation", async () => {
    render(
      <PageRefreshProvider timePreset="15m">
        <Probe startTime="2026-03-10 11:45:00" endTime="2026-03-10 12:00:00" timePreset="15m" />
      </PageRefreshProvider>,
      { wrapper: createWrapper() },
    );

    expect(screen.getByTestId("start").textContent).toBe("2026-03-10 11:45:00");
    expect(screen.getByTestId("end").textContent).toBe("2026-03-10 12:00:00");

    vi.setSystemTime(new Date("2026-03-10T12:00:10.000Z"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "reload" }));
      await Promise.resolve();
    });

    expect(screen.getByTestId("start").textContent).toBe("2026-03-10 11:45:10");
    expect(screen.getByTestId("end").textContent).toBe("2026-03-10 12:00:10");
  });

  it("keeps absolute custom ranges fixed on reload", async () => {
    render(
      <PageRefreshProvider>
        <Probe startTime="2026-03-10 08:00:00" endTime="2026-03-10 09:00:00" />
      </PageRefreshProvider>,
      { wrapper: createWrapper() },
    );

    vi.setSystemTime(new Date("2026-03-10T12:00:10.000Z"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "reload" }));
      await Promise.resolve();
    });

    expect(screen.getByTestId("start").textContent).toBe("2026-03-10 08:00:00");
    expect(screen.getByTestId("end").textContent).toBe("2026-03-10 09:00:00");
  });
});
