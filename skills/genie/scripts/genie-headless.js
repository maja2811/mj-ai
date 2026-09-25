const fs = require('fs');
const { chromium } = require('playwright');
const { DEFAULT_GENIE_STATE_FILE, ensureDatabricksAuthState } = require('./genie-auth-lib');
const { loadDatabricksProfiles, printProfiles, resolveWorkspaceSelection } = require('./genie-workspace');

const INPUT_SELECTOR = '[data-testid="magic-input-editable"][role="textbox"]';
const SUBMIT_SELECTOR = 'button[aria-label="Submit prompt"]';
const STOP_SELECTOR = 'button[aria-label="Stop generating"]';
const NEW_CHAT_SELECTOR = 'button[data-componentid="global_assistant.panel_header.create_thread"], button[aria-label="New chat"]';

async function maybeApproveCodeExecution(page) {
  // Databricks shows a consent dialog when Genie wants to execute code.
  // Auto-click "Allow" to proceed. The button text may include keyboard shortcut hints.
  const selectors = [
    page.getByRole('button', { name: /allow/i }).first(),
    page.locator('button:has-text("Allow")').first(),
  ];
  for (const locator of selectors) {
    if (await locator.isVisible().catch(() => false)) {
      await locator.click().catch(() => {});
      return true;
    }
  }
  return false;
}

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/genie-headless.js "Find KTS tables"');
  console.log('  node scripts/genie-headless.js --profile sso_commercial_uat "Find KTS tables"');
  console.log('  node scripts/genie-headless.js --new-chat "Compare kundeantal and kundeantal_v2"');
  console.log('  node scripts/genie-headless.js --mode network "Find KTS tables"');
  console.log('  node scripts/genie-headless.js --timeout 60000 "Find KTS tables"');
  console.log('  node scripts/genie-headless.js --debug-network "Find KTS tables"');
  console.log('  node scripts/genie-headless.js --list-profiles');
  console.log('  node scripts/genie-headless.js --json "Reply with OK"');
  console.log('');
  console.log('Defaults:');
  console.log(`  state file: ${DEFAULT_GENIE_STATE_FILE} (or profile-scoped default)`);
  console.log('  url: from selected Databricks profile');
  console.log('  mode: network');
  console.log('  response timeout: disabled');
}

function parseArgs(argv) {
  const options = {
    profileName: process.env.GENIE_PROFILE || process.env.DATABRICKS_CONFIG_PROFILE || '',
    stateFile: process.env.GENIE_STATE_FILE || '',
    metadataFile: process.env.GENIE_METADATA_FILE || '',
    url: process.env.GENIE_WORKSPACE_URL || '',
    timeoutMs: Number.parseInt(process.env.GENIE_TIMEOUT_MS || '0', 10),
    setupTimeoutMs: Number.parseInt(process.env.GENIE_SETUP_TIMEOUT_MS || '180000', 10),
    pollMs: Number.parseInt(process.env.GENIE_POLL_MS || '500', 10),
    mode: process.env.GENIE_MODE || 'network',
    debugNetwork: process.env.GENIE_DEBUG_NETWORK === '1',
    jsonOutput: false,
    newChat: false,
    listProfiles: false,
    promptParts: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

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

    if (arg === '--url') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --url.');
      options.url = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--url=')) {
      options.url = arg.split('=').slice(1).join('=');
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

    if (arg === '--debug-network') {
      options.debugNetwork = true;
      continue;
    }

    if (arg === '--mode') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --mode.');
      options.mode = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--mode=')) {
      options.mode = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--new-chat') {
      options.newChat = true;
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

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error(`Invalid timeout: ${options.timeoutMs}`);
  }

  if (!Number.isFinite(options.setupTimeoutMs) || options.setupTimeoutMs <= 0) {
    throw new Error(`Invalid setup timeout: ${options.setupTimeoutMs}`);
  }

  if (!Number.isFinite(options.pollMs) || options.pollMs <= 0) {
    throw new Error(`Invalid poll interval: ${options.pollMs}`);
  }

  if (!['dom', 'network'].includes(options.mode)) {
    throw new Error(`Invalid mode: ${options.mode}`);
  }

  return options;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  return fs.readFileSync(0, 'utf8');
}

function normalizeText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').trim();
}

function snapshotSignature(state) {
  return JSON.stringify(state.entries.map((entry) => [entry.key, entry.text]));
}

function uiActivitySignature(state) {
  return JSON.stringify({
    pending: Boolean(state && state.pending),
    entries: Array.isArray(state && state.entries)
      ? state.entries.map((entry) => [entry.key, entry.role, entry.text])
      : [],
  });
}

function rememberUniqueValue(list, value) {
  const text = normalizeText(value);
  if (!text) return;
  if (!list.includes(text)) {
    list.push(text);
  }
}

function getUsedModel(networkState) {
  if (!networkState) return '';
  return networkState.lastResponseModel
    || networkState.lastRequestedModel
    || networkState.responseModels[networkState.responseModels.length - 1]
    || networkState.requestedModels[networkState.requestedModels.length - 1]
    || '';
}

