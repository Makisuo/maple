import * as Alchemy from "alchemy-effect";
import * as AWS from "alchemy-effect/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsStaticSiteExample",
  {
    providers: AWS.providers(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.StaticSite("MarketingSite", {
      path: "./site",
      // domain: "your.domain.com",
      forceDestroy: true,
      invalidation: {
        paths: "all",
      },
      tags: {
        Example: "aws-static-site",
        Surface: "website",
      },
    });

    return {
      url: site.url,
    };
  }),
);
