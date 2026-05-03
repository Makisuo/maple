---
title: "C# / .NET Instrumentation"
description: "Instrument a .NET application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 9
sdk: "csharp"
---

This guide covers instrumenting a .NET (C#) application to send traces and logs to Maple using the OpenTelemetry SDK.

## Prerequisites

- .NET 6+ (works on .NET Framework 4.6.2+ via OpenTelemetry's net462 target)
- A Maple project with an API key

## Install Dependencies

```bash
dotnet add package OpenTelemetry
dotnet add package OpenTelemetry.Extensions.Hosting
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol
dotnet add package OpenTelemetry.Instrumentation.AspNetCore
dotnet add package OpenTelemetry.Instrumentation.Http
```

## Configure the SDK

For an ASP.NET Core or generic-host app, wire OpenTelemetry into the host builder in `Program.cs`:

```csharp
using OpenTelemetry;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using OpenTelemetry.Logs;

var builder = WebApplication.CreateBuilder(args);

const string MapleEndpoint = "https://ingest.maple.dev";
const string MapleAuth = "Authorization=Bearer YOUR_API_KEY";

builder.Services.AddOpenTelemetry()
    .ConfigureResource(resource => resource
        .AddService(serviceName: "my-dotnet-app", serviceVersion: "1.0.0")
        .AddAttributes(new Dictionary<string, object>
        {
            ["deployment.environment"] = builder.Environment.EnvironmentName,
        }))
    .WithTracing(tracing => tracing
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter(opts =>
        {
            opts.Endpoint = new Uri($"{MapleEndpoint}/v1/traces");
            opts.Protocol = OpenTelemetry.Exporter.OtlpExportProtocol.HttpProtobuf;
            opts.Headers = MapleAuth;
        }));

builder.Logging.AddOpenTelemetry(logging =>
{
    logging.IncludeFormattedMessage = true;
    logging.IncludeScopes = true;
    logging.AddOtlpExporter(opts =>
    {
        opts.Endpoint = new Uri($"{MapleEndpoint}/v1/logs");
        opts.Protocol = OpenTelemetry.Exporter.OtlpExportProtocol.HttpProtobuf;
        opts.Headers = MapleAuth;
    });
});

var app = builder.Build();
app.MapGet("/", () => "Hello!");
app.Run();
```

For a console app or worker without ASP.NET, build the provider directly:

```csharp
using var tracerProvider = Sdk.CreateTracerProviderBuilder()
    .ConfigureResource(r => r.AddService("my-dotnet-worker"))
    .AddSource("my-dotnet-worker")
    .AddHttpClientInstrumentation()
    .AddOtlpExporter(opts =>
    {
        opts.Endpoint = new Uri("https://ingest.maple.dev/v1/traces");
        opts.Protocol = OpenTelemetry.Exporter.OtlpExportProtocol.HttpProtobuf;
        opts.Headers = "Authorization=Bearer YOUR_API_KEY";
    })
    .Build();
```

## Instrumentation Libraries

Add NuGet packages for libraries you use:

| Library                  | Package                                          |
| ------------------------ | ------------------------------------------------ |
| ASP.NET Core             | `OpenTelemetry.Instrumentation.AspNetCore`       |
| HttpClient               | `OpenTelemetry.Instrumentation.Http`             |
| Entity Framework Core    | `OpenTelemetry.Instrumentation.EntityFrameworkCore` |
| SqlClient                | `OpenTelemetry.Instrumentation.SqlClient`        |
| StackExchange.Redis      | `OpenTelemetry.Instrumentation.StackExchangeRedis` |
| gRPC client              | `OpenTelemetry.Instrumentation.GrpcNetClient`    |

Each registers via `.AddXxxInstrumentation()` on the `WithTracing` builder.

## Custom Spans

In .NET, OpenTelemetry spans are built on top of `System.Diagnostics.Activity`. Create an `ActivitySource` and start activities:

```csharp
using System.Diagnostics;

public class OrderService
{
    private static readonly ActivitySource ActivitySource = new("MyApp.Orders");

    public async Task ProcessOrder(string orderId)
    {
        using var activity = ActivitySource.StartActivity("process-order");
        activity?.SetTag("order.id", orderId);
        // Set peer.service when calling another service
        activity?.SetTag("peer.service", "payment-api");

        try
        {
            await ChargePayment(orderId);
        }
        catch (Exception ex)
        {
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            activity?.AddException(ex);
            throw;
        }
    }
}
```

Setting `peer.service` on outgoing calls makes them visible on Maple's [service map](/docs/concepts/otel-conventions#service-map).

Register the source name with the tracer provider so its activities are exported:

```csharp
.WithTracing(tracing => tracing
    .AddSource("MyApp.Orders")
    // ...
)
```

## Log Correlation

When you wire `Logging.AddOpenTelemetry()` as shown above, the standard `ILogger<T>` API automatically attaches trace and span IDs to log records emitted within an active activity:

```csharp
public class OrderService(ILogger<OrderService> logger)
{
    public async Task ProcessOrder(string orderId)
    {
        logger.LogInformation("Processing order {OrderId}", orderId);
        // trace_id and span_id are populated automatically
    }
}
```

## Environment Variables

Standard OpenTelemetry environment variables are honored by the SDK and override the values you set in code:

```bash
export OTEL_SERVICE_NAME="my-dotnet-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_API_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production"
```

## Verify

1. Run your application (`dotnet run`)
2. Generate some traffic (send a request, trigger an operation)
3. Open the Maple dashboard and check that traces appear in the traces view

If traces aren't appearing, verify:

- The endpoint includes `/v1/traces` (or `/v1/logs` for the log exporter) when set in code -- the env-var form expects just the host
- `OtlpExportProtocol.HttpProtobuf` is set; the default is gRPC and Maple's ingest is HTTP
- Your API key is valid and the application can reach `ingest.maple.dev`