function createDeadline(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Number.POSITIVE_INFINITY;
  return Date.now() + timeoutMs;
}

function hasNewAssistantContent(baselineState, nextState) {
  const before = (baselineState.entries || []).filter((entry) => entry.role === 'assistant').map((entry) => normalizeText(entry.text));
  const after = (nextState.entries || []).filter((entry) => entry.role === 'assistant').map((entry) => normalizeText(entry.text));

  if (after.length > before.length) return true;
  if (after.length === 0) return false;
  if (before.length === 0) return after[after.length - 1].length > 0;
  return after[after.length - 1] !== before[before.length - 1];
}

function printEntry(role, text, update = false, outputState = null) {
  const signature = `${update ? 'update' : 'full'}:${role}:${text}`;
  if (outputState && outputState.lastFullSignature === signature) {
    return;
  }

  const tag = update ? `${role} update` : role;
  if (text.includes('\n')) {
    process.stdout.write(`[${tag}]\n${text}\n\n`);
    if (outputState) outputState.lastFullSignature = signature;
    return;
  }
  process.stdout.write(`[${tag}] ${text}\n\n`);
  if (outputState) outputState.lastFullSignature = signature;
}

function emitTranscriptDiff(previousState, nextState, outputState) {
  const previousByKey = new Map((previousState.entries || []).map((entry) => [entry.key, entry.text]));
  let changed = false;

  for (const entry of nextState.entries) {
    const previousText = previousByKey.get(entry.key);
    if (previousText == null) {
      printEntry(entry.role, entry.text, false, outputState);
      changed = true;
      continue;
    }

    if (previousText === entry.text) continue;
    changed = true;
    if (entry.text.startsWith(previousText)) {
      const suffix = entry.text.slice(previousText.length);
      if (suffix) {
        process.stdout.write(suffix);
        if (outputState) outputState.lastFullSignature = '';
      }
      continue;
    }

    printEntry(entry.role, entry.text, true, outputState);
  }

  return changed;
}

async function getUiState(page) {
  return page.evaluate(
    ({ inputSelector, submitSelector, stopSelector, newChatSelector }) => {
      const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').trim();
      const orgId = new URL(location.href).searchParams.get('o') || '';
      const threadKey = Object.keys(localStorage).find(
        (key) => key.startsWith('global-assistant-notebook-id_v0.1_user_') && key.endsWith(`_org_${orgId}`),
      );
      const threadId = threadKey ? JSON.parse(localStorage.getItem(threadKey)) : null;
      const input = document.querySelector(inputSelector);
      const submitButton = document.querySelector(submitSelector);
      const stopButton = document.querySelector(stopSelector);
      const newChatButton = document.querySelector(newChatSelector);
      const entries = Array.from(document.querySelectorAll('[data-testid^="message-container-"]'))
        .map((node, index) => {
          const key = node.getAttribute('data-testid') || `message-${index}`;
          const role = key.includes('assistant') ? 'assistant' : key.includes('user') ? 'user' : 'message';
          const text = normalize(node.innerText || '');
          return { key, role, text };
        })
        .filter((entry) => entry.text);

      return {
        url: location.href,
        title: document.title,
        threadId,
        inputPresent: Boolean(input),
        submitPresent: Boolean(submitButton),
        submitDisabled: Boolean(submitButton && submitButton.disabled),
        pending: Boolean(stopButton),
        newChatPresent: Boolean(newChatButton),
        entries,
      };
    },
    {
      inputSelector: INPUT_SELECTOR,
      submitSelector: SUBMIT_SELECTOR,
      stopSelector: STOP_SELECTOR,
      newChatSelector: NEW_CHAT_SELECTOR,
    },
  );
}

