import * as Context from "effect/Context";

export class Profile extends Context.Service<Profile, string>()(
  "AWS::Profile",
) {}
