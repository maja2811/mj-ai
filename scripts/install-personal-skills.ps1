[CmdletBinding()]
param(
    [string]$SkillsDirectory = (Join-Path $HOME ".agents\skills")
)

$ErrorActionPreference = "Stop"

$skills = @(
    @{ Name = "improve"; Repository = "https://github.com/shadcn/improve.git"; Path = "skills/improve" }
    @{ Name = "huashu-design"; Repository = "https://github.com/alchaincyf/huashu-design.git"; Path = "." }
    @{ Name = "ponytail"; Repository = "https://github.com/DietrichGebert/ponytail.git"; Path = "skills/ponytail" }
    @{ Name = "stop-slop"; Repository = "https://github.com/hardikpandya/stop-slop.git"; Path = "." }
    @{ Name = "skill-generalizer"; Repository = "https://github.com/hqhq1025/skill-optimizer.git"; Path = "skills/skill-generalizer" }
    @{ Name = "skill-miner"; Repository = "https://github.com/hqhq1025/skill-optimizer.git"; Path = "skills/skill-miner" }
    @{ Name = "skill-personalizer"; Repository = "https://github.com/hqhq1025/skill-optimizer.git"; Path = "skills/skill-personalizer" }
    @{ Name = "grill-me"; Repository = "https://github.com/mattpocock/skills.git"; Path = "skills/productivity/grill-me" }
    @{ Name = "handoff"; Repository = "https://github.com/mattpocock/skills.git"; Path = "skills/productivity/handoff" }
)

New-Item -ItemType Directory -Force -Path $SkillsDirectory | Out-Null
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("mj-ai-skills-" + [guid]::NewGuid())

try {
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

    foreach ($skill in $skills) {
        $destination = Join-Path $SkillsDirectory $skill.Name
        if (Test-Path (Join-Path $destination "SKILL.md")) {
            "Skipping $($skill.Name): already installed at $destination"
            continue
        }

        $repositoryDirectory = Join-Path $temporaryDirectory $skill.Name
        git clone --depth 1 $skill.Repository $repositoryDirectory
        $source = Join-Path $repositoryDirectory $skill.Path

        if (-not (Test-Path (Join-Path $source "SKILL.md"))) {
            throw "Expected SKILL.md was not found for $($skill.Name) at $source."
        }

        Copy-Item -Recurse -Force -LiteralPath $source -Destination $destination
        "Installed $($skill.Name) to $destination"
    }
}
finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $temporaryDirectory
}