async function ensureGenieInput(page, timeoutMs) {
  const deadline = createDeadline(timeoutMs);
  const openSelectors = [
    '[data-testid="global-assistant"]',
    'button[aria-label*="Assistant"]',
    'button[aria-label*="Genie"]',
  ];

  while (Date.now() < deadline) {
    const input = page.locator(INPUT_SELECTOR);
    if ((await input.count()) > 0 && (await input.first().isVisible().catch(() => false))) {
      return;
    }

    for (const selector of openSelectors) {
      const button = page.locator(selector).first();
      if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
        await button.click().catch(() => {});
        await page.waitForTimeout(1000);
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error('Genie input box not found. Open/save a logged-in Genie session first.');
}

async function createNewChat(page, baselineState, timeoutMs, pollMs) {
  if (baselineState.entries.length === 0 && baselineState.inputPresent) {
    return { state: baselineState, created: false };
  }

  const button = page.locator(NEW_CHAT_SELECTOR).first();
  if ((await button.count()) === 0) {
    throw new Error('New chat button not found.');
  }

  await button.click();

  const deadline = createDeadline(timeoutMs);
  while (Date.now() < deadline) {
    const state = await getUiState(page);
    const threadChanged = state.threadId && state.threadId !== baselineState.threadId;
    if (threadChanged && !state.pending && state.entries.length === 0 && state.inputPresent) {
      return { state, created: true };
    }
    await page.waitForTimeout(pollMs);
  }

  throw new Error(`Timed out creating a new Genie chat after ${timeoutMs}ms.`);
}

async function submitPrompt(page, prompt) {
  const input = page.locator(INPUT_SELECTOR).first();
  const submit = page.locator(SUBMIT_SELECTOR).first();

  await input.focus();
  await input.evaluate((node) => node.focus());
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(prompt);

  const inputText = await input.evaluate((node) => String(node.innerText || '').replace(/\u00a0/g, ' ').trim());
  if (normalizeText(inputText) !== normalizeText(prompt)) {
    throw new Error('Prompt text in Genie input did not match after keyboard entry.');
  }

  await submit.waitFor({ state: 'visible', timeout: 30000 });
  await submit.click();
}

async function waitForStream(page, baselineState, timeoutMs, pollMs, jsonOutput) {
  const deadline = createDeadline(timeoutMs);
  let lastState = baselineState;
  let lastSignature = snapshotSignature(baselineState);
  let stablePolls = 0;
  let sawChange = false;
  const outputState = { lastFullSignature: '' };

  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    await maybeApproveCodeExecution(page);
    const state = await getUiState(page);
    const signature = snapshotSignature(state);

    if (!jsonOutput) {
      const changed = emitTranscriptDiff(lastState, state, outputState);
      sawChange ||= changed;
    } else if (signature !== lastSignature) {
      sawChange = true;
    }

    if (signature === lastSignature) {
      stablePolls += 1;
    } else {
      stablePolls = 0;
    }

    if (sawChange && !state.pending && stablePolls >= 2) {
      return state;
    }

    lastState = state;
    lastSignature = signature;
  }

  throw new Error(`Timed out waiting for Genie output after ${timeoutMs}ms.`);
}

async function installNetworkCapture(context) {
  await context.addInitScript(() => {
    if (window.__genieNetworkCaptureInstalled) return;
    window.__genieNetworkCaptureInstalled = true;

    const capture = {
      events: [],
      nextId: 1,
      toolNameByCallId: {},
    };

    window.__genieNetworkCapture = capture;

    const push = (type, payload = {}) => {
      capture.events.push({
        id: capture.nextId++,
        ts: Date.now(),
        type,
        ...payload,
      });
      if (capture.events.length > 4000) {
        capture.events.splice(0, capture.events.length - 4000);
      }
    };

    const truncate = (value, limit = 8000) => {
      if (value == null) return null;
      const text = String(value);
      return text.length > limit ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]` : text;
    };

    const parseJson = (value) => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    };

    const stripMd = (value) => String(value || '').replace(/^%md\n/, '');

    const parseReasoningCommand = (value) => {
      const text = stripMd(value);
      const match = text.match(/^__REASONING_START__(\{[\s\S]*\})__REASONING_END__/);
      if (!match) return null;
      return parseJson(match[1]);
    };

    const bodyToText = async (body) => {
      if (body == null) return null;
      if (typeof body === 'string') return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof FormData) return JSON.stringify(Array.from(body.entries()));
      if (body instanceof Blob) return await body.text();
      if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength}]`;
      if (ArrayBuffer.isView(body)) return `[TypedArray ${body.byteLength}]`;
      if (typeof body === 'object') return JSON.stringify(body);
      return String(body);
    };

    const parseNotebookRequest = (url, method, requestBodyText) => {
      const pathname = new URL(url, location.href).pathname;
      if (!pathname.startsWith('/notebook')) return;
      const body = parseJson(requestBodyText);
      if (!body) return;

      const threadMatch = pathname.match(/^\/notebook\/(\d+)/);
      const threadId = threadMatch ? threadMatch[1] : null;

      if (body['@method'] === 'addCmd') {
        const metadata = body.metadata || {};
        const role = metadata.role || '';
        if (role === 'user') {
          push('notebook-user', {
            threadId,
            promptId: metadata.promptId || '',
            text: stripMd(body.commandText),
          });
          return;
        }

        if (role === 'assistant') {
          const reasoning = parseReasoningCommand(body.commandText);
          if (reasoning) {
            push('notebook-reasoning', {
              threadId,
              promptId: metadata.promptId || '',
              text: reasoning.text || '',
              signature: reasoning.signature || '',
            });
            return;
          }

          push('notebook-assistant-final', {
            threadId,
            promptId: metadata.promptId || '',
            text: stripMd(body.commandText),
          });
          return;
        }

        if (role === 'toolInput') {
          const parsed = parseJson(stripMd(body.commandText)) || {};
          if (parsed.toolCallId && parsed.toolName) {
            capture.toolNameByCallId[parsed.toolCallId] = parsed.toolName;
          }
          push('notebook-tool-input', {
            threadId,
            promptId: metadata.promptId || '',
            toolCallId: parsed.toolCallId || '',
            toolName: parsed.toolName || '',
            content: parsed.content || '',
          });
          return;
        }

        if (role === 'toolOutput') {
          const toolCall = metadata.toolCalls && metadata.toolCalls[0] ? metadata.toolCalls[0] : {};
          const parsedContent = parseJson(toolCall.content || '');
          push('notebook-tool-output', {
            threadId,
            promptId: metadata.promptId || '',
            toolCallId: toolCall.toolCallId || '',
            toolName: capture.toolNameByCallId[toolCall.toolCallId] || toolCall.toolName || '',
            content: parsedContent,
            rawContent: truncate(toolCall.content || '', 12000),
          });
          return;
        }

        return;
      }

      const runCmdMatch = pathname.match(/^\/notebook\/(\d+)\/command\/(\d+)$/);
      if (runCmdMatch && body['@method'] === 'runCmd') {
        push('notebook-run-cmd', {
          threadId: runCmdMatch[1],
          commandId: runCmdMatch[2],
          code: body.newCommandText || body.codeSelection || '',
        });
      }
    };

    const parseCompletionRequest = (requestBodyText) => {
      const body = parseJson(requestBodyText) || {};
      const metadata = body.metadata || {};
      const clientId = metadata.clientId || null;
      const requestedModel = typeof body.model === 'string'
        ? body.model
        : body.params && typeof body.params.model === 'string'
          ? body.params.model
          : '';
      // Treat the Genie agent-mode client as a main request — Databricks now
      // always sets this clientId for the primary assistant completion stream.
      const isMain = !clientId || clientId === 'editor-assistant-agent-mode';
      return {
        body,
        metadata,
        clientId,
        requestedModel,
        isMain,
      };
    };

    const streamCompletionClone = async (response, requestId, parsedRequest) => {
      const clone = response.clone();
      const contentType = clone.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        push(parsedRequest.isMain ? 'completion-main-end' : 'completion-aux-end', {
          requestId,
          clientId: parsedRequest.clientId,
        });
        return;
      }

      const reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const toolCalls = [];
      let streamedModel = '';

      const processPayload = (payloadText) => {
        if (!payloadText || payloadText === '[DONE]') return;
        const parsed = parseJson(payloadText);
        if (!parsed) return;
        const choice = parsed.choices && parsed.choices[0];
        const delta = choice && choice.delta;

        if (typeof parsed.model === 'string' && parsed.model && parsed.model !== streamedModel) {
          streamedModel = parsed.model;
          push('completion-model', {
            requestId,
            clientId: parsedRequest.clientId,
            model: parsed.model,
            requestedModel: parsedRequest.requestedModel,
            isMain: parsedRequest.isMain,
          });
        }

        if (delta && typeof delta.content === 'string' && parsedRequest.isMain) {
          push('completion-main-text', {
            requestId,
            text: delta.content,
          });
        }

        if (delta && Array.isArray(delta.tool_calls) && parsedRequest.isMain) {
          for (const chunk of delta.tool_calls) {
            const index = Number.isInteger(chunk.index) ? chunk.index : 0;
            toolCalls[index] ||= { id: '', name: '', arguments: '' };
            if (chunk.id) toolCalls[index].id += chunk.id;
            if (chunk.function && chunk.function.name) toolCalls[index].name += chunk.function.name;
            if (chunk.function && chunk.function.arguments) toolCalls[index].arguments += chunk.function.arguments;
          }
        }

        if (choice && choice.finish_reason) {
          if (parsedRequest.isMain) {
            push('completion-main-finish', {
              requestId,
              finishReason: choice.finish_reason,
              toolCalls: toolCalls.filter(Boolean),
            });
          }
        }
      };

      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          while (true) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary === -1) break;
            const eventText = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const dataLines = eventText
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart());
            if (dataLines.length > 0) {
              processPayload(dataLines.join('\n'));
            }
          }
        }
      } catch (error) {
        push('completion-stream-error', {
          requestId,
          clientId: parsedRequest.clientId,
          message: String(error),
        });
      }

      if (parsedRequest.isMain) {
        push('completion-main-end', { requestId });
      } else {
        push('completion-aux-end', { requestId, clientId: parsedRequest.clientId });
      }
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === 'string' ? input : input && input.url;
      const method = init.method || (input && input.method) || 'GET';
      let requestBodyText = null;

      try {
        if (init.body != null) {
          requestBodyText = await bodyToText(init.body);
        } else if (typeof Request !== 'undefined' && input instanceof Request) {
          requestBodyText = await input.clone().text();
        }
      } catch {}

      if (url) {
        parseNotebookRequest(url, method, requestBodyText);
      }

      let completionRequest = null;
      let requestId = null;
      if (url && url.includes('/ajax-api/2.0/conversation/proxy/chat/completions')) {
        completionRequest = parseCompletionRequest(requestBodyText);
        requestId = capture.nextId;
        push(completionRequest.isMain ? 'completion-main-start' : 'completion-aux-start', {
          requestId,
          clientId: completionRequest.clientId,
          requestedModel: completionRequest.requestedModel,
        });
      }

      const response = await originalFetch(...args);

      if (completionRequest && requestId != null) {
        streamCompletionClone(response, requestId, completionRequest).catch(() => {});
      }

      return response;
    };

    const OriginalXHR = window.XMLHttpRequest;
    function WrappedXHR() {
      const xhr = new OriginalXHR();
      let requestUrl = null;
      let requestMethod = 'GET';

      const open = xhr.open;
      xhr.open = function(method, url, ...rest) {
        requestMethod = method;
        requestUrl = url;
        return open.call(this, method, url, ...rest);
      };

      const send = xhr.send;
      xhr.send = function(body) {
        Promise.resolve(bodyToText(body))
          .then((requestBodyText) => {
            if (requestUrl) {
              parseNotebookRequest(requestUrl, requestMethod, requestBodyText);
            }
          })
          .catch(() => {});
        return send.call(this, body);
      };

      return xhr;
    }
    WrappedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = WrappedXHR;
  });
}

