// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgTinybirdSettingsSection } from "./org-tinybird-settings-section";

type MockResult =
  | { readonly _tag: "initial" }
  | { readonly _tag: "success"; readonly value: unknown }
  | { readonly _tag: "failure" };

const mocks = vi.hoisted(() => ({
  refreshSpy: vi.fn(),
  upsertSpy: vi.fn(),
  resyncSpy: vi.fn(),
  deleteSpy: vi.fn(),
  toastSuccessSpy: vi.fn(),
  toastErrorSpy: vi.fn(),
  settingsResult: { _tag: "initial" } as MockResult,
  deploymentStatusResult: {
    _tag: "success",
    value: {
      hasRun: false,
      hasDeployment: false,
      deploymentId: null,
      status: null,
      deploymentStatus: null,
      runStatus: null,
      phase: null,
      isTerminal: null,
      errorMessage: null,
      startedAt: null,
      updatedAt: null,
      finishedAt: null,
    },
  } as MockResult,
}));

vi.mock("@/lib/services/common/atom-client", () => ({
  MapleApiAtomClient: {
    query: (_group: string, name: string) => ({ kind: "query", name }),
    mutation: (_group: string, name: string) => ({ kind: "mutation", name }),
  },
}));

vi.mock("@/lib/effect-atom", () => ({
  Atom: { kvs: () => ({}) },
  Result: {
    builder: (result: MockResult) => ({
      onSuccess: (onSuccess: (value: unknown) => unknown) => ({
        orElse: (onElse: () => unknown) =>
          result._tag === "success" ? onSuccess(result.value) : onElse(),
      }),
    }),
    isInitial: (result: MockResult) => result._tag === "initial",
    isSuccess: (result: MockResult) => result._tag === "success",
  },
  useAtomRefresh: () => mocks.refreshSpy,
  useAtomSet: (descriptor: { readonly name: string }) => {
    if (descriptor.name === "upsert") return mocks.upsertSpy;
    if (descriptor.name === "resync") return mocks.resyncSpy;
    if (descriptor.name === "delete") return mocks.deleteSpy;
    throw new Error(`Unexpected mutation ${descriptor.name}`);
  },
  useAtomValue: (atom: { name?: string }) => {
    if (atom?.name === "deploymentStatus") return mocks.deploymentStatusResult;
    if (atom?.name === "instanceHealth") {
      return { _tag: "success", value: { totalBytes: 0, totalRows: 0, datasources: [] } };
    }
    return mocks.settingsResult;
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccessSpy,
    error: mocks.toastErrorSpy,
  },
}));

