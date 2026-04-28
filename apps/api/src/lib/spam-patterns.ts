export const SCANNER_SPAM_PATTERNS = [
	// Environment/config file probes
	".env",
	".git/",
	".htaccess",
	".htpasswd",
	".svn/",
	".DS_Store",
	// WordPress probes
	"wp-admin",
	"wp-login",
	"wp-content",
	"wp-includes",
	"wp-config",
	"xmlrpc.php",
	"wp-cron.php",
	"wlwmanifest.xml",
	// PHP tool probes
	"phpmyadmin",
	"phpMyAdmin",
	"phpinfo",
	"adminer",
	// CMS/framework probes
	"cgi-bin",
	"vendor/phpunit",
	"telescope/requests",
	// Infrastructure probes
	"actuator",
	"solr/",
	"jenkins",
	"manager/html",
	// Auth/exchange probes
	"owa/auth",
	"ecp/",
	"remote/login",
	// Shell/backdoor probes
	"webshell",
	"c99.php",
	"r57.php",
	"cmd.php",
	// Setup/install probes
	"setup.php",
	"install.php",
	// Backup/dump probes
	".sql",
	".bak",
	".zip",
	".tar",
	".gz",
	".rar",
	".7z",
	".dump",
	"backup/",
	"/dump",
	// Certificate/key file probes
	".pem",
	".key",
	".crt",
	".p12",
	".pfx",
	".jks",
	// Config file extension probes
	".yaml",
	".yml",
	".toml",
	".ini",
	".cfg",
	".conf",
	// Log file probes
	".log",
	"server.log",
	"access.log",
	"error.log",
	// Sensitive text file probes
	"env.txt",
	"credentials",
	"secret",
	// Debug/admin path probes
	"/debug/",
	"/debug?",
	"debug/default",
	"/console",
	"/admin/",
	// Infrastructure/API probes
	"app.yaml",
	"app.json",
	"/rpc",
	"/api/env",
	"database.zip",
]

export function getSpamPatternsParam(showSpam?: boolean): string | undefined {
	if (showSpam) return undefined
	return SCANNER_SPAM_PATTERNS.join(",")
}
