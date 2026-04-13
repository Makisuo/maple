import * as S from "effect/Schema";

export type IssueId = number;
export const IssueId = S.Int.check(S.isGreaterThan(0)).annotate({
  description: "The ID of the issue",
});

export type IssueDescription = string;
export const IssueDescription = S.String.annotate({
  description: "The description of the issue",
});

export type IssueTitle = string;
export const IssueTitle = S.String.annotate({
  description: "The title of the issue",
});

export class Issue extends S.Class<Issue>("Issue")({
  issueId: IssueId,
  title: IssueTitle,
  description: IssueDescription,
}) {}
