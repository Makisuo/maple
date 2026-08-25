export type { IconProps, IconComponent } from "./icon"

// Shared icons live in the core design system. Re-export them so existing
// `@/components/icons` consumers keep working without per-file imports.
export {
	AlertWarningIcon,
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowRotateClockwiseIcon,
	BellIcon,
	BoltIcon,
	BracketsCurlyIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronExpandYIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ChevronUpIcon,
	CircleCheckIcon,
	CircleInfoIcon,
	CircleWarningIcon,
	CircleXmarkIcon,
	ClockIcon,
	CodeIcon,
	ComputerIcon,
	ConnectionIcon,
	CopyIcon,
	DatabaseIcon,
	DotsIcon,
	EyeIcon,
	FileIcon,
	FireIcon,
	FolderOpenIcon,
	GlobeIcon,
	LineHeightIcon,
	LinkIcon,
	LoaderIcon,
	MagnifierCheckIcon,
	MagnifierIcon,
	MenuIcon,
	MinusIcon,
	MobileIcon,
	NetworkNodesIcon,
	PulseIcon,
	RadioCheckedIcon,
	RocketIcon,
	SidebarLeftIcon,
	TabletIcon,
	TextWrapIcon,
	ThumbtackIcon,
	TrashIcon,
	UserIcon,
	XmarkIcon,
} from "@maple/ui/components/icons"

// App-specific icons (not part of the core library).
export { ArrowPathIcon } from "./arrow-path"
export { ArrowRightFromLineIcon } from "./arrow-right-from-line"
export { ArrowThroughLineRightIcon } from "./arrow-through-line-right"
export { ArrowRotateAnticlockwiseIcon } from "./arrow-rotate-anticlockwise"
export { ArrowTrendDownIcon } from "./arrow-trend-down"
export { ArrowTrendUpIcon } from "./arrow-trend-up"
export { ArrowUpIcon } from "./arrow-up"
export { ArrowUpDownIcon } from "./arrow-up-down"
export { AwsLambdaIcon } from "./aws-lambda"
export { BluetoothIcon } from "./bluetooth"
export { BranchForkIcon } from "./branch-fork"
export { CompactLinesIcon } from "./compact-lines"
export { TranscriptIcon } from "./transcript"
export { ChatBubbleSparkleIcon } from "./chat-bubble-sparkle"
export { ChartBarIcon } from "./chart-bar"
export { ChartBarHorizontalIcon } from "./chart-bar-horizontal"
export { ChartBarTrendUpIcon } from "./chart-bar-trend-up"
export { ChartLineIcon } from "./chart-line"
export { CirclePercentageIcon } from "./circle-percentage"
export { CircleQuestionIcon } from "./circle-question"
export { ClickhouseIcon } from "./clickhouse"
export { CloudflareIcon, CloudflareMonoIcon } from "./cloudflare"
export { ChromeIcon } from "./chrome"
export { CornerDownLeftIcon } from "./corner-down-left"
export { CursorIcon } from "./cursor"
export { CursorPointerIcon } from "./cursor-pointer"
export { CreditCardIcon } from "./credit-card"
export { CubeIcon } from "./cube"
export { DiscordIcon } from "./discord"
export { DotsVerticalIcon } from "./dots-vertical"
export { DownloadIcon } from "./download"
export { EdgeIcon } from "./edge"
export { EnvelopeIcon } from "./envelope"
export { ExternalLinkIcon } from "./external-link"
export { FaceRobotIcon } from "./face-robot"
export { FingerprintIcon } from "./fingerprint"
export { FirefoxIcon } from "./firefox"
export { FloppyDiskIcon } from "./floppy-disk"
export { FolderIcon } from "./folder"
export { GearIcon } from "./gear"
export { GithubIcon } from "./github"
export { GoogleIcon } from "./google"
export { GridIcon } from "./grid"
export { GridSquareCirclePlusIcon } from "./grid-square-circle-plus"
export { GripDotsIcon } from "./grip-dots"
export { LayersIcon } from "./layers"
export { TagIcon } from "./tag"
export { HazelIcon } from "./hazel"
export { HistoryIcon } from "./history"
export { HouseIcon } from "./house"
export { IdBadgeIcon } from "./id-badge"
export { ImageIcon } from "./image"
export { KafkaIcon } from "./kafka"
export { KeyIcon } from "./key"
export { KeyboardIcon } from "./keyboard"
export { KubernetesIcon } from "./kubernetes"
export { LanguageIcon } from "./language"
export { LockIcon } from "./lock"
export { LayoutLeftIcon } from "./layout-left"
export { LayoutRightIcon } from "./layout-right"
export { LogoutIcon } from "./logout"
export { MaximizeIcon } from "./maximize"
export { MediaPauseIcon } from "./media-pause"
export { MediaPlayIcon } from "./media-play"
export { MinimizeIcon } from "./minimize"
export { MongodbIcon } from "./mongodb"
export { MoonIcon } from "./moon"
export { MysqlIcon } from "./mysql"
export { NatsIcon } from "./nats"
export { NodejsIcon } from "./nodejs"
export { OpenjdkIcon } from "./openjdk"
export { OperaIcon } from "./opera"
export { PaletteIcon } from "./palette"
export { PaperPlaneIcon } from "./paper-plane"
export { PencilIcon } from "./pencil"
export { PlanetScaleIcon } from "./planetscale"
// Nucleo Pixel Essential — a deliberately separate family, used where a row
// needs a type marker rather than an action affordance (the session replay
// event rail). Don't mix them with the outline icons inside one control.
export { PixelBracketsCurlyIcon } from "./pixel-brackets-curly"
export { PixelCrosshairsIcon } from "./pixel-crosshairs"
export { PixelNodesIcon } from "./pixel-nodes"
export { PixelSparkleIcon } from "./pixel-sparkle"
export { PixelTriangleWarningIcon } from "./pixel-triangle-warning"
export { PixelWindowIcon } from "./pixel-window"
export { PlayRotateClockwiseIcon } from "./play-rotate-clockwise"
export { PlusIcon } from "./plus"
export { PostgresIcon } from "./postgres"
export { PrometheusIcon } from "./prometheus"
export { RabbitmqIcon } from "./rabbitmq"
export { PriorityBarsIcon, PRIORITY_LABEL } from "./priority-bars"
export type { PriorityLevel } from "./priority-bars"
export { RedisIcon } from "./redis"
export { SafariIcon } from "./safari"
export { ServerIcon } from "./server"
export { ShieldIcon } from "./shield"
export { SlackIcon, SlackMonoIcon } from "./slack"
export { SlidersIcon } from "./sliders"
export { SpinnerIcon } from "./spinner"
export { SquareIcon } from "./square"
export { SquareTerminalIcon } from "./square-terminal"
export { StarIcon, StarFilledIcon } from "./star"
export { SunIcon } from "./sun"
export { TelegramIcon, TelegramMonoIcon } from "./telegram"
export { TruckIcon } from "./truck"
export { WarpStreamIcon } from "./warpstream"
export { UploadIcon } from "./upload"
export { WorkflowRingIcon, WORKFLOW_LABEL, WORKFLOW_COLOR } from "./workflow-ring"
