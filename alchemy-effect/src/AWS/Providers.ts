import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import { CommandProvider } from "../Build/Command.ts";
import type { Provider } from "../Provider.ts";
import { RandomProvider } from "../Random.ts";
import * as Account from "./Account.ts";
import * as ACM from "./ACM/index.ts";
import * as Assets from "./Assets.ts";
import * as AutoScaling from "./AutoScaling/index.ts";
import * as CloudFront from "./CloudFront/index.ts";
import * as CloudWatch from "./CloudWatch/index.ts";
import * as Credentials from "./Credentials.ts";
import * as DynamoDB from "./DynamoDB/index.ts";
import * as EC2 from "./EC2/index.ts";
import * as ECR from "./ECR/index.ts";
import * as ECS from "./ECS/index.ts";
import * as EKS from "./EKS/index.ts";
import * as ELBv2 from "./ELBv2/index.ts";
import * as Endpoint from "./Endpoint.ts";
import * as EventBridge from "./EventBridge/index.ts";
import * as IAM from "./IAM/index.ts";
import * as IdentityCenter from "./IdentityCenter/index.ts";
import * as Kinesis from "./Kinesis/index.ts";
import * as Lambda from "./Lambda/index.ts";
import * as Logs from "./Logs/index.ts";
import * as Organizations from "./Organizations/index.ts";
import * as RDS from "./RDS/index.ts";
import * as RDSData from "./RDSData/index.ts";
import * as Region from "./Region.ts";
import * as Route53 from "./Route53/index.ts";
import * as S3 from "./S3/index.ts";
import * as Scheduler from "./Scheduler/index.ts";
import * as SecretsManager from "./SecretsManager/index.ts";
import * as SNS from "./SNS/index.ts";
import * as SQS from "./SQS/index.ts";
import { loadDefaultStageConfig, StageConfig } from "./StageConfig.ts";
import * as Website from "./Website/index.ts";

export type Providers = Extract<
  Layer.Success<ReturnType<typeof providers>>,
  Provider<any>
>;

/**
 * AWS providers with optional Assets layer for S3-based code deployment.
 * If the assets bucket exists (created via `alchemy-effect bootstrap`),
 * Lambda functions will use S3 for code deployment instead of inline ZipFile.
 */
export const providers = () =>
  pipe(
    resources(),
    Layer.provideMerge(bindings()),
    Layer.provideMerge(Assets.AssetsProvider()),
    Layer.provideMerge(Account.fromStageConfig()),
    Layer.provideMerge(Region.fromStageConfig()),
    Layer.provideMerge(Credentials.fromStageConfig()),
    Layer.provideMerge(Endpoint.fromStageConfig()),
    Layer.provideMerge(stageConfig()),
    Layer.orDie,
  );

export const stageConfig = () =>
  Layer.effect(StageConfig, Effect.suspend(loadDefaultStageConfig));

/**
 * Minimal AWS credential and account context without registering any resource
 * providers.
 */
export const credentials = () =>
  pipe(
    Account.fromStageConfig(),
    Layer.provideMerge(Region.fromStageConfig()),
    Layer.provideMerge(Credentials.fromStageConfig()),
    Layer.provideMerge(Endpoint.fromStageConfig()),
    Layer.provideMerge(stageConfig()),
  );

/**
 * All AWS resource providers.
 *
 * This layer registers the lifecycle providers that can create, read, update,
 * and delete AWS resources during plan and deploy.
 */
