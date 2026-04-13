// @ts-nocheck - uncomment this once we are working on AI again

import { Tool } from "../tool/tool.ts";
import { Issues } from "./issue-service.ts";
import { Issue, IssueId } from "./issue.ts";

export class title extends Tool.input("title")`
The title of the Issue.` {}

export class description extends Tool.input(
  "description",
)`The description of the Issue.` {}

export class issueId extends Tool.input(
  "issueId",
  IssueId,
)`The ID of the Issue.` {}

export class readIssue extends Tool("readIssue")`
Read an ${Issue} in the Thread with its ${issueId}.
`(({ issueId }) => Issues.readIssue(issueId)) {}

export class createIssue extends Tool("createIssue")`
Create an Issue in the Thread with a ${title} and ${description}.
`(Issues.createIssue) {}

export class updateIssue extends Tool("updateIssue")`
Update an ${Issue}'s ${title} and/or ${description} referenced by its ${issueId}.
`(Issues.updateIssue) {}

export class closeIssue extends Tool("closeIssue")`
Close an Issue in the Thread referenced by its ${issueId}.
`(({ issueId }) => Issues.closeIssue(issueId)) {}