describe("OrgTinybirdSettingsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsResult = {
      _tag: "success",
      value: {
        configured: true,
        activeHost: "https://customer.tinybird.co",
        draftHost: null,
        syncStatus: "active",
        lastSyncAt: "2026-03-13T10:00:00.000Z",
        lastSyncError: null,
        projectRevision: "rev-1",
        currentRun: null,
      },
    };
    mocks.deploymentStatusResult = {
      _tag: "success",
      value: {
        hasRun: false,
        hasDeployment: false,
        deploymentId: null,
        status: null,
        deploymentStatus: null,
        runStatus: null,
        phase: null,
        isTerminal: null,
        errorMessage: null,
        startedAt: null,
        updatedAt: null,
        finishedAt: null,
      },
    };
    mocks.upsertSpy.mockResolvedValue(Exit.succeed({}));
    mocks.resyncSpy.mockResolvedValue(Exit.succeed({}));
    mocks.deleteSpy.mockResolvedValue(Exit.succeed({}));
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the out_of_sync badge and guidance", () => {
    mocks.settingsResult = {
      _tag: "success",
      value: {
        configured: true,
        activeHost: "https://customer.tinybird.co",
        draftHost: null,
        syncStatus: "out_of_sync",
        lastSyncAt: "2026-03-13T10:00:00.000Z",
        lastSyncError: null,
        projectRevision: "rev-1",
        currentRun: null,
      },
    };

    render(<OrgTinybirdSettingsSection isAdmin hasEntitlement />);

    expect(screen.getByText("Out of sync")).toBeTruthy();
    expect(screen.getByText(/project definition changed since this org last synced/i)).toBeTruthy();
  });

  it("shows a failed draft host separately from the active host", () => {
    mocks.settingsResult = {
      _tag: "success",
      value: {
        configured: false,
        activeHost: null,
        draftHost: "https://draft.tinybird.co",
        syncStatus: "error",
        lastSyncAt: "2026-03-13T10:00:00.000Z",
        lastSyncError: "bad credentials",
        projectRevision: "rev-1",
        currentRun: {
          targetHost: "https://draft.tinybird.co",
          targetProjectRevision: "rev-1",
          runStatus: "failed",
          phase: "failed",
          deploymentId: null,
          deploymentStatus: null,
          errorMessage: "bad credentials",
          startedAt: "2026-03-13T10:00:00.000Z",
          updatedAt: "2026-03-13T10:00:00.000Z",
          finishedAt: "2026-03-13T10:00:00.000Z",
          isTerminal: true,
        },
      },
    };
    mocks.deploymentStatusResult = {
      _tag: "success",
      value: {
        hasRun: true,
        hasDeployment: false,
        deploymentId: null,
        status: "failed",
        deploymentStatus: null,
        runStatus: "failed",
        phase: "failed",
        isTerminal: true,
        errorMessage: "bad credentials",
        startedAt: "2026-03-13T10:00:00.000Z",
        updatedAt: "2026-03-13T10:00:00.000Z",
        finishedAt: "2026-03-13T10:00:00.000Z",
      },
    };

    render(<OrgTinybirdSettingsSection isAdmin hasEntitlement />);

    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("Maple-managed Tinybird")).toBeTruthy();
    expect(screen.getByText("https://draft.tinybird.co")).toBeTruthy();
    expect(screen.getByText("bad credentials")).toBeTruthy();
  });

  it("renders no deployment row details when the org has never deployed", () => {
    render(<OrgTinybirdSettingsSection isAdmin hasEntitlement />);

    expect(screen.getByText("No deployments yet")).toBeTruthy();
  });

  it("renders the active deployment number and deploying status", () => {
    mocks.deploymentStatusResult = {
      _tag: "success",
      value: {
        hasRun: true,
        hasDeployment: true,
        deploymentId: "dep-1",
        status: "deploying",
        deploymentStatus: "deploying",
        runStatus: "running",
        phase: "deploying",
        isTerminal: false,
        errorMessage: null,
        startedAt: "2026-03-13T10:00:00.000Z",
        updatedAt: "2026-03-13T10:00:00.000Z",
        finishedAt: null,
      },
    };

    render(<OrgTinybirdSettingsSection isAdmin hasEntitlement />);

    expect(screen.getByText("#dep-1")).toBeTruthy();
    expect(screen.getAllByText("Deploying").length).toBeGreaterThan(0);
  });

  it("renders the last live deployment when idle", () => {
    mocks.deploymentStatusResult = {
      _tag: "success",
      value: {
        hasRun: true,
        hasDeployment: true,
        deploymentId: "dep-1",
        status: "live",
        deploymentStatus: "live",
        runStatus: "succeeded",
        phase: "succeeded",
        isTerminal: true,
        errorMessage: null,
        startedAt: "2026-03-13T10:00:00.000Z",
        updatedAt: "2026-03-13T10:00:00.000Z",
        finishedAt: "2026-03-13T10:05:00.000Z",
      },
    };

    render(<OrgTinybirdSettingsSection isAdmin hasEntitlement />);

    expect(screen.getByText("#dep-1")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("renders a failed deployment with its number and error", () => {
    mocks.deploymentStatusResult = {
      _tag: "success",
      value: {
        hasRun: true,
        hasDeployment: true,
        deploymentId: "dep-1",
        status: "failed",
        deploymentStatus: "failed",
        runStatus: "failed",
        phase: "failed",
        isTerminal: true,
        errorMessage: "broken pipe",
        startedAt: "2026-03-13T10:00:00.000Z",
        updatedAt: "2026-03-13T10:00:00.000Z",
        finishedAt: "2026-03-13T10:05:00.000Z",
      },
    };

    render(<OrgTinybirdSettingsSection isAdmin hasEntitlement />);

    expect(screen.getByText("#dep-1")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("broken pipe")).toBeTruthy();
  });

  it("resyncs explicitly from the settings screen", async () => {
    render(<OrgTinybirdSettingsSection isAdmin hasEntitlement />);

    fireEvent.click(screen.getByRole("button", { name: "Resync project" }));

    await waitFor(() => {
      expect(mocks.resyncSpy).toHaveBeenCalledWith({});
    });
    expect(mocks.refreshSpy).toHaveBeenCalled();
    expect(mocks.toastSuccessSpy).toHaveBeenCalledWith("Tinybird resync started");
    expect(mocks.toastErrorSpy).not.toHaveBeenCalled();
  });

  it("renders nothing when the org lacks the BYO entitlement", () => {
    const { container } = render(<OrgTinybirdSettingsSection isAdmin hasEntitlement={false} />);

    expect(container.firstChild).toBeNull();
  });
});
