/**
 * Friendly typing-indicator phrases for requested actions.
 *
 * Eve's default `actions.requested` handler flashes the raw tool-call label
 * (`maple__list_services`, `grep pattern`) into Slack's typing status. This
 * module replaces that with a randomly picked human phrase per action
 * category, so the indicator reads like the bot talking, not a stack trace.
 *
 * Slack's typing indicator (`assistant.threads.setStatus`) caps at ~100
 * chars and eve trims to 50; every phrase here stays ≤40 so the ` +N more`
 * batch suffix always fits.
 */

/**
 * Structural view of eve's `RuntimeActionRequest` union — just the fields
 * this module reads, so it needs no import from eve internals.
 */
export interface ActionRequestLike {
	readonly kind: string
	readonly toolName?: string
	readonly subagentName?: string
	readonly remoteAgentName?: string
}

const SERVICES = [
	"Rounding up your services…",
	"Taking a service census…",
	"Seeing who's on the map…",
	"Checking in on your fleet…",
	"Counting the microservices…",
	"Surveying the service landscape…",
	"Knocking on every service's door…",
	"Drawing the service map…",
	"Tracing who talks to whom…",
	"Looking over the topology…",
	"Peeking at service health…",
	"Lining up the usual suspects…",
	"Asking services how they're doing…",
	"Charting the constellation…",
	"Doing the rounds…",
	"Taking attendance…",
	"Scanning the service roster…",
	"Mapping the neighborhood…",
	"Checking the org chart of services…",
	"Sizing up the architecture…",
] as const

const TRACES = [
	"Following the breadcrumbs…",
	"Pulling on a trace thread…",
	"Chasing spans downstream…",
	"Reading the flight recorder…",
	"Replaying the request's journey…",
	"Untangling a trace…",
	"Walking the span tree…",
	"Sifting through traces…",
	"Hunting for slow requests…",
	"Timing the hops…",
	"Inspecting the call chain…",
	"Zooming into a span…",
	"Following the request trail…",
	"Combing the waterfall…",
	"Measuring the milliseconds…",
	"Retracing the request's steps…",
	"Looking for the long pole…",
	"Piecing the story together…",
	"Reading between the spans…",
	"Stalking a latency spike…",
] as const

const LOGS = [
	"Leafing through the logs…",
	"Skimming the log stream…",
	"Grepping the haystack…",
	"Reading the ship's log…",
	"Panning the log river for gold…",
	"Squinting at log lines…",
	"Mining for log patterns…",
	"Scrolling the terminal of truth…",
	"Sorting signal from noise…",
	"Digging through the log pile…",
	"Tailing the logs…",
	"Decoding the chatter…",
	"Flipping through the diary…",
	"Scanning for tell-tale lines…",
	"Listening to what the logs say…",
	"Dusting the logs for prints…",
	"Combing the log archive…",
	"Chasing a suspicious log line…",
	"Reading the fine print…",
	"Following the paper trail…",
] as const

const ERRORS = [
	"Interrogating the errors…",
	"Rounding up the exceptions…",
	"Reading stack traces so you don't…",
	"Investigating the crime scene…",
	"Cataloguing the casualties…",
	"Sorting errors by suspicion…",
	"Poking the failure modes…",
	"Checking what went bang…",
	"Dusting for fingerprints…",
	"Reviewing the incident file…",
	"Lining up the error suspects…",
	"Examining the wreckage…",
	"Asking errors for their alibi…",
	"Tracing the blast radius…",
	"Reading the post-mortem notes…",
	"Counting the 500s…",
	"Hunting the root cause…",
	"Triaging the exceptions…",
	"Studying the failure patterns…",
	"Opening the case file…",
] as const

const DASHBOARDS = [
	"Rearranging the dashboards…",
	"Polishing the pixels…",
	"Consulting the control room…",
	"Lining up the charts…",
	"Tidying the widget garden…",
	"Studying the big board…",
	"Adjusting the mission control…",
	"Curating the chart gallery…",
	"Peeking at the panels…",
	"Reading the wall of graphs…",
	"Arranging widgets just so…",
	"Checking the vital signs…",
	"Framing a new chart…",
	"Reviewing the cockpit…",
	"Setting up the war room…",
	"Straightening the graphs…",
	"Inspecting the instrument panel…",
	"Hanging a new widget…",
	"Dusting off a dashboard…",
	"Composing the overview…",
] as const

