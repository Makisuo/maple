## v0.11.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **test**: Add skipIf to bun testing harness &nbsp;-&nbsp; by **Michael (Pear)** [<samp>(6021c)</samp>](https://github.com/alchemy-run/alchemy/commit/6021c3d)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Http**: Lazy-import platform-node to avoid crash on Bun &nbsp;-&nbsp; by **Christopher Yovanovitch** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/48 [<samp>(85224)</samp>](https://github.com/alchemy-run/alchemy/commit/852243b)
- **cloudflare**: Bindings resolve Effect<Resource> and remove KV per-operation bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(61e02)</samp>](https://github.com/alchemy-run/alchemy/commit/61e0244)
- **core**: Migrate to Provider.effect so that providers are tree-shakable &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/53 [<samp>(73029)</samp>](https://github.com/alchemy-run/alchemy/commit/7302911)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.10.0...v0.11.0)

---

## v0.10.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - Accept Output<T> in Worker env + Vite props &nbsp;-&nbsp; by **cooper** in https://github.com/alchemy-run/alchemy/issues/51 [<samp>(9560b)</samp>](https://github.com/alchemy-run/alchemy/commit/9560bed)
  - Allow bindings to be undefined &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(15c8c)</samp>](https://github.com/alchemy-run/alchemy/commit/15c8c6e)
  - Rename DynamicWorker to DynamicWorkerLoader &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(39f89)</samp>](https://github.com/alchemy-run/alchemy/commit/39f89d5)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.9.1...v0.10.0)

---

## v0.9.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Environment variables silently dropped &nbsp;-&nbsp; by **cooper** in https://github.com/alchemy-run/alchemy/issues/49 [<samp>(847f0)</samp>](https://github.com/alchemy-run/alchemy/commit/847f0c2)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.9.0...v0.9.1)

---

## v0.9.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **core**: Bun test helpers &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(40af3)</samp>](https://github.com/alchemy-run/alchemy/commit/40af3f4)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - Delay WorkerEnvironment resolution for R2Bucket binding until inside Worker &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b41b1)</samp>](https://github.com/alchemy-run/alchemy/commit/b41b1c3)
  - Precreate Worker with tags and resolve DO namespace IDs as Worker output attributes &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c6b2a)</samp>](https://github.com/alchemy-run/alchemy/commit/c6b2add)
  - Retry eventually consistent ContainerApplicationNotFound error &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(90d75)</samp>](https://github.com/alchemy-run/alchemy/commit/90d7524)
  - Resolve Durable Object namespace IDs in precreate &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(cd1e2)</samp>](https://github.com/alchemy-run/alchemy/commit/cd1e25d)
  - Use Sonda to generate bundle report &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a7a9c)</samp>](https://github.com/alchemy-run/alchemy/commit/a7a9c5f)
  - Recover from partial ContainerApplication failure &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(04890)</samp>](https://github.com/alchemy-run/alchemy/commit/04890d3)
- **core**:
  - Use a Deferred to support parallel caching &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ca693)</samp>](https://github.com/alchemy-run/alchemy/commit/ca693b5)
  - Exclude Artifacts from provider requirements &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a0aec)</samp>](https://github.com/alchemy-run/alchemy/commit/a0aec34)
  - Resolve Effects in Binding.Sevice.bind &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b82f2)</samp>](https://github.com/alchemy-run/alchemy/commit/b82f262)
- **test**:
  - Return output of deploying stack in a test &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6d354)</samp>](https://github.com/alchemy-run/alchemy/commit/6d354a1)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.8.0...v0.9.0)

---

## v0.8.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Async-alchemy style bindings and R2 wrapper &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4c4ca)</samp>](https://github.com/alchemy-run/alchemy/commit/4c4ca91)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.7.1...v0.8.0)

---

## v0.7.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- **core**: Support deploy --force &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/43 [<samp>(06b88)</samp>](https://github.com/alchemy-run/alchemy/commit/06b881a)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.7.0...v0.7.1)

---

## v0.7.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - Vite integration &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/41 [<samp>(e3c16)</samp>](https://github.com/alchemy-run/alchemy/commit/e3c160c)
- **core**:
  - Add Output.as<T>() &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(33186)</samp>](https://github.com/alchemy-run/alchemy/commit/33186ef)
  - Artifact service for caching build artifacts across plan and apply &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(dc60e)</samp>](https://github.com/alchemy-run/alchemy/commit/dc60e9e)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.6.4...v0.7.0)

---

## v0.6.4

_No significant changes_

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.6.3...v0.6.4)