async function getNetworkEvents(page, afterId) {
  return page.evaluate((lastId) => {
    const events = window.__genieNetworkCapture && Array.isArray(window.__genieNetworkCapture.events)
      ? window.__genieNetworkCapture.events
      : [];
    return events.filter((event) => event.id > lastId);
  }, afterId);
}

function summarizeToolOutput(content) {
  if (!content || typeof content !== 'object') return '';
  if (Array.isArray(content.data)) return `${content.data.length} result(s)`;
  if (content.data && content.data.tableName) {
    const columnCount = Array.isArray(content.data.columns) ? content.data.columns.length : 0;
    return `${content.data.tableName}${columnCount ? ` (${columnCount} columns)` : ''}`;
  }
  if (content.result && Array.isArray(content.result.rows)) {
    return `${content.result.rows.length} row(s)`;
  }
  if (content.data && Array.isArray(content.data.relevantDocs)) {
    return `${content.data.relevantDocs.length} doc(s)`;
  }
  if (Array.isArray(content.cellResults)) {
    return `${content.cellResults.length} cell result(s)`;
  }
  if (content.success === true) return 'success';
  return JSON.stringify(content).slice(0, 160);
}

function truncatePreview(value, maxLength = 80) {
  const text = normalizeText(value);
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function previewValue(value, maxLength = 80) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return truncatePreview(String(value), maxLength);
  }
  if (Array.isArray(value)) {
    return truncatePreview(value.map((item) => previewValue(item, 24)).filter(Boolean).join(', '), maxLength);
  }
  if (value && typeof value === 'object' && value.__more && typeof value.__more.value === 'string') {
    return truncatePreview(value.__more.value, maxLength);
  }
  try {
    return truncatePreview(JSON.stringify(value), maxLength);
  } catch {
    return truncatePreview(String(value), maxLength);
  }
}