const ALERTS = [
	"Tuning the tripwires…",
	"Checking the alarm panel…",
	"Reviewing the watchtower…",
	"Calibrating the sirens…",
	"Inspecting the smoke detectors…",
	"Auditing the alert rules…",
	"Adjusting the sensitivity dials…",
	"Reading the pager history…",
	"Checking what woke everyone up…",
	"Looking over the incident log…",
	"Arming the early warnings…",
	"Reviewing the night watch…",
	"Polling the sentries…",
	"Testing the alarm bells…",
	"Sorting the alert backlog…",
	"Studying the escalations…",
	"Wiring up a new tripwire…",
	"Consulting the on-call runbook…",
	"Counting recent pages…",
	"Sweeping the alarm history…",
] as const

const METRICS = [
	"Counting the counters…",
	"Weighing the gauges…",
	"Browsing the metric shelves…",
	"Taking measurements…",
	"Polling the vital signs…",
	"Reading the speedometer…",
	"Surveying the time series…",
	"Checking the pulse…",
	"Thumbing through histograms…",
	"Taking the temperature…",
	"Inventorying the metrics…",
	"Watching the needles move…",
	"Sampling the datapoints…",
	"Consulting the gauges…",
	"Listing what's being measured…",
	"Eyeing the trend lines…",
	"Reviewing the readouts…",
	"Sizing up the series…",
	"Crunching the counters…",
	"Scanning the telemetry…",
] as const

const QUERY = [
	"Warming up the warehouse…",
	"Asking ClickHouse nicely…",
	"Crunching the numbers…",
	"Spinning up a query…",
	"Interrogating the data…",
	"Running the big math…",
	"Slicing and dicing…",
	"Aggregating at speed…",
	"Summoning rows…",
	"Consulting the columns…",
	"Putting the data on the rack…",
	"Scanning a few billion rows…",
	"Sharpening the SQL…",
	"Comparing then and now…",
	"Grouping by everything…",
	"Letting the warehouse cook…",
	"Filtering the firehose…",
	"Doing warehouse things…",
	"Squeezing the dataset…",
	"Waiting on the fast database…",
] as const

const SOURCE = [
	"Reading the source…",
	"Spelunking the codebase…",
	"Following the imports…",
	"Browsing the repository…",
	"Tracing code paths…",
	"Reading someone's TODO comments…",
	"Opening the hood…",
	"Skimming the diffs…",
	"Cross-referencing the code…",
	"Grepping the repo…",
	"Studying the implementation…",
	"Flipping through the files…",
	"Chasing a function definition…",
	"Reading the actual code…",
	"Connecting code to telemetry…",
	"Sketching a fix…",
	"Peeking at the commit history…",
	"Walking the call sites…",
	"Consulting the source of truth…",
	"Untangling the module graph…",
] as const

const SESSIONS = [
	"Replaying the session…",
	"Reading the transcript…",
	"Reviewing the conversation…",
	"Rewinding the tape…",
	"Following the user's journey…",
	"Browsing session history…",
	"Piecing the session together…",
	"Reading the play-by-play…",
	"Scrubbing through the replay…",
	"Checking what happened here…",
	"Pulling up the recording…",
	"Studying the session trail…",
	"Reliving the request saga…",
	"Reading the minutes…",
	"Tracking the session thread…",
	"Reviewing the footage…",
	"Walking through the timeline…",
	"Opening the session archive…",
	"Retracing the visit…",
	"Catching up on the transcript…",
] as const

const MAPLE_GENERIC = [
	"Poking around Maple…",
	"Consulting the telemetry…",
	"Checking the observability deck…",
	"Peering into production…",
	"Gathering the evidence…",
	"Doing observability things…",
	"Asking Maple for details…",
	"Rummaging through telemetry…",
	"Connecting the dots…",
	"Looking under the hood…",
	"Collecting the facts…",
	"Surveying the system…",
	"Pulling up the data…",
	"Investigating…",
	"Cross-checking the signals…",
	"Assembling the picture…",
	"Following a hunch…",
	"Taking a closer look…",
	"Checking the instruments…",
	"Consulting the oracle…",
] as const

