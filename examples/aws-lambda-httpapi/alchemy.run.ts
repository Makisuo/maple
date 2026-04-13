import * as AWS from "alchemy-effect/AWS";
import * as Output from "alchemy-effect/Output";
import * as Stack from "alchemy-effect/Stack";
import { Stage } from "alchemy-effect/Stage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import JobFunction from "./src/JobFunction.ts";

const awsConfig = Layer.effect(
  AWS.StageConfig,
  Effect.gen(function* () {
    const stage = yield* Stage;

    if (stage === "prod") {
      // example of how to programatically configure a stage, e.g. hard-code account for prod
      return {
        account: "123456789012",
        region: "us-west-2",
      };
    }

    return yield* AWS.loadDefaultStageConfig();
  }).pipe(Effect.orDie),
);

// const aws = AWS.providers() // <- can also use the default aws stage config by omitting
const aws = AWS.providers().pipe(Layer.provide(awsConfig));
const dashboardRegion = process.env.AWS_REGION ?? "us-west-2";

const stack = Effect.gen(function* () {
  const func = yield* JobFunction;
  const dashboard = yield* AWS.CloudWatch.Dashboard("JobDashboard", {
    DashboardBody: func.functionName.pipe(
      Output.map((functionName) => ({
        widgets: [
          {
            type: "metric",
            x: 0,
            y: 0,
            width: 12,
            height: 6,
            properties: {
              title: "Lambda Invocations and Errors",
              region: dashboardRegion,
              stat: "Sum",
              period: 300,
              metrics: [
                ["AWS/Lambda", "Invocations", "FunctionName", functionName],
                ["AWS/Lambda", "Errors", "FunctionName", functionName],
              ],
            },
          },
          {
            type: "metric",
            x: 12,
            y: 0,
            width: 12,
            height: 6,
            properties: {
              title: "Lambda Duration",
              region: dashboardRegion,
              stat: "Average",
              period: 300,
              metrics: [
                ["AWS/Lambda", "Duration", "FunctionName", functionName],
              ],
            },
          },
        ],
      })),
    ),
  });
  const alarm = yield* AWS.CloudWatch.Alarm("JobFunctionErrorsAlarm", {
    AlarmDescription: "Alerts when the example Lambda function reports errors.",
    MetricName: "Errors",
    Namespace: "AWS/Lambda",
    Statistic: "Sum",
    Period: 300,
    EvaluationPeriods: 1,
    Threshold: 1,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    TreatMissingData: "notBreaching",
    Dimensions: [
      {
        Name: "FunctionName",
        Value: func.functionName,
      },
    ],
  });
  return {
    url: Output.interpolate`${func.functionUrl}?jobId=foo`,
    dashboardName: dashboard.dashboardName,
    alarmName: alarm.alarmName,
  };
});

export default stack.pipe(
  Stack.make(
    "JobLambdaHttpApi",
    Layer.mergeAll(
      // Fully configured cloud provider Layers go here:
      aws,
    ),
  ),
);
