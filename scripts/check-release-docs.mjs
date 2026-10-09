// Fails when a published package's version is not reflected in its CHANGELOG and the root README.
import { readFileSync } from "node:fs";

const packages = ["core", "sdk"];
const readme = readFileSync("README.md", "utf8");
const problems = [];

for (const dir of packages) {
  const { name, version } = JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8"));
  const changelog = readFileSync(`packages/${dir}/CHANGELOG.md`, "utf8");
  if (!new RegExp(`^## ${version.replaceAll(".", "\\.")}\\b`, "m").test(changelog)) {
    problems.push(`packages/${dir}/CHANGELOG.md has no "## ${version}" section`);
  }
  if (!readme.includes(`${name}@${version}`) && !new RegExp(`${name.replace("/", "\\/")}\`? \\*\\*${version.replaceAll(".", "\\.")}\\*\\*`).test(readme)) {
    problems.push(`README.md does not mention ${name} ${version}`);
  }
}

if (problems.length) {
  console.error(`Release docs are out of date:\n- ${problems.join("\n- ")}\nAlso update the wiki (Home, Quick-start, SDK, _Sidebar).`);
  process.exit(1);
}
console.log("Release docs match package versions.");