const BASH = [
	"Typing furiously in a terminal…",
	"Running a quick command…",
	"Talking to the shell…",
	"Doing terminal wizardry…",
	"Pressing enter with confidence…",
	"Piping things into things…",
	"Consulting the command line…",
	"Running it in the shell…",
	"Executing a cunning one-liner…",
	"Whispering to bash…",
	"Wrangling the shell…",
	"Letting the terminal do the work…",
	"Chaining some commands…",
	"Running the numbers, shell-style…",
	"Summoning a subprocess…",
	"Working the command line…",
	"Firing off a script…",
	"Negotiating with the shell…",
	"Typing cryptic incantations…",
	"Waiting on a command…",
] as const

const FILE_SEARCH = [
	"Rifling through the files…",
	"Grepping with intent…",
	"Searching high and low…",
	"Combing the directory tree…",
	"Playing find-the-needle…",
	"Pattern-matching my way around…",
	"Scanning the file system…",
	"Hunting for a match…",
	"Sweeping the folders…",
	"Chasing a pattern…",
	"Casting a wide glob…",
	"Sifting through files…",
	"Looking in all the usual places…",
	"Running a search party…",
	"Turning over every file…",
	"Narrowing down the matches…",
	"Peeking into directories…",
	"Following the file trail…",
	"Indexing my surroundings…",
	"Searching the stacks…",
] as const

const FILE_READ = [
	"Reading the fine print…",
	"Opening a file…",
	"Skimming the contents…",
	"Reading line by line…",
	"Studying a file…",
	"Flipping to the right page…",
	"Absorbing the contents…",
	"Giving it a careful read…",
	"Perusing the file…",
	"Reading with great interest…",
	"Taking notes…",
	"Scrolling through…",
	"Digesting the details…",
	"Having a look inside…",
	"Reading the source material…",
	"Poring over the text…",
	"Checking the file…",
	"Reviewing the contents…",
	"Reading carefully…",
	"Speed-reading a file…",
] as const

const FILE_WRITE = [
	"Putting pen to paper…",
	"Writing it down…",
	"Drafting a file…",
	"Committing thoughts to disk…",
	"Typing something up…",
	"Saving my work…",
	"Writing with intent…",
	"Jotting this down…",
	"Producing a file…",
	"Editing carefully…",
	"Making it official…",
	"Writing the thing…",
	"Filing the paperwork…",
	"Scribbling to disk…",
	"Updating the file…",
	"Crafting the contents…",
	"Getting it in writing…",
	"Recording for posterity…",
	"Writing a fresh draft…",
	"Finishing the write-up…",
] as const

const WEB_SEARCH = [
	"Asking the internet…",
	"Searching the web…",
	"Consulting the hive mind…",
	"Googling responsibly…",
	"Scouring the web…",
	"Checking the collective wisdom…",
	"Casting a net across the web…",
	"Looking it up…",
	"Querying the outside world…",
	"Browsing the wider internet…",
	"Fact-checking online…",
	"Searching beyond the firewall…",
	"Doing some research…",
	"Consulting external sources…",
	"Sweeping the search results…",
	"Asking around online…",
	"Digging through the web…",
	"Fetching fresh knowledge…",
	"Reading the internet…",
	"Hunting for answers online…",
] as const

const WEB_FETCH = [
	"Fetching a page…",
	"Knocking on a URL…",
	"Downloading the details…",
	"Visiting a link…",
	"Pulling up a page…",
	"Retrieving the goods…",
	"Following a link…",
	"Grabbing a page…",
	"Requesting politely…",
	"Loading the page…",
	"Fetching fresh bytes…",
	"Reading a web page…",
	"Curling something up…",
	"Checking that link…",
	"Bringing back a page…",
	"Fetching the source…",
	"Opening a URL…",
	"Collecting the response…",
	"Pinging a page…",
	"Getting the page contents…",
] as const