---

## v0.6.3

### &nbsp;&nbsp;&nbsp;🚀 Features

- **better-auth**:
  - Add @alchemy.run/better-auth packag with D1 support &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9dc0f)</samp>](https://github.com/alchemy-run/alchemy/commit/9dc0ff6)
- **cloudflare**:
  - D1Database resource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(48fd4)</samp>](https://github.com/alchemy-run/alchemy/commit/48fd499)
  - Expose raw Cloudflare.Request as a Tag &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(67998)</samp>](https://github.com/alchemy-run/alchemy/commit/67998cd)
- **core**:
  - Random resource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(71527)</samp>](https://github.com/alchemy-run/alchemy/commit/715278e)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Replace Schedule.compose with Schedule.both &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(46195)</samp>](https://github.com/alchemy-run/alchemy/commit/461951d)
- **cli**:
  - Simplify logs query to latest hour &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b4a47)</samp>](https://github.com/alchemy-run/alchemy/commit/b4a4733)
  - Used TaggedError in Daemon &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(77a78)</samp>](https://github.com/alchemy-run/alchemy/commit/77a788a)
- **cloudflare**:
  - Export D1 resources and bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d9e94)</samp>](https://github.com/alchemy-run/alchemy/commit/d9e9447)
  - Export D1 resources and bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(bcd43)</samp>](https://github.com/alchemy-run/alchemy/commit/bcd436d)
- **core**:
  - Support updating downstream to unlink and delete a binding &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6bdf8)</samp>](https://github.com/alchemy-run/alchemy/commit/6bdf8e9)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.6.2...v0.6.3)

---

## v0.6.2

_No significant changes_

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.6.1...v0.6.2)

---