function getCellResultHeaders(schema) {
  if (Array.isArray(schema)) return schema.map((field, index) => field && field.name ? field.name : `col_${index + 1}`);
  if (schema && Array.isArray(schema.fields)) {
    return schema.fields.map((field, index) => field && field.name ? field.name : `col_${index + 1}`);
  }
  return [];
}

function getCellResultRows(result) {
  if (!result || !Array.isArray(result.data)) return [];
  return result.data.map((row) => (Array.isArray(row) ? row : [row]));
}

function formatAsciiTable(headers, rows, maxRows = 10, maxColumns = 6, maxCellWidth = 36) {
  if (!Array.isArray(headers) || headers.length === 0 || !Array.isArray(rows)) return '';

  const visibleHeaders = headers.slice(0, maxColumns).map((header, index) => truncatePreview(header || `col_${index + 1}`, maxCellWidth));
  const visibleRows = rows.slice(0, maxRows).map((row) => visibleHeaders.map((_, index) => previewValue(row[index], maxCellWidth)));
  const widths = visibleHeaders.map((header, index) => Math.max(header.length, ...visibleRows.map((row) => (row[index] || '').length)));
  const formatRow = (row) => row.map((cell, index) => String(cell || '').padEnd(widths[index], ' ')).join(' | ');
  const separator = widths.map((width) => '-'.repeat(width)).join('-+-');

  return [formatRow(visibleHeaders), separator, ...visibleRows.map((row) => formatRow(row))].join('\n');
}

function formatTableSearchOutput(content) {
  if (!content || !Array.isArray(content.data) || content.data.length === 0) return '';
  const lines = content.data.slice(0, 8).map((item) => {
    const name = item.fullyQualifiedName || [item.catalogName, item.schemaName, item.tableName].filter(Boolean).join('.') || previewValue(item, 120);
    const columns = Array.isArray(item.columns)
      ? item.columns.map((column) => column && column.name).filter(Boolean).slice(0, 3)
      : [];
    const suffix = columns.length > 0 ? ` (${columns.join(', ')}${item.columns.length > columns.length ? ', ...' : ''})` : '';
    return `- ${name}${suffix}`;
  });

  if (content.data.length > 8) {
    lines.push(`... ${content.data.length - 8} more result(s)`);
  }

  if (content.__wasCompacted && content.__compactionMessage) {
    lines.push(`note: ${content.__compactionMessage}`);
  }

  return lines.join('\n');
}

