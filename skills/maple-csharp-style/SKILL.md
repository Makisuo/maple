---
name: maple-csharp-style
description: ".NET / C# OpenTelemetry style for Maple: OpenTelemetry.Extensions.Hosting + OTLP HTTP exporter, ActivitySource for spans, ILogger bridging via OpenTelemetryLoggerProvider, inline endpoint + ingest key."
---

# Maple .NET / C# style

Use the official `OpenTelemetry` packages and wire them through the .NET hosting model — `IServiceCollection` for traces / metrics, `ILoggingBuilder` for logs.

## Install

```bash
dotnet add package OpenTelemetry.Extensions.Hosting
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol
dotnet add package OpenTelemetry.Instrumentation.AspNetCore
dotnet add package OpenTelemetry.Instrumentation.Http
```

## Bootstrap (ASP.NET Core)

Inline the endpoint and ingest key — they're a project-scoped, write-only token (Sentry-DSN-shaped). No env-var indirection.

```csharp
using OpenTelemetry;
using OpenTelemetry.Exporter;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

const string MapleEndpoint = "https://ingest.maple.dev";
const string MapleKey = "MAPLE_TEST"; // set by maple-onboard skill on pairing

var builder = WebApplication.CreateBuilder(args);

void ConfigureOtlp(OtlpExporterOptions options, string path)
{
    options.Endpoint = new Uri($"{MapleEndpoint}/v1/{path}");
    options.Protocol = OtlpExportProtocol.HttpProtobuf;
    options.Headers = $"authorization=Bearer {MapleKey}";
}

var resource = ResourceBuilder.CreateDefault()
    .AddService("orders-api")
    .AddAttributes(new Dictionary<string, object>
    {
        ["deployment.environment.name"] = builder.Environment.EnvironmentName,
        ["vcs.repository.url.full"] = "https://github.com/acme/orders-api",
        ["vcs.ref.head.revision"] = Environment.GetEnvironmentVariable("GITHUB_SHA") ?? "",
    });

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("orders-api"))
    .WithTracing(tracing => tracing
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter(o => ConfigureOtlp(o, "traces")))
    .WithMetrics(metrics => metrics
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter(o => ConfigureOtlp(o, "metrics")));

builder.Logging.AddOpenTelemetry(logging =>
{
    logging.SetResourceBuilder(resource);
    logging.IncludeFormattedMessage = true;
    logging.IncludeScopes = true;
    logging.AddOtlpExporter(o => ConfigureOtlp(o, "logs"));
});

var app = builder.Build();
```

## Bounded business spans

Use a static `ActivitySource` per module. ASP.NET / HttpClient auto-instrumentation handles the obvious spans; reach for `ActivitySource.StartActivity` for business operations.

```csharp
public static class Tracing
{
    public static readonly ActivitySource Source = new("orders.api");
}

public sealed class OrderService
{
    public async Task SubmitAsync(string orderId, string tenantId)
    {
        using var activity = Tracing.Source.StartActivity("order.submit");
        activity?.SetTag("tenant.id", tenantId);
        activity?.SetTag("order.id", orderId);
        try
        {
            await ChargeAsync(orderId);
        }
        catch (Exception ex)
        {
            activity?.RecordException(ex);
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            throw;
        }
    }
}
```

`Activity.RecordException(Exception)` lives in `OpenTelemetry.Trace` — `using OpenTelemetry.Trace;` for the extension.

## Logs

`ILogger<T>` calls already carry the active `Activity`'s `TraceId` / `SpanId` once `AddOpenTelemetry` is wired into `builder.Logging`. Don't replace the user's existing logger; add OTLP underneath.

## Coexistence

If the project already exports to Application Insights, Datadog, or Honeycomb, keep those. `AddOpenTelemetry().WithTracing(...)` accepts multiple exporters — chain `.AddOtlpExporter(...)` for Maple alongside the existing one.
