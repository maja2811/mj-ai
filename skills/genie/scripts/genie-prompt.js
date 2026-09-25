const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadDatabricksProfiles, printProfiles, resolveWorkspaceSelection, sanitizeProfileName } = require('./genie-workspace');

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/genie-prompt.js "What is the latest load date?"');
  console.log('  node scripts/genie-prompt.js --profile sso_commercial_uat "Reply with OK"');
  console.log('  node scripts/genie-prompt.js --new-chat');
  console.log('  node scripts/genie-prompt.js --new-chat "What changed today?"');
  console.log('  node scripts/genie-prompt.js --list-profiles');
  console.log('  node scripts/genie-prompt.js --session genie-prompt-sso_commercial_uat --json "Reply with OK"');
  console.log('  printf "Reply with OK" | node scripts/genie-prompt.js --json');
}

function parseArgs(argv) {
  const options = {
    profileName: process.env.GENIE_PROFILE || process.env.DATABRICKS_CONFIG_PROFILE || '',
    session: process.env.GENIE_SESSION || '',
    workspaceUrl: process.env.GENIE_WORKSPACE_URL || '',
    agentBrowserStateFile: process.env.GENIE_AGENT_BROWSER_STATE_FILE || '',
    timeoutMs: Number.parseInt(process.env.GENIE_TIMEOUT_MS || '120000', 10),
    pollMs: Number.parseInt(process.env.GENIE_POLL_MS || '1000', 10),
    jsonOutput: false,
    newChat: false,
    listProfiles: false,
    promptParts: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--session') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --session.');
      options.session = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--session=')) {
      options.session = arg.split('=').slice(1).join('=');
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

    if (arg === '--agent-browser-state-file') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --agent-browser-state-file.');
      options.agentBrowserStateFile = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--agent-browser-state-file=')) {
      options.agentBrowserStateFile = arg.split('=').slice(1).join('=');
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

    if (arg === '--poll') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --poll.');
      options.pollMs = Number.parseInt(value, 10);
      i += 1;
      continue;
    }

    if (arg.startsWith('--poll=')) {
      options.pollMs = Number.parseInt(arg.split('=').slice(1).join('='), 10);
      continue;
    }

    if (arg === '--json') {
      options.jsonOutput = true;
      continue;
    }

    if (arg === '--new-chat') {
      options.newChat = true;
      continue;
    }

    if (arg === '--list-profiles') {
      options.listProfiles = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    options.promptParts.push(arg);
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid timeout: ${options.timeoutMs}`);
  }

  if (!Number.isFinite(options.pollMs) || options.pollMs <= 0) {
    throw new Error(`Invalid poll interval: ${options.pollMs}`);
  }

  return options;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  return fs.readFileSync(0, 'utf8');
}

function decodeAgentOutput(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return '';

  let value = trimmed;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
}

function runAgentBrowserEval(session, source) {
  const result = runAgentBrowserCommand(session, ['eval', '--stdin'], source);

  return decodeAgentOutput(result.stdout);
}

function tryRunAgentBrowserEval(session, source) {
  try {
    return runAgentBrowserEval(session, source);
  } catch {
    return null;
  }
}

function runAgentBrowserCommand(session, args, input = null) {
  const result = spawnSync('agent-browser', ['--session', session, ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(stderr || stdout || `agent-browser exited with status ${result.status}`);
  }

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStateScript() {
  return `(() => {
    const orgId = new URL(location.href).searchParams.get('o') || '';
    const threadKey = Object.keys(localStorage).find((key) => key.startsWith('global-assistant-notebook-id_v0.1_user_') && (!orgId || key.endsWith('_org_' + orgId)));
    const threadId = threadKey ? JSON.parse(localStorage.getItem(threadKey)) : null;
    const newChatButton =
      document.querySelector('button[data-componentid="global_assistant.panel_header.create_thread"]') ||
      document.querySelector('button[aria-label="New chat"]');
    const assistantMessages = Array.from(document.querySelectorAll('[data-testid^="message-container-assistant-"]'))
      .map((node) => (node.innerText || '').trim())
      .filter(Boolean);
    const userMessages = Array.from(document.querySelectorAll('[data-testid^="message-container-user-"]'))
      .map((node) => (node.innerText || '').trim())
      .filter(Boolean);
    const input = document.querySelector('[data-testid="magic-input-editable"][role="textbox"]');
    const submitButton = document.querySelector('button[aria-label="Submit prompt"]');
    const stopButton = document.querySelector('button[aria-label="Stop generating"]');
    return JSON.stringify({
      url: location.href,
      threadId,
      inputPresent: Boolean(input),
      submitPresent: Boolean(submitButton),
      submitDisabled: Boolean(submitButton && submitButton.disabled),
      newChatPresent: Boolean(newChatButton),
      newChatDisabled: Boolean(newChatButton && newChatButton.disabled),
      pending: Boolean(stopButton),
      assistantCount: assistantMessages.length,
      assistantMessages,
      lastAssistantText: assistantMessages.length ? assistantMessages[assistantMessages.length - 1] : '',
      userCount: userMessages.length,
      lastUserText: userMessages.length ? userMessages[userMessages.length - 1] : ''
    });
  })()`;
}

function buildOpenAssistantScript() {
  return `(async () => {
    const input = document.querySelector('[data-testid="magic-input-editable"][role="textbox"]');
    if (input) {
      return JSON.stringify({ opened: false, inputPresent: true, url: location.href });
    }

    const button =
      document.querySelector('[data-testid="global-assistant"]') ||
      document.querySelector('button[aria-label*="Assistant"]') ||
      document.querySelector('button[aria-label*="Genie"]');

    if (!button) {
      return JSON.stringify({ opened: false, inputPresent: false, url: location.href });
    }

    button.click();
    return JSON.stringify({ opened: true, inputPresent: false, url: location.href });
  })()`;
}

function buildNewChatScript() {
  return `(async () => {
    const button =
      document.querySelector('button[data-componentid="global_assistant.panel_header.create_thread"]') ||
      document.querySelector('button[aria-label="New chat"]');

    if (!button) throw new Error('New chat button not found.');
    button.click();
    return JSON.stringify({ clicked: true });
  })()`;
}

function buildSubmitScript(prompt) {
  return `(async () => {
    const input = document.querySelector('[data-testid="magic-input-editable"][role="textbox"]');
    if (!input) throw new Error('Genie input box not found. Open Genie Code in the target session first.');

    const submitButton = document.querySelector('button[aria-label="Submit prompt"]');
    if (!submitButton) throw new Error('Submit button not found.');

    input.focus();

    return JSON.stringify({
      focused: true,
      submitDisabled: Boolean(submitButton.disabled)
    });
  })()`;
}

function buildInputTextScript() {
  return `(() => {
    const input = document.querySelector('[data-testid="magic-input-editable"][role="textbox"]');
    if (!input) throw new Error('Genie input box not found.');
    return JSON.stringify({
      text: (input.innerText || '').replace(/\u00a0/g, ' '),
      trimmed: (input.innerText || '').replace(/\u00a0/g, ' ').trim()
    });
  })()`;
}

function buildClickSubmitScript() {
  return `(async () => {
    const submitButton = document.querySelector('button[aria-label="Submit prompt"]');
    if (!submitButton) throw new Error('Submit button not found.');

    for (let i = 0; i < 20 && submitButton.disabled; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (submitButton.disabled) throw new Error('Submit button stayed disabled after filling the prompt.');

    submitButton.click();

    const assistantMessages = Array.from(document.querySelectorAll('[data-testid^="message-container-assistant-"]'))
      .map((node) => (node.innerText || '').trim())
      .filter(Boolean);

    return JSON.stringify({
      submitted: true,
      assistantCount: assistantMessages.length,
      lastAssistantText: assistantMessages.length ? assistantMessages[assistantMessages.length - 1] : ''
    });
  })()`;
}

function normalizeText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').trim();
}

function fillPromptViaKeyboard(session, prompt) {
  runAgentBrowserEval(session, buildSubmitScript(prompt));
  runAgentBrowserCommand(session, ['press', 'Meta+A']);
  runAgentBrowserCommand(session, ['press', 'Backspace']);
  runAgentBrowserCommand(session, ['keyboard', 'inserttext', prompt]);

  const inputState = runAgentBrowserEval(session, buildInputTextScript());
  if (normalizeText(inputState.trimmed) !== normalizeText(prompt)) {
    throw new Error('Prompt text in Genie input did not match after keyboard entry.');
  }
}

function loadAgentBrowserState(session, stateFile) {
  if (!stateFile || !fs.existsSync(stateFile)) return false;
  runAgentBrowserCommand(session, ['state', 'load', stateFile]);
  return true;
}

function saveAgentBrowserState(session, stateFile) {
  if (!stateFile) return;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  runAgentBrowserCommand(session, ['state', 'save', stateFile]);
}

function isLoginUrl(url) {
  return /microsoftonline\.com/i.test(String(url || '')) || /\/login\.html/i.test(String(url || ''));
}

function isSameHost(left, right) {
  try {
    return new URL(left).host === new URL(right).host;
  } catch {
    return false;
  }
}

function buildSessionName(profileName) {
  return `genie-prompt-${sanitizeProfileName(profileName || 'default')}`;
}

function openWorkspace(session, workspaceUrl) {
  runAgentBrowserCommand(session, ['open', workspaceUrl]);
  try {
    runAgentBrowserCommand(session, ['wait', '--load', 'networkidle']);
  } catch {
    // Some Databricks transitions never reach networkidle; state polling is the source of truth.
  }
}

async function ensureWorkspaceReady(session, workspaceUrl, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  let promptedForManualLogin = false;
  let navigated = false;

  while (Date.now() < deadline) {
    let state = tryRunAgentBrowserEval(session, buildStateScript());

    if (!state || !state.url || !isSameHost(state.url, workspaceUrl)) {
      openWorkspace(session, workspaceUrl);
      navigated = true;
      state = tryRunAgentBrowserEval(session, buildStateScript());
    }

    if (state && state.inputPresent && state.submitPresent) {
      return state;
    }

    if (state && isLoginUrl(state.url)) {
      if (!promptedForManualLogin) {
        console.error(`Complete Microsoft/Databricks sign-in in agent-browser session "${session}" for ${workspaceUrl}.`);
        promptedForManualLogin = true;
      }
      await sleep(pollMs);
      continue;
    }

    if (state && isSameHost(state.url, workspaceUrl)) {
      tryRunAgentBrowserEval(session, buildOpenAssistantScript());
    } else if (!navigated) {
      openWorkspace(session, workspaceUrl);
      navigated = true;
    }

    await sleep(pollMs);
  }

  throw new Error(`Timed out preparing Genie in session "${session}" for ${workspaceUrl}.`);
}

async function waitForIdleState(session, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = runAgentBrowserEval(session, buildStateScript());
    if (!state.pending) return state;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for the existing Genie response to finish after ${timeoutMs}ms.`);
}

