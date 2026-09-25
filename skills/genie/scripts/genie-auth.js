const {
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_GENIE_STATE_FILE,
  DEFAULT_MS_AUTH_STATE_FILE,
  ensureDatabricksAuthState,
} = require('./genie-auth-lib');
const { loadDatabricksProfiles, printProfiles, resolveWorkspaceSelection } = require('./genie-workspace');

function asBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/genie-auth.js');
  console.log('  node scripts/genie-auth.js --force');
  console.log('  node scripts/genie-auth.js --headed');
  console.log('  node scripts/genie-auth.js --profile sso_commercial_uat');
  console.log('  node scripts/genie-auth.js --list-profiles');
  console.log('');
  console.log('Defaults:');
  console.log('  workspace url: from selected Databricks profile');
  console.log(`  state file: ${DEFAULT_GENIE_STATE_FILE} (or profile-scoped default)`);
  console.log(`  Microsoft seed state: ${DEFAULT_MS_AUTH_STATE_FILE}`);
  console.log(`  timeout: ${DEFAULT_AUTH_TIMEOUT_MS}ms`);
  console.log(`  headless: ${asBool(process.env.HEADLESS, true)}`);
}

function parseArgs(argv) {
  const options = {
    profileName: process.env.GENIE_PROFILE || process.env.DATABRICKS_CONFIG_PROFILE || '',
    workspaceUrl: process.env.GENIE_WORKSPACE_URL || '',
    stateFile: process.env.GENIE_STATE_FILE || '',
    metadataFile: process.env.GENIE_METADATA_FILE || '',
    seedStateFile: process.env.GENIE_MS_AUTH_STATE_FILE || process.env.GENIE_SEED_STATE_FILE || DEFAULT_MS_AUTH_STATE_FILE,
    timeoutMs: Number.parseInt(process.env.GENIE_SETUP_TIMEOUT_MS || String(DEFAULT_AUTH_TIMEOUT_MS), 10),
    headless: asBool(process.env.HEADLESS, true),
    forceRefresh: false,
    listProfiles: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--url') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --url.');
      options.workspaceUrl = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--url=')) {
      options.workspaceUrl = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--state-file') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --state-file.');
      options.stateFile = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--state-file=')) {
      options.stateFile = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--metadata-file') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --metadata-file.');
      options.metadataFile = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--metadata-file=')) {
      options.metadataFile = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--profile') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --profile.');
      options.profileName = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--profile=')) {
      options.profileName = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--list-profiles') {
      options.listProfiles = true;
      continue;
    }

    if (arg === '--seed-state-file') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --seed-state-file.');
      options.seedStateFile = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--seed-state-file=')) {
      options.seedStateFile = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--timeout') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --timeout.');
      options.timeoutMs = Number.parseInt(value, 10);
      i += 1;
      continue;
    }

    if (arg.startsWith('--timeout=')) {
      options.timeoutMs = Number.parseInt(arg.split('=').slice(1).join('='), 10);
      continue;
    }

    if (arg === '--force' || arg === '--refresh') {
      options.forceRefresh = true;
      continue;
    }

    if (arg === '--headed') {
      options.headless = false;
      continue;
    }

    if (arg === '--headless') {
      options.headless = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid timeout: ${options.timeoutMs}`);
  }

  return options;
}

function printResult(result) {
  console.log(result.refreshed ? 'Databricks auth refreshed.' : 'Databricks auth already valid.');
  if (result.profileName) {
    console.log(`profile: ${result.profileName}`);
  }
  console.log(`state file: ${result.stateFile}`);
  if (result.metadataFile) {
    console.log(`metadata file: ${result.metadataFile}`);
  }
  if (result.seedStateFile) {
    console.log(`Microsoft seed state: ${result.seedStateFile}`);
  }
  console.log(`workspace url: ${result.workspaceUrl}`);
  console.log(`ready via: ${result.readyVia || 'existing-state'}`);
  if (result.workspaceUser) {
    console.log(`workspace user: ${result.workspaceUser}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.listProfiles) {
    printProfiles(loadDatabricksProfiles());
    return;
  }

  const workspace = resolveWorkspaceSelection(options);
  const result = await ensureDatabricksAuthState({
    ...options,
    profileName: workspace.profileName,
    workspaceUrl: workspace.workspaceUrl,
    stateFile: workspace.stateFile,
    metadataFile: workspace.metadataFile,
    autoRefresh: true,
    log: (message) => console.log(message),
  });
  printResult({
    ...result,
    profileName: workspace.profileName,
    stateFile: workspace.stateFile,
    metadataFile: workspace.metadataFile,
  });
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