export const resources = () =>
  Layer.mergeAll(
    CommandProvider(),
    RandomProvider(),
    ACM.CertificateProvider(),
    AutoScaling.AutoScalingGroupProvider(),
    AutoScaling.LaunchTemplateProvider(),
    AutoScaling.ScalingPolicyProvider(),
    CloudFront.DistributionProvider(),
    CloudFront.FunctionProvider(),
    CloudFront.InvalidationProvider(),
    CloudFront.KeyValueStoreProvider(),
    CloudFront.KvEntriesProvider(),
    CloudFront.KvRoutesUpdateProvider(),
    CloudFront.OriginAccessControlProvider(),
    CloudWatch.AlarmMuteRuleProvider(),
    CloudWatch.AlarmProvider(),
    CloudWatch.AnomalyDetectorProvider(),
    CloudWatch.CompositeAlarmProvider(),
    CloudWatch.DashboardProvider(),
    CloudWatch.InsightRuleProvider(),
    CloudWatch.MetricStreamProvider(),
    DynamoDB.TableProvider(),
    EC2.EgressOnlyInternetGatewayProvider(),
    EC2.EIPProvider(),
    EC2.InstanceProvider(),
    EC2.InternetGatewayProvider(),
    EC2.NatGatewayProvider(),
    EC2.NetworkAclAssociationProvider(),
    EC2.NetworkAclEntryProvider(),
    EC2.NetworkAclProvider(),
    EC2.RouteProvider(),
    EC2.RouteTableAssociationProvider(),
    EC2.RouteTableProvider(),
    EC2.SecurityGroupProvider(),
    EC2.SecurityGroupRuleProvider(),
    EC2.SubnetProvider(),
    EC2.VpcEndpointProvider(),
    EC2.VpcProvider(),
    ECR.RepositoryProvider(),
    ECS.ClusterProvider(),
    ECS.ServiceProvider(),
    ECS.TaskProvider(),
    EKS.AccessEntryProvider(),
    EKS.AddonProvider(),
    EKS.ClusterProvider(),
    EKS.PodIdentityAssociationProvider(),
    ELBv2.ListenerProvider(),
    ELBv2.LoadBalancerProvider(),
    ELBv2.TargetGroupProvider(),
    EventBridge.EventBusProvider(),
    EventBridge.PermissionProvider(),
    EventBridge.RuleProvider(),
    IAM.AccessKeyProvider(),
    IAM.AccountAliasProvider(),
    IAM.AccountPasswordPolicyProvider(),
    IAM.GroupMembershipProvider(),
    IAM.GroupProvider(),
    IAM.InstanceProfileProvider(),
    IAM.LoginProfileProvider(),
    IAM.OpenIDConnectProviderProvider(),
    IAM.PolicyProvider(),
    IAM.RoleProvider(),
    IAM.SAMLProviderProvider(),
    IAM.ServerCertificateProvider(),
    IAM.ServiceSpecificCredentialProvider(),
    IAM.SigningCertificateProvider(),
    IAM.SSHPublicKeyProvider(),
    IAM.UserProvider(),
    IAM.VirtualMFADeviceProvider(),
    IdentityCenter.AccountAssignmentProvider(),
    IdentityCenter.GroupProvider(),
    IdentityCenter.InstanceProvider(),
    IdentityCenter.PermissionSetProvider(),
    Kinesis.StreamConsumerProvider(),
    Kinesis.StreamProvider(),
    Lambda.EventSourceMappingProvider(),
    Lambda.FunctionProvider(),
    Lambda.PermissionProvider(),
    Logs.LogGroupProvider(),
    Organizations.AccountProvider(),
    Organizations.DelegatedAdministratorProvider(),
    Organizations.OrganizationalUnitProvider(),
    Organizations.OrganizationProvider(),
    Organizations.OrganizationResourcePolicyProvider(),
    Organizations.PolicyAttachmentProvider(),
    Organizations.PolicyProvider(),
    Organizations.RootPolicyTypeProvider(),
    Organizations.RootProvider(),
    Organizations.TrustedServiceAccessProvider(),
    RDS.DBClusterEndpointProvider(),
    RDS.DBClusterParameterGroupProvider(),
    RDS.DBClusterProvider(),
    RDS.DBInstanceProvider(),
    RDS.DBParameterGroupProvider(),
    RDS.DBProxyEndpointProvider(),
    RDS.DBProxyProvider(),
    RDS.DBProxyTargetGroupProvider(),
    RDS.DBSubnetGroupProvider(),
    Route53.RecordProvider(),
    S3.BucketProvider(),
    Scheduler.ScheduleGroupProvider(),
    Scheduler.ScheduleProvider(),
    SecretsManager.SecretProvider(),
    SNS.SubscriptionProvider(),
    SNS.TopicProvider(),
    SQS.QueueProvider(),
    Website.AssetDeploymentProvider(),
  );