const CHART = [
	"Painting a chart…",
	"Plotting the points…",
	"Drawing pretty graphs…",
	"Rendering a visual…",
	"Turning numbers into pictures…",
	"Sketching the trend…",
	"Charting the course…",
	"Coloring inside the axes…",
	"Making the data photogenic…",
	"Framing the graph…",
	"Arranging the bars…",
	"Bending the curves…",
	"Warming up the plotter…",
	"Composing a chart…",
	"Giving the data a glow-up…",
	"Lining up the axes…",
	"Visualizing the numbers…",
	"Putting data on canvas…",
	"Drawing the picture…",
	"Polishing a graph…",
] as const

const SKILL = [
	"Consulting the playbook…",
	"Loading a skill…",
	"Reading the manual…",
	"Brushing up on procedure…",
	"Studying the runbook…",
	"Picking up a new trick…",
	"Reviewing best practices…",
	"Opening the field guide…",
	"Equipping the right tool…",
	"Learning the ropes…",
	"Flipping to the right chapter…",
	"Loading expertise…",
	"Sharpening a skill…",
	"Checking the instructions…",
	"Consulting the handbook…",
	"Refreshing my training…",
	"Reading the recipe…",
	"Gearing up…",
	"Skilling up…",
	"Dusting off the manual…",
] as const

const DELEGATE = [
	"Calling in reinforcements…",
	"Delegating like a pro…",
	"Handing this to a specialist…",
	"Waking up a helper…",
	"Phoning a friend…",
	"Dispatching an agent…",
	"Sending in the away team…",
	"Recruiting some help…",
	"Passing the baton…",
	"Bringing in an expert…",
	"Splitting up the work…",
	"Summoning a sidekick…",
	"Outsourcing this bit…",
	"Briefing a teammate…",
	"Deploying a minion…",
	"Assigning a task…",
	"Tag-teaming this one…",
	"Enlisting backup…",
	"Spinning up a helper…",
	"Sharing the load…",
] as const

const GENERIC = [
	"Working on it…",
	"Making progress…",
	"On the case…",
	"Doing the thing…",
	"Gears are turning…",
	"Thinking with tools…",
	"One moment…",
	"In the middle of something…",
	"Busy being useful…",
	"Cooking…",
	"Pulling some levers…",
	"Getting my hands dirty…",
	"Handling it…",
	"Executing the plan…",
	"Chipping away at it…",
	"Working the problem…",
	"Making it happen…",
	"Heads down…",
	"Almost there…",
	"Crunching away…",
] as const

/**
 * Exact tool name (connection prefix stripped) → phrase pool. Maple's MCP
 * tool list is resolved at runtime, so unlisted/new tools fall through to
 * the keyword heuristics below rather than breaking.
 */
const POOL_BY_TOOL: Record<string, readonly string[]> = {
	// Local tools (agent/tools/*).
	bash: BASH,
	glob: FILE_SEARCH,
	grep: FILE_SEARCH,
	read_file: FILE_READ,
	write_file: FILE_WRITE,
	web_search: WEB_SEARCH,
	web_fetch: WEB_FETCH,
	render_chart: CHART,
	load_skill: SKILL,
	// Maple MCP tools.
	list_services: SERVICES,
	service_map: SERVICES,
	diagnose_service: SERVICES,
	get_service_top_operations: SERVICES,
	search_traces: TRACES,
	inspect_trace: TRACES,
	inspect_span: TRACES,
	find_slow_traces: TRACES,
	get_session_traces: TRACES,
	search_logs: LOGS,
	mine_log_patterns: LOGS,
	find_errors: ERRORS,
	error_detail: ERRORS,
	list_error_issues: ERRORS,
	list_error_issue_events: ERRORS,
	list_error_incidents: ERRORS,
	claim_error_issue: ERRORS,
	release_error_issue: ERRORS,
	heartbeat_error_issue: ERRORS,
	comment_on_error_issue: ERRORS,
	transition_error_issue: ERRORS,
	set_issue_severity: ERRORS,
	get_incident_timeline: ERRORS,
	list_dashboards: DASHBOARDS,
	get_dashboard: DASHBOARDS,
	create_dashboard: DASHBOARDS,
	update_dashboard: DASHBOARDS,
	add_dashboard_widget: DASHBOARDS,
	update_dashboard_widget: DASHBOARDS,
	remove_dashboard_widget: DASHBOARDS,
	reorder_dashboard_widgets: DASHBOARDS,
	replace_dashboard_widgets: DASHBOARDS,
	inspect_chart_data: DASHBOARDS,
	list_alert_rules: ALERTS,
	get_alert_rule: ALERTS,
	create_alert_rule: ALERTS,
	update_alert_rule: ALERTS,
	delete_alert_rule: ALERTS,
	list_alert_checks: ALERTS,
	list_alert_incidents: ALERTS,
	update_error_notification_policy: ALERTS,
	list_metrics: METRICS,
	query_data: QUERY,
	run_sql: QUERY,
	describe_warehouse_tables: QUERY,
	compare_periods: QUERY,
	explore_attributes: QUERY,
	search_source_code: SOURCE,
	read_source_file: SOURCE,
	list_source_repositories: SOURCE,
	propose_fix: SOURCE,
	search_sessions: SESSIONS,
	get_session_transcript: SESSIONS,
}

