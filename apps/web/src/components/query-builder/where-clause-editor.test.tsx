// @vitest-environment jsdom

import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor";
import type { QueryBuilderDataSource } from "@/lib/query-builder/model";

function Harness({
  dataSource,
  initialValue,
}: {
  dataSource: QueryBuilderDataSource;
  initialValue: string;
}) {
  const [value, setValue] = React.useState(initialValue);

  return (
    <WhereClauseEditor
      dataSource={dataSource}
      value={value}
      onChange={setValue}
      placeholder="where clause"
      values={{
        services: ["checkout", "cart"],
        severities: ["ERROR", "WARN"],
      }}
      ariaLabel="where-clause"
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("WhereClauseEditor", () => {
  it("applies key suggestions with Enter", () => {
    render(<Harness dataSource="logs" initialValue="ser" />);

    const textarea = screen.getByLabelText("where-clause") as HTMLTextAreaElement;
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "ser" } });
    textarea.setSelectionRange(3, 3);
    fireEvent.select(textarea);

    expect(screen.getByRole("option", { name: /service\.name/i })).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe("service.name ");
  });

  it("applies value suggestions with Enter", () => {
    render(<Harness dataSource="logs" initialValue="service.name = ch" />);

    const textarea = screen.getByLabelText("where-clause") as HTMLTextAreaElement;
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "service.name = ch" } });
    textarea.setSelectionRange(17, 17);
    fireEvent.select(textarea);

    expect(screen.getByRole("option", { name: /checkout/i })).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe('service.name = "checkout" ');
  });

  it("applies conjunction suggestions with Enter", () => {
    render(<Harness dataSource="logs" initialValue='service.name = "checkout" ' />);

    const textarea = screen.getByLabelText("where-clause") as HTMLTextAreaElement;
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: 'service.name = "checkout" ' } });
    textarea.setSelectionRange(26, 26);
    fireEvent.select(textarea);

    expect(screen.getByRole("option", { name: /and/i })).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe('service.name = "checkout" AND ');
  });
});
