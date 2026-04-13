import * as S from "effect/Schema";
import { defineAspect, type Aspect } from "../Aspect.ts";

export interface Channel<
  Name extends string = string,
  References extends any[] = any[],
> extends Aspect<Channel, "channel", Name, References> {}

export type ChannelId = string;
export const ChannelId = S.String.annotate({
  description: "The ID of the channel",
});

export const Channel =
  defineAspect<
    <const Name extends string>(
      name: Name,
    ) => <References extends any[]>(
      template: TemplateStringsArray,
      ...references: References
    ) => Channel<Name, References>
  >("channel");

export const channelContext = Channel.plugin.context.succeed({
  context: (channel) => `#${channel.id}`,
});
