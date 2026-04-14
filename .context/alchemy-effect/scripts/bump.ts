import { $ } from "bun";
import { generate } from "changelogithub";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function generateReleaseNotes(tag: string) {
  console.log(`Generating release notes for version ${tag}`);
  const changelog = await generate({
    to: tag,
    emoji: true,
    contributors: true,
    repo: "alchemy-run/alchemy",
  });
  const fileContents = await readFile(
    join(process.cwd(), "CHANGELOG.md"),
    "utf-8",
  );
  if (fileContents.includes(tag)) {
    console.log(`Version ${tag} already exists in changelog, skipping`);
    return;
  }
  await writeFile(
    join(process.cwd(), "CHANGELOG.md"),
    `## ${tag}\n\n${changelog.md}\n\n---\n\n${fileContents}`,
  );
}

async function checkNpmVersion(
  packageName: string,
  version: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${packageName}/${version}`,
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function checkGithubTag(version: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/alchemy-run/alchemy-effect/git/refs/tags/v${version}`,
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function checkGithubRelease(version: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/alchemy-run/alchemy-effect/releases/tags/v${version}`,
    );
    return response.ok;
  } catch {
    return false;
  }
}

const versionInput = process.argv[2];

if (!versionInput) {
  console.error(
    "Please provide a version number or bump type (major, minor, patch)",
  );
  process.exit(1);
}

$.cwd(process.cwd());

const alchemyPackageJsonPath = join(
  process.cwd(),
  "alchemy-effect",
  "package.json",
);
const alchemyPackageJson = JSON.parse(
  await readFile(alchemyPackageJsonPath, "utf-8"),
);

let newVersion = "";

// Check if it's a beta bump or a specific version
if (versionInput === "beta") {
  // Query npm for the latest 2.0.0-beta.N and increment N
  const packageName = alchemyPackageJson.name;
  let betaN = 1;
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}`);
    if (response.ok) {
      const data = (await response.json()) as {
        versions?: Record<string, unknown>;
      };
      const versions = Object.keys(data.versions ?? {});
      const betaNumbers = versions
        .map((v) => {
          const m = v.match(/^2\.0\.0-beta\.(\d+)$/);
          return m ? parseInt(m[1]!, 10) : NaN;
        })
        .filter((n) => !isNaN(n));
      if (betaNumbers.length > 0) {
        betaN = Math.max(...betaNumbers) + 1;
      }
    }
  } catch {
    // npm registry unreachable — start at 1
  }
  newVersion = `2.0.0-beta.${betaN}`;
  console.log(`Bumping to next beta version: ${newVersion}`);
} else {
  // Validate specific version format (x.y.z or x.y.z-pre.N)
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(versionInput)) {
    console.error(
      "Version must be in format x.y.z or x.y.z-pre.N, or use 'beta'",
    );
    process.exit(1);
  }

  newVersion = versionInput;
  console.log(`Setting specific version: ${newVersion}`);
}

// Check if version already exists
const npmExists = await checkNpmVersion(alchemyPackageJson.name, newVersion);
if (npmExists) {
  console.error(`Version ${newVersion} already exists on npm`);
  process.exit(1);
}

const githubTagExists = await checkGithubTag(newVersion);
if (githubTagExists) {
  console.error(`Tag v${newVersion} already exists on GitHub`);
  process.exit(1);
}

const githubReleaseExists = await checkGithubRelease(newVersion);
if (githubReleaseExists) {
  console.error(`Release v${newVersion} already exists on GitHub`);
  process.exit(1);
}

alchemyPackageJson.version = newVersion;
await writeFile(
  alchemyPackageJsonPath,
  `${JSON.stringify(alchemyPackageJson, null, 2)}\n`,
);

// Bump @alchemy.run/better-auth version
const betterAuthPackageJsonPath = join(
  process.cwd(),
  "packages",
  "better-auth",
  "package.json",
);
const betterAuthPackageJson = JSON.parse(
  await readFile(betterAuthPackageJsonPath, "utf-8"),
);
betterAuthPackageJson.version = newVersion;
await writeFile(
  betterAuthPackageJsonPath,
  `${JSON.stringify(betterAuthPackageJson, null, 2)}\n`,
);

await $`bun install`;

console.log(`Updated version to ${newVersion} in package.json`);

// TODO(sam): un-comment this when we want to public compat date in cloudflare
// Generate build date for the release
// console.log("Generating Workers compatibility date...");
// await $`cd alchemy && bun ./scripts/generate-compatibility-date.ts`;
// await $`git add package.json alchemy-effect/package.json alchemy/src/cloudflare/compatibility-date.gen.ts bun.lock`;

await $`git add package.json alchemy-effect/package.json packages/better-auth/package.json bun.lock`;
await $`git commit -m "chore(release): ${newVersion}"`;
await $`git tag v${newVersion}`;

await generateReleaseNotes(`v${newVersion}`);

await $`git add CHANGELOG.md`;
await $`git commit --amend --no-edit`;
await $`git tag -d v${newVersion}`;

console.log(`Bumped version to ${newVersion} and generated release notes`);
