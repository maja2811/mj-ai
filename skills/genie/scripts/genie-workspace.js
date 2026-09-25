const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_PROFILE_ENV = process.env.GENIE_PROFILE || process.env.DATABRICKS_CONFIG_PROFILE || '';
const DEFAULT_STATE_ROOT = process.env.GENIE_STATE_ROOT || path.join(os.tmpdir(), 'genie');
const DEFAULT_SHARED_TEMPLATE_FILE = process.env.GENIE_TEMPLATE_FILE || path.join(os.tmpdir(), 'genie-completion-capture.json');

function sanitizeProfileName(name) {
  return String(name || 'default')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'default';
}

function readJson(text, sourceDescription) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${sourceDescription} JSON: ${error.message}`);
  }
}

function loadDatabricksProfiles() {
  const result = spawnSync('databricks', ['auth', 'profiles', '-o', 'json'], {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(stderr || stdout || `databricks auth profiles failed with status ${result.status}`);
  }

  const parsed = readJson(result.stdout, 'databricks auth profiles');
  return Array.isArray(parsed.profiles) ? parsed.profiles : [];
}

function getDefaultProfileName(profiles) {
  if (DEFAULT_PROFILE_ENV) return DEFAULT_PROFILE_ENV;
  if (profiles.some((profile) => profile.name === 'DEFAULT')) return 'DEFAULT';
  if (profiles.length === 1) return profiles[0].name;
  return '';
}

function resolveProfileName(profiles, requestedProfile) {
  const profileName = requestedProfile || getDefaultProfileName(profiles);

  if (!profileName) {
    throw new Error('No Databricks profile selected. Use --profile <name> or set DATABRICKS_CONFIG_PROFILE.');
  }

  const profile = profiles.find((item) => item.name === profileName);
  if (!profile) {
    const knownProfiles = profiles.map((item) => item.name).join(', ');
    throw new Error(`Unknown Databricks profile: ${profileName}${knownProfiles ? ` (known: ${knownProfiles})` : ''}`);
  }

  return profile;
}

function getProfileArtifactPaths(profileName) {
  const safeProfile = sanitizeProfileName(profileName);
  const baseDir = path.join(DEFAULT_STATE_ROOT, 'profiles', safeProfile);
  return {
    baseDir,
    stateFile: path.join(baseDir, 'dbx-genie-state.json'),
    metadataFile: path.join(baseDir, 'workspace.json'),
    templateFile: path.join(baseDir, 'genie-completion-capture.json'),
    agentBrowserStateFile: path.join(baseDir, 'agent-browser-state.json'),
    promptSessionName: `genie-prompt-${safeProfile}`,
  };
}

function resolveTemplateFile(profileName, explicitTemplateFile) {
  if (explicitTemplateFile) return explicitTemplateFile;
  const profileTemplateFile = getProfileArtifactPaths(profileName).templateFile;
  if (fs.existsSync(profileTemplateFile)) return profileTemplateFile;
  return DEFAULT_SHARED_TEMPLATE_FILE;
}

function resolveWorkspaceSelection(options = {}) {
  const profiles = loadDatabricksProfiles();
  const profile = resolveProfileName(profiles, options.profileName || '');
  const artifacts = getProfileArtifactPaths(profile.name);
  const metadataFile = options.metadataFile || artifacts.metadataFile;
  const metadata = loadWorkspaceMetadata(metadataFile);
  return {
    profiles,
    profile,
    profileName: profile.name,
    workspaceHost: profile.host,
    workspaceUrl: options.workspaceUrl || (metadata && metadata.workspaceUrl) || profile.host,
    stateFile: options.stateFile || artifacts.stateFile,
    metadataFile,
    templateFile: resolveTemplateFile(profile.name, options.templateFile || ''),
    agentBrowserStateFile: options.agentBrowserStateFile || artifacts.agentBrowserStateFile,
    promptSessionName: options.promptSessionName || artifacts.promptSessionName,
    artifactDir: artifacts.baseDir,
  };
}

function printProfiles(profiles) {
  if (!profiles.length) {
    console.log('No Databricks profiles found.');
    return;
  }

  console.log(`Databricks profiles: ${profiles.length}`);
  for (const profile of profiles) {
    const validity = profile.valid === true ? 'YES' : profile.valid === false ? 'NO' : 'UNKNOWN';
    console.log(`- ${profile.name}  ${profile.host}  valid=${validity}`);
  }
}

function loadWorkspaceMetadata(metadataFile) {
  if (!metadataFile || !fs.existsSync(metadataFile)) return null;
  return readJson(fs.readFileSync(metadataFile, 'utf8'), metadataFile);
}

function saveWorkspaceMetadata(metadataFile, metadata) {
  fs.mkdirSync(path.dirname(metadataFile), { recursive: true });
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

module.exports = {
  DEFAULT_STATE_ROOT,
  DEFAULT_SHARED_TEMPLATE_FILE,
  loadDatabricksProfiles,
  loadWorkspaceMetadata,
  printProfiles,
  resolveWorkspaceSelection,
  saveWorkspaceMetadata,
  sanitizeProfileName,
};