## v0.6.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- Move to distilled-aws &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e12f2)</samp>](https://github.com/alchemy-run/alchemy/commit/e12f2a6)
- Add S3 data plane APIs &nbsp;-&nbsp; by **Sam Goodwin** and **Claude Haiku 4.5** in https://github.com/alchemy-run/alchemy/issues/34 [<samp>(f2986)</samp>](https://github.com/alchemy-run/alchemy/commit/f2986ab)
- Bootstrap CLI command &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3a79a)</samp>](https://github.com/alchemy-run/alchemy/commit/3a79a04)
- Lambda.consumeTable &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(420c1)</samp>](https://github.com/alchemy-run/alchemy/commit/420c124)
- Remove ExecutionContext from Policy requirements &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(867ef)</samp>](https://github.com/alchemy-run/alchemy/commit/867ef28)
- Implement HttpServer for Lambda and Cloudflare &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(655df)</samp>](https://github.com/alchemy-run/alchemy/commit/655dfd1)
- Namespaces &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(46050)</samp>](https://github.com/alchemy-run/alchemy/commit/4605092)
- Implement Host, Self and make Lambda entrypoint &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1d9a2)</samp>](https://github.com/alchemy-run/alchemy/commit/1d9a218)
- Generalize bundler and end to end deployment working &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(65353)</samp>](https://github.com/alchemy-run/alchemy/commit/65353fc)
- Namespace tree for organizing Resources and Bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3b937)</samp>](https://github.com/alchemy-run/alchemy/commit/3b93785)
- Default AWS StageConfig &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(45152)</samp>](https://github.com/alchemy-run/alchemy/commit/4515245)
- Bind Outputs to environment variables &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9ff75)</samp>](https://github.com/alchemy-run/alchemy/commit/9ff7587)
- End-to-end bundling, bindings and IAM policies &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d2fef)</samp>](https://github.com/alchemy-run/alchemy/commit/d2fef7a)
- Migrate to @distilled.cloud (v2) &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(75151)</samp>](https://github.com/alchemy-run/alchemy/commit/75151e7)
- Support external platforms &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(7ed9f)</samp>](https://github.com/alchemy-run/alchemy/commit/7ed9ffb)
- **aws**:
  - DynamoDB Bindings and an AI process for implementing an aws service &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(cdfd4)</samp>](https://github.com/alchemy-run/alchemy/commit/cdfd45b)
  - DynamoDB Table Stream &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ec61a)</samp>](https://github.com/alchemy-run/alchemy/commit/ec61a6d)
  - SNS Topic, Subscription, TopicSink and EventSource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4d3af)</samp>](https://github.com/alchemy-run/alchemy/commit/4d3af74)
  - Cloudwatch Resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(30544)</samp>](https://github.com/alchemy-run/alchemy/commit/3054413)
  - Add logs and tail for Lambda Functions &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8403c)</samp>](https://github.com/alchemy-run/alchemy/commit/8403cda)
- **aws, dynamodb**:
  - Add Batch and Transact Operations &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(73a01)</samp>](https://github.com/alchemy-run/alchemy/commit/73a0134)
- **aws, eventbridge**:
  - EventBrdige Resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4809c)</samp>](https://github.com/alchemy-run/alchemy/commit/4809c8e)
- **aws,acm**:
  - Certificate &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c082f)</samp>](https://github.com/alchemy-run/alchemy/commit/c082f83)
- **aws,autoscaling**:
  - AutoScalingGroup, LaunchTemplate, ScalingPolicy &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d7878)</samp>](https://github.com/alchemy-run/alchemy/commit/d787847)
- **aws,cloudfront**:
  - Distribution, Function, Invalidation, KeyValueStore, OriginAccessControl &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2d2e5)</samp>](https://github.com/alchemy-run/alchemy/commit/2d2e528)
- **aws,ec2**:
  - EC2 Network and Instance &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8e686)</samp>](https://github.com/alchemy-run/alchemy/commit/8e686d7)
  - Share Hsot logic across EC2 Instance and LaunchTemplate &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(691e2)</samp>](https://github.com/alchemy-run/alchemy/commit/691e20b)
- **aws,ecr**:
  - Repository Resource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(0af1e)</samp>](https://github.com/alchemy-run/alchemy/commit/0af1ec1)
- **aws,ecs**:
  - ECS Cluster, Task and Service Resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(11c74)</samp>](https://github.com/alchemy-run/alchemy/commit/11c7438)
- **aws,eks**:
  - AWS Auto EKS Cluster resoruces &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9b4f9)</samp>](https://github.com/alchemy-run/alchemy/commit/9b4f96f)
- **aws,elbv2**:
  - Listener, LoadBalancer, TargetGroup &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8486e)</samp>](https://github.com/alchemy-run/alchemy/commit/8486e65)
  - Support TCP protocol in Listener, LoadBalancer &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b5128)</samp>](https://github.com/alchemy-run/alchemy/commit/b5128d7)
- **aws,http**:
  - Handle unrecoverable Http errors, fix GetObject IAM policy &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(39e5c)</samp>](https://github.com/alchemy-run/alchemy/commit/39e5c6c)
- **aws,iam**:
  - AWS IAM Resources, Operations and Tests &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8638a)</samp>](https://github.com/alchemy-run/alchemy/commit/8638abe)
- **aws,iamidentitycenter**:
  - AccountAssignment, Group, Instance, PermissionSet &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3f864)</samp>](https://github.com/alchemy-run/alchemy/commit/3f86467)
- **aws,kinesiss**:
  - Operations for Kinesis Streams, including EventSource and Sinks &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8b40c)</samp>](https://github.com/alchemy-run/alchemy/commit/8b40c72)
- **aws,lambda**:
  - EventBridge and Stream Event Sources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(311a0)</samp>](https://github.com/alchemy-run/alchemy/commit/311a04b)
- **aws,logs**:
  - LogGroup Resource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ff7e2)</samp>](https://github.com/alchemy-run/alchemy/commit/ff7e2de)
- **aws,organizations**:
  - Account, DelegatedAdministrator, Organization, OrganizationalUnit, OrganizationResourcePolicy, Policy, PolicyAttachment, Root, RootPolicyType, TrustedServiceAccess &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ed86a)</samp>](https://github.com/alchemy-run/alchemy/commit/ed86a76)
  - TenantRoot &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b6f7b)</samp>](https://github.com/alchemy-run/alchemy/commit/b6f7b21)
- **aws,pipes**:
  - Pipe resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(38af3)</samp>](https://github.com/alchemy-run/alchemy/commit/38af3e0)
- **aws,rds**:
  - DB\* Resources, Aurora, Connect and RDSData &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9742b)</samp>](https://github.com/alchemy-run/alchemy/commit/9742b8c)
- **aws,route53**:
  - Record &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(71d88)</samp>](https://github.com/alchemy-run/alchemy/commit/71d88cd)
- **aws,scheduler**:
  - Schedule, ScheduleGroup resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3be73)</samp>](https://github.com/alchemy-run/alchemy/commit/3be73bd)
- **aws,secretsmanager**:
  - Secret Resource and Bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a8a39)</samp>](https://github.com/alchemy-run/alchemy/commit/a8a39bd)
- **aws,sqs**:
  - Allow DeleteMessageBatch, ReceiveMessage and SendMessage on EC2 &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(bddb4)</samp>](https://github.com/alchemy-run/alchemy/commit/bddb4bb)
- **aws,website**:
  - SsrSite, StaticSite, Router &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d4f14)</samp>](https://github.com/alchemy-run/alchemy/commit/d4f14c3)
  - Bring StaticSite up to par with SST &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6aaac)</samp>](https://github.com/alchemy-run/alchemy/commit/6aaace9)
- **build**:
  - Docker commands &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d12cf)</samp>](https://github.com/alchemy-run/alchemy/commit/d12cf9f)
- **cli**:
  - Tail and logs &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b0a06)</samp>](https://github.com/alchemy-run/alchemy/commit/b0a061e)
  - Filter logs and tail by resource ID &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a6514)</samp>](https://github.com/alchemy-run/alchemy/commit/a6514c7)
  - Process Manager daemon &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c0fd1)</samp>](https://github.com/alchemy-run/alchemy/commit/c0fd148)
- **cloudflare**:
  - Durable Objects and Worker entrypoint/exports &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(aa6d3)</samp>](https://github.com/alchemy-run/alchemy/commit/aa6d3a0)
  - Durable Objects and Containers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/37 [<samp>(ccade)</samp>](https://github.com/alchemy-run/alchemy/commit/ccade21)
  - DynamicWorker &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8c5d2)</samp>](https://github.com/alchemy-run/alchemy/commit/8c5d205)
  - Workflows &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(874cc)</samp>](https://github.com/alchemy-run/alchemy/commit/874cc9a)
- **core**:
  - Handle circular binding cycles &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6d843)</samp>](https://github.com/alchemy-run/alchemy/commit/6d843c4)
  - Construct.fn and two-phase apply &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(7c8bd)</samp>](https://github.com/alchemy-run/alchemy/commit/7c8bd2b)
  - Enhance convrergence of circularity in alchemy &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(fbfbf)</samp>](https://github.com/alchemy-run/alchemy/commit/fbfbf2a)
  - Allow replace on top of a partially replaced resurce &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3c630)</samp>](https://github.com/alchemy-run/alchemy/commit/3c63096)
- **k8s**:
  - Kubernetes Manifest, Service, ServiceAccount, etc. &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8d2d1)</samp>](https://github.com/alchemy-run/alchemy/commit/8d2d133)
- **kinesis**:
  - Add AWS Kinesis Stream resource and capabilities &nbsp;-&nbsp; by **Sam Goodwin** and **Claude Haiku 4.5** in https://github.com/alchemy-run/alchemy/issues/30 [<samp>(3f30b)</samp>](https://github.com/alchemy-run/alchemy/commit/3f30b79)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Improve deletion of ec2 resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c5bf6)</samp>](https://github.com/alchemy-run/alchemy/commit/c5bf62f)
- Stack.make to capture providers and re-implement binding diffs in Plan &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(94e40)</samp>](https://github.com/alchemy-run/alchemy/commit/94e401c)
- Use error.\_tag instead of error.name &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(87cbf)</samp>](https://github.com/alchemy-run/alchemy/commit/87cbfa3)
- Handle undefined props &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(63f08)</samp>](https://github.com/alchemy-run/alchemy/commit/63f0869)
- Write bundle temp files to .alchemy/tmp &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(0b491)</samp>](https://github.com/alchemy-run/alchemy/commit/0b49156)
- Write temporary bundle file inside .alchemy within the correct module &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6d678)</samp>](https://github.com/alchemy-run/alchemy/commit/6d678c8)
- Resource Service inherits call-site Context &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(07511)</samp>](https://github.com/alchemy-run/alchemy/commit/0751195)
- **aws**:
  - Provide stack, stage and phase at runtime &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(befb4)</samp>](https://github.com/alchemy-run/alchemy/commit/befb4ff)
  - Add missing Provider and Binding layers &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f41c1)</samp>](https://github.com/alchemy-run/alchemy/commit/f41c13b)
  - Add missing Providers &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(82f51)</samp>](https://github.com/alchemy-run/alchemy/commit/82f51ef)
  - Bootstrap command creates and tags the bucket &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(5a36f)</samp>](https://github.com/alchemy-run/alchemy/commit/5a36fab)
  - EC2 and LaunchTemplate host now provide ExecutionContext.Server &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e2f01)</samp>](https://github.com/alchemy-run/alchemy/commit/e2f0100)
  - Avoid redundant updates when source map changes &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(48fe5)</samp>](https://github.com/alchemy-run/alchemy/commit/48fe5cd)
- **aws,cloudflare**:
  - Fix AnomalyDetector and bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2d47e)</samp>](https://github.com/alchemy-run/alchemy/commit/2d47e71)
- **aws,sns**:
  - ReadSubscription returns undefined if topicArn is unknown &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4e25c)</samp>](https://github.com/alchemy-run/alchemy/commit/4e25c3d)
- **aws,website**:
  - Include stack, stage and FQN in kv namespace &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e971c)</samp>](https://github.com/alchemy-run/alchemy/commit/e971ca7)
  - End-to-end deployment of StaticSite &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1dea3)</samp>](https://github.com/alchemy-run/alchemy/commit/1dea3ec)
- **cli**:
  - Support running in node and load .env with ConfigProvider &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9b15b)</samp>](https://github.com/alchemy-run/alchemy/commit/9b15b39)
  - Support node and bun for globs &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2bcb6)</samp>](https://github.com/alchemy-run/alchemy/commit/2bcb6d0)
  - Respect caller's node runtime &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6396c)</samp>](https://github.com/alchemy-run/alchemy/commit/6396cd6)
- **cloudflare**:
  - Migrate to distilled-cloudflare and rolldown &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a4184)</samp>](https://github.com/alchemy-run/alchemy/commit/a4184ec)
  - Distilled 0.4.0 pagination apis &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4bffe)</samp>](https://github.com/alchemy-run/alchemy/commit/4bffe41)
  - Hard-code all exported handler methods instead of Proxy &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(289b9)</samp>](https://github.com/alchemy-run/alchemy/commit/289b92f)
  - Detect changes to Container and Bundle &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(924ff)</samp>](https://github.com/alchemy-run/alchemy/commit/924ffb5)
  - Pass assetsConfig in TanstackStart and StaticSite &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(42832)</samp>](https://github.com/alchemy-run/alchemy/commit/428329f)
  - Get HTTP server plumbing working for containers &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(cf058)</samp>](https://github.com/alchemy-run/alchemy/commit/cf05888)
- **cloudflare,assets**:
  - Pass jwtToken to createAssetUpload &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(26228)</samp>](https://github.com/alchemy-run/alchemy/commit/262289d)
- **core**:
  - Accept Input<T> in Host props &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(09edc)</samp>](https://github.com/alchemy-run/alchemy/commit/09edccf)
  - Add asEffect to Output &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(5ec8d)</samp>](https://github.com/alchemy-run/alchemy/commit/5ec8d27)
- **ec2**:
  - Query attachments when deleting IGW &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ced7f)</samp>](https://github.com/alchemy-run/alchemy/commit/ced7f85)
- **process**:
  - Export Process module &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1600d)</samp>](https://github.com/alchemy-run/alchemy/commit/1600d3c)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.6.0...v0.6.1)

---

## v0.6.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **ec2**: NAT Gateway, EIP, Egress IGW, SecurityGroups &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/24 [<samp>(ff04d)</samp>](https://github.com/alchemy-run/alchemy/commit/ff04d57)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.5.0...v0.6.0)

---

## v0.5.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Standardize physical name generation &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(91199)</samp>](https://github.com/alchemy-run/alchemy/commit/9119967)
- **cloudflare**:
  - Rename worker.id and name workerId and workerName &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(273cb)</samp>](https://github.com/alchemy-run/alchemy/commit/273cb26)
  - Rename Bucket.name to Bucket.bucketName and constraint name length &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a0733)</samp>](https://github.com/alchemy-run/alchemy/commit/a0733a6)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.4.0...v0.5.0)

---

## v0.4.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **ec2**: Add IGW, Route, Route Table, Route Table Assoication &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/23 [<samp>(0eeb6)</samp>](https://github.com/alchemy-run/alchemy/commit/0eeb613)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.3.0...v0.4.0)

---

## v0.3.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **core**:
  - Inputs and Outputs &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/19 [<samp>(fa8b8)</samp>](https://github.com/alchemy-run/alchemy/commit/fa8b893)
  - DefineStack, defineStages and alchemy-effect CLI &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/21 [<samp>(d30da)</samp>](https://github.com/alchemy-run/alchemy/commit/d30da72)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Make props optional in KV Namespace and R2 Bucket &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(dbfbe)</samp>](https://github.com/alchemy-run/alchemy/commit/dbfbe40)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.2.0...v0.3.0)

---

## v0.2.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Diff bindings + Queue Event Source &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/12 [<samp>(f0ba8)</samp>](https://github.com/alchemy-run/alchemy/commit/f0ba897)
- **aws**:
  - DynamoDB Table and getItem &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/10 [<samp>(877ba)</samp>](https://github.com/alchemy-run/alchemy/commit/877ba8f)
  - VPC &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/16 [<samp>(cda86)</samp>](https://github.com/alchemy-run/alchemy/commit/cda86ce)
- **cloudflare**:
  - Worker, Assets, R2, KV &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/13 [<samp>(6e5b1)</samp>](https://github.com/alchemy-run/alchemy/commit/6e5b107)
- **test**:
  - Add test utility &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/15 [<samp>(7a9e1)</samp>](https://github.com/alchemy-run/alchemy/commit/7a9e10f)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Properly type the Resource Provider Layers and use Layer.merge &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(77d69)</samp>](https://github.com/alchemy-run/alchemy/commit/77d69be)
- **core**: Exclude bindings from props diff and include attributes in no-op bind &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/17 [<samp>(6408d)</samp>](https://github.com/alchemy-run/alchemy/commit/6408d2b)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.1.0...v0.2.0)

---

## v0.1.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Adopt currying pattern across codebase to deal with NoInfer and Extract limitations &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9a319)</samp>](https://github.com/alchemy-run/alchemy/commit/9a3193c)
- Remove HKTs from capability and resource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(88a59)</samp>](https://github.com/alchemy-run/alchemy/commit/88a594a)
- Use triples in Policy to support overriden tags for bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9e8fc)</samp>](https://github.com/alchemy-run/alchemy/commit/9e8fc77)
- Introduce BindingTag to map Binding -> BindingService &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c59b7)</samp>](https://github.com/alchemy-run/alchemy/commit/c59b76c)
- Capture Capability ID in Binding declaration &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(742c2)</samp>](https://github.com/alchemy-run/alchemy/commit/742c205)
- Standardize .provider builder pattern and add 'binding' integration contract type to Runtime &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6afdd)</samp>](https://github.com/alchemy-run/alchemy/commit/6afdd33)
- Include Phase in the Plan and properly type the output of Apply &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1eade)</samp>](https://github.com/alchemy-run/alchemy/commit/1eade78)
- Add provider: { effect, succeed } to Resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c4233)</samp>](https://github.com/alchemy-run/alchemy/commit/c42336f)
- Thread BindNode through state and fix the planner &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c1bb3)</samp>](https://github.com/alchemy-run/alchemy/commit/c1bb313)
- Apply bindings in the generic apply functions instead of each provider &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f0f34)</samp>](https://github.com/alchemy-run/alchemy/commit/f0f348a)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Bind types &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d11c7)</samp>](https://github.com/alchemy-run/alchemy/commit/d11c774)
- Update Instance<T> to handle the resource types like Queue &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6adca)</samp>](https://github.com/alchemy-run/alchemy/commit/6adca3c)
- Re-work simpler types for plan and apply &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1d08d)</samp>](https://github.com/alchemy-run/alchemy/commit/1d08d19)
- Instance<Queue> maps to Queue instead of Resource<..> &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(aa18f)</samp>](https://github.com/alchemy-run/alchemy/commit/aa18f3a)
- Pass-through of the Props and Bindings to the Service type &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9784e)</samp>](https://github.com/alchemy-run/alchemy/commit/9784eca)
- Remove Resource from Binding tag construction and implement layer builders &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ada7c)</samp>](https://github.com/alchemy-run/alchemy/commit/ada7cba)
- Plumb through new Plan structure to apply and CLI &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8c057)</samp>](https://github.com/alchemy-run/alchemy/commit/8c0570b)
- Missing props in Capability, Bindingm, Resource and Service &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(aaec3)</samp>](https://github.com/alchemy-run/alchemy/commit/aaec377)
- Include bindings in the plan, fix papercuts, remove node:util usage &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(0a5f4)</samp>](https://github.com/alchemy-run/alchemy/commit/0a5f4d3)
- Log message when SSO token has expired &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8a7a7)</samp>](https://github.com/alchemy-run/alchemy/commit/8a7a72f)
- Infer return type of Resource.provider.effect &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2093f)</samp>](https://github.com/alchemy-run/alchemy/commit/2093f17)
- Serialize classes properly and rename packages &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2bf72)</samp>](https://github.com/alchemy-run/alchemy/commit/2bf7290)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/c46b447ca0d46a9e4dbf08a6789770a420d90be5...v0.1.0)

---