function formatReadTableOutput(content) {
  if (!content || !content.data || !content.data.tableName) return '';
  const columns = Array.isArray(content.data.columns)
    ? content.data.columns.map((column) => column && column.name).filter(Boolean)
    : [];
  const lines = [`table: ${content.data.tableName}${content.data.tableType ? ` (${content.data.tableType})` : ''}`];

  if (columns.length > 0) {
    const preview = columns.slice(0, 10).join(', ');
    lines.push(`columns: ${preview}${columns.length > 10 ? ', ...' : ''}`);
  }

  if (content.__wasCompacted && content.__compactionMessage) {
    lines.push(`note: ${content.__compactionMessage}`);
  }

  return lines.join('\n');
}

function formatCellResultsOutput(content) {
  if (!content || !Array.isArray(content.cellResults) || content.cellResults.length === 0) return '';
  const primaryTable = content.cellResults.find((result) => Array.isArray(result.data) && getCellResultHeaders(result.schema).length > 0);
  const lines = [];

  if (primaryTable) {
    const headers = getCellResultHeaders(primaryTable.schema);
    const rows = getCellResultRows(primaryTable);
    if (primaryTable.summary) {
      lines.push(primaryTable.summary);
    }
    lines.push(formatAsciiTable(headers, rows));
    if (rows.length > 10) {
      lines.push(`... ${rows.length - 10} more row(s)`);
    }
    if (headers.length > 6) {
      lines.push(`... ${headers.length - 6} more column(s)`);
    }
  }

  const datasetInfo = content.cellResults.find((result) => result && result.type === 'dataset_info' && result.summary);
  if (datasetInfo && (!primaryTable || datasetInfo.summary !== primaryTable.summary)) {
    lines.push(`dataset: ${datasetInfo.summary}`);
  }

  if (typeof content.executionDurationMin === 'number') {
    lines.push(`duration: ${content.executionDurationMin} min`);
  }

  return lines.join('\n').trim();
}

function formatDocsOutput(content) {
  if (!content || !content.data || !Array.isArray(content.data.relevantDocs) || content.data.relevantDocs.length === 0) return '';
  const lines = content.data.relevantDocs.slice(0, 5).map((doc) => {
    const title = previewValue(doc.title || doc.name || doc.url || doc.path, 80);
    const url = previewValue(doc.url || doc.path, 120);
    return url ? `- ${title} (${url})` : `- ${title}`;
  });
  if (content.data.relevantDocs.length > 5) {
    lines.push(`... ${content.data.relevantDocs.length - 5} more doc(s)`);
  }
  return lines.join('\n');
}

function formatFetchedOmittedOutput(content) {
  if (!content || !Object.prototype.hasOwnProperty.call(content, 'value')) return '';
  if (Array.isArray(content.value)) {
    const lines = content.value.slice(0, 8).map((item) => `- ${previewValue(item && (item.name || item.fullyQualifiedName || item), 160)}`);
    if (content.value.length > 8) {
      lines.push(`... ${content.value.length - 8} more item(s)`);
    }
    return lines.join('\n');
  }

  if (content.value && typeof content.value === 'object') {
    return truncatePreview(JSON.stringify(content.value), 800);
  }

  return previewValue(content.value, 800);
}

function formatToolOutputDetails(toolName, content) {
  if (!content || typeof content !== 'object') return '';

  if (toolName === 'tableSearch') {
    return formatTableSearchOutput(content);
  }

  if (toolName === 'readTable' || (content.data && content.data.tableName)) {
    return formatReadTableOutput(content);
  }

  if (Array.isArray(content.cellResults)) {
    return formatCellResultsOutput(content);
  }

  if (content.data && Array.isArray(content.data.relevantDocs)) {
    return formatDocsOutput(content);
  }

  if (toolName === 'fetchOmittedContent' || Object.prototype.hasOwnProperty.call(content, 'value')) {
    return formatFetchedOmittedOutput(content);
  }

  if (content.result && Array.isArray(content.result.rows) && content.result.rows.length > 0) {
    const sample = content.result.rows.slice(0, 5).map((row) => `- ${previewValue(row, 160)}`);
    if (content.result.rows.length > 5) {
      sample.push(`... ${content.result.rows.length - 5} more row(s)`);
    }
    return sample.join('\n');
  }

  if (Array.isArray(content.data) && content.data.length > 0) {
    const sample = content.data.slice(0, 5).map((row) => `- ${previewValue(row.fullyQualifiedName || row.name || row, 160)}`);
    if (content.data.length > 5) {
      sample.push(`... ${content.data.length - 5} more result(s)`);
    }
    return sample.join('\n');
  }

  if (content.success === true && Object.keys(content).length === 1) return 'success';

  try {
    return truncatePreview(JSON.stringify(content), 800);
  } catch {
    return truncatePreview(String(content), 800);
  }
}