/** Keyword fallbacks for tools not in {@link POOL_BY_TOOL}, checked in order. */
const POOL_BY_KEYWORD: readonly (readonly [string, readonly string[]])[] = [
	["trace", TRACES],
	["span", TRACES],
	["log", LOGS],
	["error", ERRORS],
	["issue", ERRORS],
	["incident", ERRORS],
	["dashboard", DASHBOARDS],
	["widget", DASHBOARDS],
	["chart", CHART],
	["alert", ALERTS],
	["metric", METRICS],
	["sql", QUERY],
	["query", QUERY],
	["warehouse", QUERY],
	["source", SOURCE],
	["service", SERVICES],
	["session", SESSIONS],
	["search", FILE_SEARCH],
	["file", FILE_READ],
]

/** `maple__list_services` → `list_services`; unprefixed names pass through. */
function stripConnectionPrefix(toolName: string): string {
	const separator = toolName.lastIndexOf("__")
	return separator === -1 ? toolName : toolName.slice(separator + 2)
}

function poolForAction(action: ActionRequestLike): readonly string[] {
	if (action.kind === "subagent-call" || action.kind === "remote-agent-call") return DELEGATE
	if (action.kind === "load-skill") return SKILL
	if (action.kind !== "tool-call" || !action.toolName) return GENERIC

	const name = stripConnectionPrefix(action.toolName).toLowerCase()
	const exact = POOL_BY_TOOL[name]
	if (exact) return exact

	for (const [keyword, pool] of POOL_BY_KEYWORD) if (name.includes(keyword)) return pool

	// Unknown maple tool: still telemetry-flavored rather than fully generic.
	if (action.toolName.startsWith("maple__")) return MAPLE_GENERIC
	return GENERIC
}

/** Matches eve's `SLACK_TYPING_STATUS_MAX_LENGTH`. */
const TYPING_STATUS_MAX_LENGTH = 50

/**
 * Caps arbitrary text (e.g. the model's own pre-tool-call narration) to
 * Slack's typing-status budget, mirroring eve's `truncateTypingStatus`
 * (which the package doesn't export).
 */
export function truncateTypingStatus(text: string): string {
	return text.length <= TYPING_STATUS_MAX_LENGTH ? text : `${text.slice(0, TYPING_STATUS_MAX_LENGTH - 1)}…`
}

/**
 * Typing-status text for one requested action batch: a random phrase from
 * the first action's pool, plus `+N more` when the model requested several
 * actions at once. `random` is injectable for tests.
 */
export function describeActionsFriendly(
	actions: readonly ActionRequestLike[],
	random: () => number = Math.random,
): string {
	const [first] = actions
	if (first === undefined) return "Working…"
	const pool = poolForAction(first)
	const phrase = pool[Math.min(Math.floor(random() * pool.length), pool.length - 1)]!
	const status = actions.length === 1 ? phrase : `${phrase} +${actions.length - 1} more`
	return status.length <= TYPING_STATUS_MAX_LENGTH ? status : `${status.slice(0, TYPING_STATUS_MAX_LENGTH - 1)}…`
}