/**
 * All AWS binding policies.
 *
 * These layers attach IAM statements and event-source bindings to functions at
 * deploy time so runtime bindings like `PutObject.bind(bucket)` can execute
 * with the required permissions.
 */
export const bindings = () =>
  Layer.mergeAll(
    CloudWatch.DescribeAlarmContributorsPolicyLive,
    CloudWatch.DescribeAlarmHistoryPolicyLive,
    CloudWatch.DescribeAlarmsForMetricPolicyLive,
    CloudWatch.DescribeAlarmsPolicyLive,
    CloudWatch.DescribeAnomalyDetectorsPolicyLive,
    CloudWatch.DescribeInsightRulesPolicyLive,
    CloudWatch.DisableAlarmActionsPolicyLive,
    CloudWatch.DisableInsightRulesPolicyLive,
    CloudWatch.EnableAlarmActionsPolicyLive,
    CloudWatch.GetAlarmMuteRulePolicyLive,
    CloudWatch.GetDashboardPolicyLive,
    CloudWatch.GetInsightRuleReportPolicyLive,
    CloudWatch.GetMetricDataPolicyLive,
    CloudWatch.GetMetricStatisticsPolicyLive,
    CloudWatch.GetMetricStreamPolicyLive,
    CloudWatch.GetMetricWidgetImagePolicyLive,
    CloudWatch.ListAlarmMuteRulesPolicyLive,
    CloudWatch.ListDashboardsPolicyLive,
    CloudWatch.ListManagedInsightRulesPolicyLive,
    CloudWatch.ListMetricsPolicyLive,
    CloudWatch.ListMetricStreamsPolicyLive,
    CloudWatch.ListTagsForResourcePolicyLive,
    CloudWatch.PutMetricDataPolicyLive,
    CloudWatch.SetAlarmStatePolicyLive,
    DynamoDB.BatchExecuteStatementPolicyLive,
    DynamoDB.BatchGetItemPolicyLive,
    DynamoDB.BatchWriteItemPolicyLive,
    DynamoDB.DeleteItemPolicyLive,
    DynamoDB.DescribeTablePolicyLive,
    DynamoDB.DescribeTimeToLivePolicyLive,
    DynamoDB.ExecuteStatementPolicyLive,
    DynamoDB.ExecuteTransactionPolicyLive,
    DynamoDB.GetItemPolicyLive,
    DynamoDB.ListTablesPolicyLive,
    DynamoDB.ListTagsOfResourcePolicyLive,
    DynamoDB.PutItemPolicyLive,
    DynamoDB.QueryPolicyLive,
    DynamoDB.RestoreTableToPointInTimePolicyLive,
    DynamoDB.ScanPolicyLive,
    DynamoDB.TransactGetItemsPolicyLive,
    DynamoDB.TransactWriteItemsPolicyLive,
    DynamoDB.UpdateItemPolicyLive,
    DynamoDB.UpdateTimeToLivePolicyLive,
    ECS.DescribeTasksPolicyLive,
    ECS.ListTasksPolicyLive,
    ECS.RunTaskPolicyLive,
    ECS.StopTaskPolicyLive,
    EventBridge.DescribeEventBusPolicyLive,
    EventBridge.DescribeRulePolicyLive,
    EventBridge.ListEventBusesPolicyLive,
    EventBridge.ListRulesPolicyLive,
    EventBridge.ListTargetsByRulePolicyLive,
    EventBridge.PutEventsPolicyLive,
    EventBridge.TestEventPatternPolicyLive,
    EventBridge.ToLambdaPolicyLive,
    EventBridge.ToQueuePolicyLive,
    Kinesis.DescribeAccountSettingsPolicyLive,
    Kinesis.DescribeLimitsPolicyLive,
    Kinesis.DescribeStreamConsumerPolicyLive,
    Kinesis.DescribeStreamPolicyLive,
    Kinesis.DescribeStreamSummaryPolicyLive,
    Kinesis.GetRecordsPolicyLive,
    Kinesis.GetResourcePolicyPolicyLive,
    Kinesis.GetShardIteratorPolicyLive,
    Kinesis.ListShardsPolicyLive,
    Kinesis.ListStreamConsumersPolicyLive,
    Kinesis.ListStreamsPolicyLive,
    Kinesis.ListTagsForResourcePolicyLive,
    Kinesis.PutRecordPolicyLive,
    Kinesis.PutRecordsPolicyLive,
    Kinesis.StreamSinkPolicyLive,
    Kinesis.SubscribeToShardPolicyLive,
    Lambda.BucketEventSourcePolicyLive,
    Lambda.QueueEventSourcePolicyLive,
    Lambda.StreamEventSourcePolicyLive,
    Lambda.TableEventSourcePolicyLive,
    Lambda.TopicEventSourcePolicyLive,
    RDS.ConnectPolicyLive,
    RDSData.BatchExecuteStatementPolicyLive,
    RDSData.BeginTransactionPolicyLive,
    RDSData.CommitTransactionPolicyLive,
    RDSData.ExecuteSqlPolicyLive,
    RDSData.ExecuteStatementPolicyLive,
    RDSData.RollbackTransactionPolicyLive,
    S3.AbortMultipartUploadPolicyLive,
    S3.CompleteMultipartUploadPolicyLive,
    S3.CreateMultipartUploadPolicyLive,
    S3.DeleteObjectPolicyLive,
    S3.GetObjectPolicyLive,
    S3.HeadObjectPolicyLive,
    S3.ListObjectsV2PolicyLive,
    S3.PutObjectPolicyLive,
    S3.UploadPartPolicyLive,
    SecretsManager.DescribeSecretPolicyLive,
    SecretsManager.GetRandomPasswordPolicyLive,
    SecretsManager.GetSecretValuePolicyLive,
    SecretsManager.ListSecretsPolicyLive,
    SecretsManager.PutSecretValuePolicyLive,
    SNS.AddPermissionPolicyLive,
    SNS.ConfirmSubscriptionPolicyLive,
    SNS.GetDataProtectionPolicyPolicyLive,
    SNS.GetSubscriptionAttributesPolicyLive,
    SNS.GetTopicAttributesPolicyLive,
    SNS.ListSubscriptionsByTopicPolicyLive,
    SNS.ListSubscriptionsPolicyLive,
    SNS.ListTagsForResourcePolicyLive,
    SNS.ListTopicsPolicyLive,
    SNS.PublishBatchPolicyLive,
    SNS.PublishPolicyLive,
    SNS.PutDataProtectionPolicyPolicyLive,
    SNS.RemovePermissionPolicyLive,
    SNS.SetSubscriptionAttributesPolicyLive,
    SNS.SetTopicAttributesPolicyLive,
    SNS.TagResourcePolicyLive,
    SNS.TopicSinkPolicyLive,
    SNS.UntagResourcePolicyLive,
    SQS.DeleteMessageBatchPolicyLive,
    SQS.QueueSinkPolicyLive,
    SQS.ReceiveMessagePolicyLive,
    SQS.SendMessageBatchPolicyLive,
    SQS.SendMessagePolicyLive,
    // SQS.QueueEventSourcePolicyLive,
  );