function finalizeAssistantStream(networkState) {
  if (networkState.assistantStreamOpen) {
    process.stdout.write('\n\n');
    networkState.assistantStreamOpen = false;
    networkState.seenAssistantContent = false;
  }
}

function writeDebugNetworkEvent(event) {
  process.stderr.write(`[debug-network] ${JSON.stringify(event)}\n`);
}

function processNetworkEvents(events, networkState, jsonOutput, debugNetwork) {
  for (const event of events) {
    networkState.events.push(event);
    networkState.lastActivityAt = Date.now();

    if (event.type === 'notebook-user') {
      if (!networkState.promptId) {
        networkState.promptId = event.promptId || '';
      }
      continue;
    }

    if (networkState.promptId && event.promptId && event.promptId !== networkState.promptId) {
      continue;
    }

    if (debugNetwork) {
      writeDebugNetworkEvent(event);
    }

    if (event.type === 'completion-main-start') {
      networkState.activeMainRequests.add(event.requestId);
      rememberUniqueValue(networkState.requestedModels, event.requestedModel);
      if (event.requestedModel) {
        networkState.lastRequestedModel = normalizeText(event.requestedModel);
      }
      continue;
    }

    if (event.type === 'completion-aux-start') {
      rememberUniqueValue(networkState.requestedModels, event.requestedModel);
      if (event.requestedModel) {
        networkState.lastRequestedModel = normalizeText(event.requestedModel);
      }
      continue;
    }

    if (event.type === 'completion-model') {
      rememberUniqueValue(networkState.responseModels, event.model);
      if (event.model) {
        networkState.lastResponseModel = normalizeText(event.model);
        if (!jsonOutput) {
          finalizeAssistantStream(networkState);
          printEntry('model', event.model, false);
        }
      }
      continue;
    }

    if (event.type === 'completion-main-text') {
      const text = String(event.text || '');
      if (!text.trim() && !networkState.seenAssistantContent) continue;
      if (!jsonOutput) {
        if (!networkState.assistantStreamOpen) {
          process.stdout.write('[assistant] ');
          networkState.assistantStreamOpen = true;
          networkState.seenAssistantContent = true;
        }
        process.stdout.write(text);
      }
      networkState.finalAssistantText += text;
      continue;
    }

    if (event.type === 'completion-main-finish') {
      continue;
    }

    if (event.type === 'completion-main-end') {
      networkState.activeMainRequests.delete(event.requestId);
      finalizeAssistantStream(networkState);
      continue;
    }

    if (event.type === 'notebook-reasoning') {
      if (!jsonOutput && event.text) {
        finalizeAssistantStream(networkState);
        printEntry('reasoning', event.text, false);
      }
      continue;
    }

    if (event.type === 'notebook-tool-input') {
      if (!jsonOutput) {
        finalizeAssistantStream(networkState);
        const details = event.content ? ` ${event.content}` : '';
        process.stdout.write(`[tool input] ${event.toolName || 'unknown'}${details}\n\n`);
      }
      continue;
    }

    if (event.type === 'notebook-tool-output') {
      if (!jsonOutput) {
        finalizeAssistantStream(networkState);
        const summary = summarizeToolOutput(event.content);
        const details = formatToolOutputDetails(event.toolName || 'unknown', event.content);
        process.stdout.write(`[tool output] ${event.toolName || 'unknown'}${summary ? `: ${summary}` : ''}\n`);
        if (details) {
          process.stdout.write(`${details}\n\n`);
        } else {
          process.stdout.write('\n');
        }
      }
      continue;
    }

    if (event.type === 'notebook-run-cmd') {
      if (!jsonOutput) {
        finalizeAssistantStream(networkState);
        process.stdout.write('[execute] notebook command started\n\n');
      }
      continue;
    }

    if (event.type === 'notebook-assistant-final') {
      networkState.sawFinalAssistant = true;
      networkState.finalAssistantFromNotebook = event.text || '';
      if (!jsonOutput) {
        finalizeAssistantStream(networkState);
        const streamed = normalizeText(networkState.finalAssistantText);
        const persisted = normalizeText(event.text || '');
        if (!streamed || streamed !== persisted) {
          printEntry('assistant', event.text || '', false);
        }
      }
    }
  }
}