async function createNewChat(session, baselineState, timeoutMs, pollMs) {
  if (baselineState.userCount === 0 && baselineState.assistantCount === 0 && baselineState.inputPresent) {
    return { state: baselineState, created: false };
  }

  runAgentBrowserEval(session, buildNewChatScript());

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = runAgentBrowserEval(session, buildStateScript());
    const threadChanged = state.threadId && state.threadId !== baselineState.threadId;
    if (threadChanged && !state.pending && state.userCount === 0 && state.assistantCount === 0 && state.inputPresent) {
      return { state, created: true };
    }
    await sleep(pollMs);
  }

  throw new Error(`Timed out creating a new Genie chat after ${timeoutMs}ms.`);
}

async function waitForResponse(session, baseline, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  let stableText = '';
  let stablePolls = 0;

  while (Date.now() < deadline) {
    const state = runAgentBrowserEval(session, buildStateScript());
    const changed =
      state.assistantCount > baseline.assistantCount ||
      state.lastAssistantText !== baseline.lastAssistantText;

    if (changed && !state.pending && state.lastAssistantText) {
      if (state.lastAssistantText === stableText) {
        stablePolls += 1;
      } else {
        stableText = state.lastAssistantText;
        stablePolls = 1;
      }

      if (stablePolls >= 2) return state;
    } else {
      stableText = '';
      stablePolls = 0;
    }

    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for a new Genie response after ${timeoutMs}ms.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.listProfiles) {
    printProfiles(loadDatabricksProfiles());
    return;
  }

  const workspace = resolveWorkspaceSelection({
    profileName: options.profileName,
    workspaceUrl: options.workspaceUrl,
    agentBrowserStateFile: options.agentBrowserStateFile,
    promptSessionName: options.session || '',
  });
  const session = options.session || workspace.promptSessionName || buildSessionName(workspace.profileName);
  const stdinPrompt = readStdin().trim();
  const prompt = options.promptParts.join(' ').trim() || stdinPrompt;

  if (!prompt && !options.newChat) {
    printUsage();
    throw new Error('Missing prompt text.');
  }

  loadAgentBrowserState(session, workspace.agentBrowserStateFile);
  await ensureWorkspaceReady(session, workspace.workspaceUrl, options.timeoutMs, options.pollMs);
  let idleState = await waitForIdleState(session, options.timeoutMs, options.pollMs);
  saveAgentBrowserState(session, workspace.agentBrowserStateFile);
  let createdNewChat = false;

  if (options.newChat) {
    const newChatResult = await createNewChat(session, idleState, options.timeoutMs, options.pollMs);
    idleState = newChatResult.state;
    createdNewChat = newChatResult.created;
    saveAgentBrowserState(session, workspace.agentBrowserStateFile);
  }

  if (!prompt) {
    if (options.jsonOutput) {
      console.log(
        JSON.stringify(
          {
            profile: workspace.profileName,
            session,
            threadId: idleState.threadId,
            url: idleState.url,
            createdNewChat,
            workspaceUrl: workspace.workspaceUrl,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(idleState.threadId || 'New chat created.');
    return;
  }

  if (!idleState.inputPresent || !idleState.submitPresent) {
    throw new Error(`Genie input is not available in session "${session}" for ${workspace.workspaceUrl}.`);
  }

  fillPromptViaKeyboard(session, prompt);
  runAgentBrowserEval(session, buildClickSubmitScript());
  const finalState = await waitForResponse(session, idleState, options.timeoutMs, options.pollMs);
  saveAgentBrowserState(session, workspace.agentBrowserStateFile);

  if (options.jsonOutput) {
    console.log(
      JSON.stringify(
        {
          profile: workspace.profileName,
          session,
          threadId: finalState.threadId,
          prompt,
          response: finalState.lastAssistantText,
          assistantCount: finalState.assistantCount,
          url: finalState.url,
          createdNewChat,
          workspaceUrl: workspace.workspaceUrl,
          agentBrowserStateFile: workspace.agentBrowserStateFile,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(finalState.lastAssistantText);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