async function waitForNetworkStream(page, baselineState, timeoutMs, pollMs, jsonOutput, debugNetwork) {
  const deadline = createDeadline(timeoutMs);
  const settleMs = Math.max(pollMs * 6, 3000);
  const networkState = {
    lastEventId: 0,
    promptId: '',
    activeMainRequests: new Set(),
    requestedModels: [],
    responseModels: [],
    lastRequestedModel: '',
    lastResponseModel: '',
    assistantStreamOpen: false,
    seenAssistantContent: false,
    sawFinalAssistant: false,
    finalAssistantText: '',
    finalAssistantFromNotebook: '',
    events: [],
    lastActivityAt: Date.now(),
    lastUiSignature: uiActivitySignature(baselineState),
    finalUiState: null,
  };

  while (Date.now() < deadline) {
    const events = await getNetworkEvents(page, networkState.lastEventId);
    if (events.length > 0) {
      networkState.lastEventId = events[events.length - 1].id;
      processNetworkEvents(events, networkState, jsonOutput, debugNetwork);
    }

    await maybeApproveCodeExecution(page);

    const uiState = await getUiState(page);
    networkState.finalUiState = uiState;
    const currentUiSignature = uiActivitySignature(uiState);

    if (currentUiSignature !== networkState.lastUiSignature) {
      networkState.lastUiSignature = currentUiSignature;
      networkState.lastActivityAt = Date.now();
    }

    const idleMs = Date.now() - networkState.lastActivityAt;

    if (networkState.sawFinalAssistant && networkState.activeMainRequests.size === 0 && idleMs >= settleMs) {
      finalizeAssistantStream(networkState);
      return networkState;
    }

    if (!uiState.pending && networkState.activeMainRequests.size === 0 && hasNewAssistantContent(baselineState, uiState) && idleMs >= settleMs) {
      finalizeAssistantStream(networkState);
      return networkState;
    }

    await page.waitForTimeout(pollMs);
  }

  finalizeAssistantStream(networkState);

  if (networkState.finalUiState && hasNewAssistantContent(baselineState, networkState.finalUiState)) {
    return networkState;
  }

  throw new Error(`Timed out waiting for Genie network output after ${timeoutMs}ms.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.listProfiles) {
    printProfiles(loadDatabricksProfiles());
    return;
  }

  const workspace = resolveWorkspaceSelection({
    profileName: options.profileName,
    workspaceUrl: options.url,
    stateFile: options.stateFile,
    metadataFile: options.metadataFile,
  });
  const stdinPrompt = readStdin().trim();
  const prompt = options.promptParts.join(' ').trim() || stdinPrompt;

  if (!prompt) {
    printUsage();
    throw new Error('Missing prompt text.');
  }

  let browser;
  let context;

  try {
    const authState = await ensureDatabricksAuthState({
      profileName: workspace.profileName,
      stateFile: workspace.stateFile,
      metadataFile: workspace.metadataFile,
      workspaceUrl: workspace.workspaceUrl,
      timeoutMs: options.setupTimeoutMs,
      log: (message) => process.stderr.write(`[auth] ${message}\n`),
    });
    const activeWorkspaceUrl = authState.workspaceUrl || workspace.workspaceUrl;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ storageState: workspace.stateFile });

    if (options.mode === 'network') {
      await installNetworkCapture(context);
    }

    const page = await context.newPage();

    await page.goto(activeWorkspaceUrl, { waitUntil: 'domcontentloaded', timeout: options.setupTimeoutMs });
    await ensureGenieInput(page, options.setupTimeoutMs);

    let baselineState = await getUiState(page);
    let createdNewChat = false;

    if (options.newChat) {
      const created = await createNewChat(page, baselineState, options.setupTimeoutMs, options.pollMs);
      baselineState = created.state;
      createdNewChat = created.created;
    }

    if (!options.jsonOutput && options.mode === 'network') {
      printEntry('user', prompt, false);
    }

    await submitPrompt(page, prompt);
    const networkState = options.mode === 'network'
      ? await waitForNetworkStream(page, baselineState, options.timeoutMs, options.pollMs, options.jsonOutput, options.debugNetwork)
      : null;
    const finalState = options.mode === 'network'
      ? (networkState && networkState.finalUiState ? networkState.finalUiState : await getUiState(page))
      : await waitForStream(page, baselineState, options.timeoutMs, options.pollMs, options.jsonOutput);
    const usedModel = getUsedModel(networkState);

    await context.storageState({ path: workspace.stateFile });

    if (!options.jsonOutput && options.mode === 'network' && usedModel && (!networkState || networkState.responseModels.length === 0)) {
      printEntry('model', usedModel, false);
    }

    if (options.jsonOutput) {
      console.log(
        JSON.stringify(
          {
            prompt,
            profile: workspace.profileName,
            model: usedModel || null,
            url: finalState.url,
            title: finalState.title,
            threadId: finalState.threadId,
            createdNewChat,
            mode: options.mode,
            entries: finalState.entries,
            assistantMessages: finalState.entries.filter((entry) => entry.role === 'assistant').map((entry) => entry.text),
            userMessages: finalState.entries.filter((entry) => entry.role === 'user').map((entry) => entry.text),
            network: networkState
              ? {
                  model: usedModel || null,
                  requestedModels: networkState.requestedModels,
                  responseModels: networkState.responseModels,
                  promptId: networkState.promptId,
                  finalAssistantText: networkState.finalAssistantText || networkState.finalAssistantFromNotebook,
                  events: networkState.events,
                }
              : null,
            stateFile: workspace.stateFile,
            metadataFile: workspace.metadataFile,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {}
    }
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
