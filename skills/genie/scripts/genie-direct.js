const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { DEFAULT_GENIE_STATE_FILE, ensureDatabricksAuthState } = require('./genie-auth-lib');
const { DEFAULT_SHARED_TEMPLATE_FILE, loadDatabricksProfiles, printProfiles, resolveWorkspaceSelection } = require('./genie-workspace');

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/genie-direct.js --state-file /path/to/state.json --template-file /path/to/template.json "Reply with OK"');
  console.log('  node scripts/genie-direct.js --profile sso_commercial_uat "Reply with OK"');
  console.log('  node scripts/genie-direct.js --json "What is the latest load date?"');
  console.log('  node scripts/genie-direct.js --list-tools');
  console.log('  node scripts/genie-direct.js --list-supported-tools');
  console.log('  node scripts/genie-direct.js --list-profiles');
  console.log('  node scripts/genie-direct.js --session-name project-a --new-session "Start fresh"');
  console.log('');
  console.log('Behavior:');
  console.log('  default: streams parsed Genie events to stdout as they arrive');
  console.log('  --json: prints the final parsed turns, tool calls, and events');
  console.log('  --list-tools: prints Genie-advertised tools from the captured template');
  console.log('  --list-supported-tools: prints advertised tools plus current browserless coverage');
  console.log('  --session-name / --new-session: persist or reset browserless chat state across runs');
  console.log('  default output includes the active session name in a short header');
  console.log('');
  console.log('Defaults:');
  console.log(`  state file: ${DEFAULT_GENIE_STATE_FILE} (or profile-scoped default)`);
  console.log(`  template file: ${DEFAULT_SHARED_TEMPLATE_FILE} (or profile-scoped override if present)`);
  console.log(`  session dir: ${path.join(os.tmpdir(), 'genie-direct-sessions')}`);
}

function parseArgs(argv) {
  const options = {
    profileName: process.env.GENIE_PROFILE || process.env.DATABRICKS_CONFIG_PROFILE || '',
    stateFile: process.env.GENIE_STATE_FILE || '',
    metadataFile: process.env.GENIE_METADATA_FILE || '',
    templateFile: process.env.GENIE_TEMPLATE_FILE || '',
    templateFileExplicit: Boolean(process.env.GENIE_TEMPLATE_FILE),
    jsonOutput: false,
    listTools: false,
    listSupportedTools: false,
    listProfiles: false,
    sessionName: process.env.GENIE_DIRECT_SESSION_NAME || 'default',
    sessionDir: process.env.GENIE_DIRECT_SESSION_DIR || path.join(os.tmpdir(), 'genie-direct-sessions'),
    newSession: false,
    maxToolRounds: Number.parseInt(process.env.GENIE_MAX_TOOL_ROUNDS || '8', 10),
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

    if (arg === '--template-file') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --template-file.');
      options.templateFile = value;
      options.templateFileExplicit = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--template-file=')) {
      options.templateFile = arg.split('=').slice(1).join('=');
      options.templateFileExplicit = true;
      continue;
    }

    if (arg === '--json') {
      options.jsonOutput = true;
      continue;
    }

    if (arg === '--session-name') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --session-name.');
      options.sessionName = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--session-name=')) {
      options.sessionName = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--session-dir') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value after --session-dir.');
      options.sessionDir = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--session-dir=')) {
      options.sessionDir = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--new-session' || arg === '--reset-session') {
      options.newSession = true;
      continue;
    }

    if (arg === '--list-tools') {
      options.listTools = true;
      continue;
    }

    if (arg === '--list-supported-tools') {
      options.listSupportedTools = true;
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

  if (!Number.isFinite(options.maxToolRounds) || options.maxToolRounds <= 0) {
    throw new Error(`Invalid max tool rounds: ${options.maxToolRounds}`);
  }

  return options;
}

function summarizeTemplateTools(templatePayload) {
  const tools = Array.isArray(templatePayload.params && templatePayload.params.tools) ? templatePayload.params.tools : [];
  return tools.map((tool) => ({
    type: tool.type,
    name: tool.function && tool.function.name ? tool.function.name : '',
    description: tool.function && tool.function.description ? tool.function.description : '',
    required: tool.function && tool.function.parameters && Array.isArray(tool.function.parameters.required)
      ? tool.function.parameters.required
      : [],
    properties: tool.function && tool.function.parameters && tool.function.parameters.properties
      ? Object.fromEntries(
          Object.entries(tool.function.parameters.properties).map(([key, value]) => [
            key,
            {
              type: value.type || null,
              enum: value.enum || null,
              description: value.description || '',
            },
          ]),
        )
      : {},
  }));
}

function printToolSummary(tools) {
  console.log(`Genie tools: ${tools.length}`);
  for (const tool of tools) {
    console.log(`- ${tool.name}`);
  }

  const executeCode = tools.find((tool) => tool.name === 'executeCode');
  if (executeCode && executeCode.properties.language && Array.isArray(executeCode.properties.language.enum)) {
    console.log('');
    console.log(`executeCode languages: ${executeCode.properties.language.enum.join(', ')}`);
    console.log('executeCode note: the language enum is finite, but the actual code shapes are open-ended.');
  }
}

function getToolExecutorRegistry() {
  return {
    docSearch: executeDocSearch,
    tableSearch: executeTableSearch,
    readTable: executeReadTable,
    executeCode,
    readSkillFile: executeReadSkillFile,
    searchAssets: executeSearchAssets,
    forYouAssets: executeForYouAssets,
    readAssetById: executeReadAssetById,
    createAsset: executeCreateAsset,
    openAsset: executeOpenAsset,
    recommendDataroom: executeRecommendDataroom,
    askDataroom: executeAskDataroom,
    fetchOmittedContent: executeFetchOmittedContent,
    manageTodoList: executeManageTodoList,
  };
}

function summarizeSupportedTools(templatePayload) {
  const advertisedTools = summarizeTemplateTools(templatePayload);
  const supportedNames = new Set(Object.keys(getToolExecutorRegistry()));

  return {
    advertisedTools,
    implementedToolNames: Array.from(supportedNames).sort(),
    supportedAdvertisedTools: advertisedTools.filter((tool) => supportedNames.has(tool.name)),
    unsupportedAdvertisedTools: advertisedTools.filter((tool) => !supportedNames.has(tool.name)),
  };
}

function printSupportedToolSummary(summary) {
  console.log(`Advertised tools: ${summary.advertisedTools.length}`);
  console.log(`Browserless-supported tools: ${summary.supportedAdvertisedTools.length}`);
  console.log('');

  console.log('Supported now:');
  for (const tool of summary.supportedAdvertisedTools) {
    console.log(`- ${tool.name}`);
  }

  if (summary.unsupportedAdvertisedTools.length > 0) {
    console.log('');
    console.log('Not implemented yet:');
    for (const tool of summary.unsupportedAdvertisedTools) {
      console.log(`- ${tool.name}`);
    }
  }

  const executeCode = summary.advertisedTools.find((tool) => tool.name === 'executeCode');
  if (executeCode && executeCode.properties.language && Array.isArray(executeCode.properties.language.enum)) {
    console.log('');
    console.log(`executeCode languages: ${executeCode.properties.language.enum.join(', ')}`);
    console.log('executeCode semantics remain open-ended; only some code shapes can be auto-executed browserlessly.');
  }
}

function printSessionBanner(sessionName) {
  process.stdout.write(`[session ${sessionName}]\n`);
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  return fs.readFileSync(0, 'utf8');
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function detectWorkspaceUser(stateFile) {
  const state = loadJson(stateFile);
  for (const origin of state.origins || []) {
    for (const item of origin.localStorage || []) {
      const match = String(item.name || '').match(/^global-assistant-notebook-id_v0\.1_user_(.+)_org_/);
      if (match) return match[1];
    }
  }
  return '';
}

function getOrgIdFromWorkspaceUrl(workspaceUrl) {
  try {
    return new URL(workspaceUrl).searchParams.get('o') || '';
  } catch {
    return '';
  }
}

function sanitizeSessionName(name) {
  return String(name || 'default')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'default';
}

function serializeMap(map) {
  return Object.fromEntries(map.entries());
}

function deserializeMap(value) {
  return new Map(Object.entries(value || {}));
}

function resolveSessionFilePath(sessionDir, sessionName, orgId) {
  fs.mkdirSync(sessionDir, { recursive: true });
  return path.join(sessionDir, `${sanitizeSessionName(orgId)}-${sanitizeSessionName(sessionName)}.json`);
}

function loadPersistentSession(sessionFile, resetSession) {
  if (resetSession || !fs.existsSync(sessionFile)) {
    return {
      conversationMessages: [],
      todoList: [],
      toolOutputCache: {},
      assetCacheById: {},
      assetCacheByPath: {},
      genieSpaceCacheById: {},
      sessionId: '',
    };
  }

  const parsed = loadJson(sessionFile);
  return {
    conversationMessages: Array.isArray(parsed.conversationMessages) ? parsed.conversationMessages : [],
    todoList: normalizeTodoItems(parsed.todoList),
    toolOutputCache: parsed.toolOutputCache || {},
    assetCacheById: parsed.assetCacheById || {},
    assetCacheByPath: parsed.assetCacheByPath || {},
    genieSpaceCacheById: parsed.genieSpaceCacheById || {},
    sessionId: parsed.sessionId || '',
  };
}

function savePersistentSession(sessionFile, context, conversationMessages) {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    sessionId: context.sessionId,
    conversationMessages,
    todoList: context.todoList || [],
    toolOutputCache: serializeMap(context.toolOutputCache),
    assetCacheById: serializeMap(context.assetCacheById),
    assetCacheByPath: serializeMap(context.assetCacheByPath),
    genieSpaceCacheById: serializeMap(context.genieSpaceCacheById),
  };
  fs.writeFileSync(sessionFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function loadTemplatePayload(templateFile) {
  const raw = loadJson(templateFile);

  if (raw && raw.requests && raw.requests[0] && raw.requests[0].request && raw.requests[0].request.postData) {
    return {
      url: raw.requests[0].request.url,
      headers: raw.requests[0].request.headers || {},
      payload: JSON.parse(raw.requests[0].request.postData),
    };
  }

  if (raw && raw.url && raw.payload) {
    return raw;
  }

  throw new Error(`Unsupported template format in ${templateFile}`);
}

function loadCookies(stateFile, targetHost) {
  const state = loadJson(stateFile);
  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  const pairs = cookies
    .filter((cookie) => String(cookie.domain || '').includes(targetHost))
    .map((cookie) => `${cookie.name}=${cookie.value}`);

  if (pairs.length === 0) {
    throw new Error(`No ${targetHost} cookies found in ${stateFile}`);
  }

  return pairs.join('; ');
}

async function requestText(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    response,
    text,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

async function getSessionInfo(origin, headers) {
  const { response, text } = await requestText(`${origin}/auth/session/info`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch session info (${response.status}): ${text.slice(0, 1000)}`);
  }

  return JSON.parse(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function cloneJson(value) {
  return value == null ? value : structuredClone(value);
}

function stripTopLevelToolCallId(value) {
  if (!isPlainObject(value)) return value;
  const copy = { ...value };
  delete copy.__toolCallId;
  delete copy.__wasCompacted;
  delete copy.__compactionMessage;
  return copy;
}

function compactValueForToolCache(value, path, limits) {
  const appendPropPath = (base, key) => (base === '.' ? `.${key}` : `${base}.${key}`);
  const appendIndexPath = (base, index) => `${base}[${index}]`;

  if (typeof value === 'string') {
    if (value.length <= limits.maxChars) return { value, compacted: false };
    return {
      value: {
        __more: {
          path: `${path}[${limits.maxChars}:]`,
          value: value.slice(0, limits.maxChars),
          chars: limits.maxChars,
        },
      },
      compacted: true,
    };
  }

  if (Array.isArray(value)) {
    let compacted = false;
    const items = value.slice(0, limits.maxItems).map((item, index) => {
      const nested = compactValueForToolCache(item, appendIndexPath(path, index), limits);
      compacted ||= nested.compacted;
      return nested.value;
    });

    if (value.length > limits.maxItems) {
      items.push({
        __more: {
          path: `${path}[${limits.maxItems}:]`,
          count: limits.maxItems,
        },
      });
      compacted = true;
    }

    return { value: items, compacted };
  }

  if (isPlainObject(value)) {
    let compacted = false;
    const out = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const nested = compactValueForToolCache(nestedValue, appendPropPath(path, key), limits);
      compacted ||= nested.compacted;
      out[key] = nested.value;
    }
    return { value: out, compacted };
  }

  return { value, compacted: false };
}

function prepareToolOutput(toolCallId, rawOutput, context) {
  const sanitized = stripTopLevelToolCallId(cloneJson(rawOutput));
  context.toolOutputCache.set(toolCallId, sanitized);

  const compacted = compactValueForToolCache(sanitized, '.', {
    maxItems: 8,
    maxChars: 4000,
  });

  if (isPlainObject(compacted.value)) {
    return {
      __toolCallId: toolCallId,
      ...(compacted.compacted
        ? {
            __wasCompacted: true,
            __compactionMessage:
              'Results were compacted. Look for __more placeholders - use fetchOmittedContent to retrieve omitted data.',
          }
        : {}),
      ...compacted.value,
    };
  }

  return {
    __toolCallId: toolCallId,
    ...(compacted.compacted
      ? {
          __wasCompacted: true,
          __compactionMessage:
            'Results were compacted. Look for __more placeholders - use fetchOmittedContent to retrieve omitted data.',
        }
      : {}),
    data: compacted.value,
  };
}

function parsePathExpression(path) {
  if (!path || path[0] !== '.') {
    throw new Error(`Unsupported path: ${path}`);
  }

  const tokens = [];
  let index = 1;
  while (index < path.length) {
    if (path[index] === '.') {
      index += 1;
      const match = path.slice(index).match(/^[A-Za-z0-9_]+/);
      if (!match) throw new Error(`Invalid property access in path: ${path}`);
      tokens.push({ type: 'prop', key: match[0] });
      index += match[0].length;
      continue;
    }

    if (path[index] === '[') {
      const end = path.indexOf(']', index);
      if (end === -1) throw new Error(`Unclosed bracket in path: ${path}`);
      const inner = path.slice(index + 1, end);
      if (inner.includes(':')) {
        const [startRaw, endRaw] = inner.split(':');
        tokens.push({
          type: 'slice',
          start: startRaw === '' ? null : Number.parseInt(startRaw, 10),
          end: endRaw === '' ? null : Number.parseInt(endRaw, 10),
        });
      } else {
        tokens.push({ type: 'index', index: Number.parseInt(inner, 10) });
      }
      index = end + 1;
      continue;
    }

    const match = path.slice(index).match(/^[A-Za-z0-9_]+/);
    if (match) {
      tokens.push({ type: 'prop', key: match[0] });
      index += match[0].length;
      continue;
    }

    throw new Error(`Unsupported token in path: ${path}`);
  }

  return tokens;
}

function evaluateCachedPath(rootValue, path) {
  if (path === '.') {
    return { value: rootValue, sliceInfo: null };
  }

  let current = rootValue;
  let sliceInfo = null;

  for (const token of parsePathExpression(path)) {
    if (token.type === 'prop') {
      current = current == null ? undefined : current[token.key];
      continue;
    }

    if (token.type === 'index') {
      current = Array.isArray(current) ? current[token.index] : undefined;
      continue;
    }

    if (token.type === 'slice') {
      if (typeof current === 'string' || Array.isArray(current)) {
        const totalLength = current.length;
        const start = token.start == null ? 0 : token.start;
        const end = token.end == null ? totalLength : token.end;
        current = current.slice(start, end);
        sliceInfo = {
          start,
          end: Math.min(end, totalLength),
          totalLength,
          hasMore: (token.end == null ? totalLength : end) < totalLength,
        };
        continue;
      }

      throw new Error(`Slice used on non-sliceable value for path: ${path}`);
    }
  }

  return { value: current, sliceInfo };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSearchTerms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length >= 2);
}

function countTermMatches(text, terms) {
  const haystack = String(text || '').toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function safeSlug(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

async function loadDocsUrls(context) {
  if (Array.isArray(context.docsUrls)) return context.docsUrls;

  const { response, text } = await requestText('https://docs.databricks.com/sitemap.xml', {
    method: 'GET',
    headers: { 'user-agent': 'Mozilla/5.0' },
  });

  if (!response.ok) {
    throw new Error(`docSearch sitemap fetch failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  const urls = Array.from(text.matchAll(/<loc>(.*?)<\/loc>/g))
    .map((match) => match[1])
    .filter((url) => /docs\.databricks\.com\/(aws|azure|gcp|sap)\/en\//.test(url));

  context.docsUrls = urls;
  return urls;
}

function buildDocSnippet(text, terms) {
  const plain = stripHtml(text);
  if (!plain) return '';
  const lower = plain.toLowerCase();
  let index = -1;
  for (const term of terms) {
    index = lower.indexOf(term);
    if (index !== -1) break;
  }
  if (index === -1) return plain.slice(0, 220);
  const start = Math.max(0, index - 80);
  const end = Math.min(plain.length, index + 220);
  return plain.slice(start, end).trim();
}

async function fetchDocSummary(url, terms, context) {
  if (context.docPageCache.has(url)) {
    return context.docPageCache.get(url);
  }

  const { response, text } = await requestText(url, {
    method: 'GET',
    headers: { 'user-agent': 'Mozilla/5.0' },
  });

  if (!response.ok) {
    const fallback = {
      url,
      title: pathBasename(safeSlug(url)) || url,
      description: '',
      snippet: '',
      score: countTermMatches(safeSlug(url), terms),
    };
    context.docPageCache.set(url, fallback);
    return fallback;
  }

  const titleMatch = text.match(/<title[^>]*>(.*?)<\/title>/i);
  const descriptionMatch = text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const title = stripHtml(titleMatch ? titleMatch[1] : url);
  const description = stripHtml(descriptionMatch ? descriptionMatch[1] : '');
  const snippet = buildDocSnippet(text, terms);
  const score = countTermMatches(`${safeSlug(url)} ${title} ${description} ${snippet}`, terms);

  const summary = { url, title, description, snippet, score };
  context.docPageCache.set(url, summary);
  return summary;
}

async function executeDocSearch(toolCall, args, context) {
  const terms = splitSearchTerms(args.searchQuery);
  const urls = await loadDocsUrls(context);

  const rankedUrls = urls
    .map((url) => ({ url, score: countTermMatches(safeSlug(url), terms) }))
    .filter((item) => item.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((item) => item.url);

  const summaries = await Promise.all(rankedUrls.map((url) => fetchDocSummary(url, terms, context)));
  const results = summaries
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ score, ...rest }) => rest);

  return {
    success: true,
    searchQuery: args.searchQuery || '',
    results,
  };
}

async function listSqlWarehouses(context) {
  if (Array.isArray(context.sqlWarehouses)) return context.sqlWarehouses;

  const { response, text } = await requestText(`${context.origin}/ajax-api/2.0/sql/warehouses`, {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`warehouse list failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  const parsed = JSON.parse(text);
  context.sqlWarehouses = Array.isArray(parsed.warehouses) ? parsed.warehouses : [];
  return context.sqlWarehouses;
}

async function ensureDefaultWarehouseId(context) {
  if (context.defaultWarehouseId) return context.defaultWarehouseId;
  const warehouses = await listSqlWarehouses(context);
  const preferred = warehouses.find((warehouse) => warehouse.auto_resume) || warehouses[0];
  if (!preferred) {
    throw new Error('No SQL warehouse available for browserless executeCode.');
  }
  context.defaultWarehouseId = preferred.id;
  return context.defaultWarehouseId;
}

function isReadOnlySql(sql) {
  return /^(select|with|show|describe|explain|values)\b/i.test(String(sql || '').trim());
}

async function fetchStatementChunk(statementId, chunkIndex, context) {
  const url = `${context.origin}/ajax-api/2.0/sql/statements/${encodeURIComponent(statementId)}/result/chunks/${chunkIndex}`;
  const { response, text } = await requestText(url, {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`statement chunk fetch failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  return JSON.parse(text);
}

function rowsFromStatementResult(manifest, initialResult, extraChunks) {
  const columnNames = ((manifest && manifest.schema && manifest.schema.columns) || []).map((column) => column.name);
  const chunks = [initialResult, ...extraChunks].filter(Boolean);
  const rows = [];
  for (const chunk of chunks) {
    for (const row of chunk.data_array || []) {
      const obj = {};
      columnNames.forEach((name, index) => {
        obj[name] = row[index];
      });
      rows.push(obj);
    }
  }
  return rows;
}

async function executeSqlStatement(sql, context) {
  if (!isReadOnlySql(sql)) {
    throw new Error(`Browserless executeCode only supports read-only SQL, got: ${sql}`);
  }

  const warehouseId = await ensureDefaultWarehouseId(context);
  const payload = {
    statement: sql,
    warehouse_id: warehouseId,
    wait_timeout: '30s',
  };
  const { response, text } = await requestText(`${context.origin}/ajax-api/2.0/sql/statements`, {
    method: 'POST',
    headers: { ...context.ajaxHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`statement execute failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  let parsed = JSON.parse(text);
  let state = parsed.status && parsed.status.state;
  while (state && !['SUCCEEDED', 'FAILED', 'CANCELED', 'CLOSED'].includes(state)) {
    await sleep(1000);
    const followUp = await requestText(`${context.origin}/ajax-api/2.0/sql/statements/${encodeURIComponent(parsed.statement_id)}`, {
      method: 'GET',
      headers: context.ajaxHeaders,
    });
    if (!followUp.response.ok) {
      throw new Error(`statement status failed (${followUp.response.status}): ${followUp.text.slice(0, 1000)}`);
    }
    parsed = JSON.parse(followUp.text);
    state = parsed.status && parsed.status.state;
  }

  if (state !== 'SUCCEEDED') {
    throw new Error(`statement did not succeed (state=${state || 'unknown'})`);
  }

  const manifest = parsed.manifest || { schema: { columns: [] }, chunks: [] };
  const extraChunks = [];
  const totalChunks = manifest.total_chunk_count || ((manifest.chunks && manifest.chunks.length) || 1);
  for (let chunkIndex = 1; chunkIndex < totalChunks; chunkIndex += 1) {
    extraChunks.push(await fetchStatementChunk(parsed.statement_id, chunkIndex, context));
  }

  return {
    statementId: parsed.statement_id,
    warehouseId,
    manifest,
    rows: rowsFromStatementResult(manifest, parsed.result, extraChunks),
  };
}

function extractSparkSqlStatements(code) {
  const text = String(code || '');
  const statements = [];
  const patterns = [
    /spark\.sql\(\s*"""([\s\S]*?)"""\s*\)/g,
    /spark\.sql\(\s*'''([\s\S]*?)'''\s*\)/g,
    /spark\.sql\(\s*"([\s\S]*?)"\s*\)/g,
    /spark\.sql\(\s*'([\s\S]*?)'\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      statements.push(match[1]);
      match = pattern.exec(text);
    }
  }
  return statements;
}

function stripWrappingParens(text) {
  let value = String(text || '').trim();
  while (value.startsWith('(') && value.endsWith(')')) {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < value.length; i += 1) {
      const char = value[i];
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (depth === 0 && i < value.length - 1) {
        balanced = false;
        break;
      }
    }
    if (!balanced) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function splitTopLevelArguments(text) {
  const out = [];
  let current = '';
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (const char of String(text || '')) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) out.push(current.trim());
  return out;
}

function parseNamedArguments(text) {
  const positional = [];
  const named = {};

  for (const part of splitTopLevelArguments(text)) {
    const match = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/);
    if (match) {
      named[match[1]] = match[2].trim();
    } else {
      positional.push(part);
    }
  }

  return { positional, named };
}

function unquotePythonString(text) {
  const value = String(text || '').trim();
  const triple = value.match(/^(["']{3})([\s\S]*)\1$/);
  if (triple) return triple[2];
  const single = value.match(/^(["'])([\s\S]*)\1$/);
  if (!single) return null;
  return single[2]
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

function quoteSqlIdentifier(name) {
  return String(name || '')
    .split('.')
    .map((part) => `\`${part.replace(/`/g, '``')}\``)
    .join('.');
}

function parseStringList(text) {
  const trimmed = String(text || '').trim();
  const body = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return splitTopLevelArguments(body)
    .map((item) => unquotePythonString(item) || item.trim())
    .filter(Boolean);
}

function normalizeSelectExpression(token) {
  const trimmed = stripWrappingParens(token);
  const stringValue = unquotePythonString(trimmed);
  if (stringValue != null) return quoteSqlIdentifier(stringValue);

  if (/^F\.(count|min|max|sum|avg|mean)\(/.test(trimmed)) {
    return normalizeAggExpression(trimmed);
  }

  let match = trimmed.match(/^F\.col\((['"])(.*?)\1\)(?:\.alias\((['"])(.*?)\3\))?$/);
  if (match) {
    return `${quoteSqlIdentifier(match[2])}${match[4] ? ` AS ${quoteSqlIdentifier(match[4])}` : ''}`;
  }

  match = trimmed.match(/^col\((['"])(.*?)\1\)(?:\.alias\((['"])(.*?)\3\))?$/);
  if (match) {
    return `${quoteSqlIdentifier(match[2])}${match[4] ? ` AS ${quoteSqlIdentifier(match[4])}` : ''}`;
  }

  return trimmed;
}

function normalizeFilterExpression(token) {
  const stringValue = unquotePythonString(token);
  return stringValue != null ? stringValue : token.trim();
}

function normalizeOrderExpression(token) {
  const trimmed = stripWrappingParens(token);
  const stringValue = unquotePythonString(trimmed);
  if (stringValue != null) return `${quoteSqlIdentifier(stringValue)} ASC`;

  let match = trimmed.match(/^F\.col\((['"])(.*?)\1\)\.(desc|asc)\(\)$/);
  if (match) {
    return `${quoteSqlIdentifier(match[2])} ${match[3].toUpperCase()}`;
  }

  match = trimmed.match(/^col\((['"])(.*?)\1\)\.(desc|asc)\(\)$/);
  if (match) {
    return `${quoteSqlIdentifier(match[2])} ${match[3].toUpperCase()}`;
  }

  return `${trimmed} ASC`;
}

function normalizeAggExpression(token) {
  const trimmed = stripWrappingParens(token);
  const match = trimmed.match(/^F\.(count|min|max|sum|avg|mean)\((.*?)\)(?:\.alias\((['"])(.*?)\3\))?$/);
  if (match) {
    const fn = match[1] === 'mean' ? 'AVG' : match[1].toUpperCase();
    const rawArg = match[2].trim();
    const argValue = unquotePythonString(rawArg);
    const sqlArg = argValue == null ? rawArg : argValue === '*' ? '*' : quoteSqlIdentifier(argValue);
    const alias = match[4] ? ` AS ${quoteSqlIdentifier(match[4])}` : '';
    return `${fn}(${sqlArg})${alias}`;
  }

  return trimmed;
}

function createPipeline(sql) {
  return {
    sql,
    pendingGroupBy: null,
  };
}

function clonePipeline(pipeline) {
  return structuredClone(pipeline);
}

function scanCall(source, startIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = startIndex; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return {
          args: source.slice(startIndex + 1, i),
          endIndex: i + 1,
        };
      }
    }
  }

  return null;
}

function applyPipelineMethod(pipeline, methodName, argsText) {
  const next = clonePipeline(pipeline);
  const { positional, named } = parseNamedArguments(argsText);

  if (methodName === 'select') {
    const selections = positional.map((token) => normalizeSelectExpression(token));
    next.sql = `SELECT ${selections.join(', ')} FROM (${next.sql}) AS t`;
    next.pendingGroupBy = null;
    return next;
  }

  if (methodName === 'selectExpr') {
    const selections = positional.map((token) => unquotePythonString(token) || token.trim());
    next.sql = `SELECT ${selections.join(', ')} FROM (${next.sql}) AS t`;
    next.pendingGroupBy = null;
    return next;
  }

  if (methodName === 'filter' || methodName === 'where') {
    if (positional.length === 0) return next;
    next.sql = `SELECT * FROM (${next.sql}) AS t WHERE ${normalizeFilterExpression(positional[0])}`;
    next.pendingGroupBy = null;
    return next;
  }

  if (methodName === 'limit') {
    const limitValue = Number.parseInt(positional[0], 10);
    next.sql = `SELECT * FROM (${next.sql}) AS t LIMIT ${Number.isFinite(limitValue) ? limitValue : 0}`;
    next.pendingGroupBy = null;
    return next;
  }

  if (methodName === 'orderBy' || methodName === 'sort') {
    const orderExpressions = positional.map((token) => normalizeOrderExpression(token));
    if (named.ascending === 'False' || named.ascending === 'false') {
      for (let i = 0; i < orderExpressions.length; i += 1) {
        orderExpressions[i] = orderExpressions[i].replace(/ ASC$/, ' DESC');
      }
    }
    next.sql = `SELECT * FROM (${next.sql}) AS t ORDER BY ${orderExpressions.join(', ')}`;
    next.pendingGroupBy = null;
    return next;
  }

  if (methodName === 'distinct') {
    next.sql = `SELECT DISTINCT * FROM (${next.sql}) AS t`;
    next.pendingGroupBy = null;
    return next;
  }

  if (methodName === 'dropDuplicates' || methodName === 'drop_duplicates') {
    if (positional.length === 0) {
      next.sql = `SELECT DISTINCT * FROM (${next.sql}) AS t`;
      next.pendingGroupBy = null;
      return next;
    }
    const dedupeColumns = parseStringList(positional[0]).map((column) => quoteSqlIdentifier(column));
    const orderClause = dedupeColumns.length > 0 ? dedupeColumns.join(', ') : '1';
    next.sql = `SELECT * FROM (${next.sql}) AS t QUALIFY ROW_NUMBER() OVER (PARTITION BY ${dedupeColumns.join(', ')} ORDER BY ${orderClause}) = 1`;
    next.pendingGroupBy = null;
    return next;
  }

  if (methodName === 'groupBy' || methodName === 'groupby') {
    next.pendingGroupBy = positional.map((token) => {
      const value = unquotePythonString(token);
      return value == null ? token.trim() : quoteSqlIdentifier(value);
    });
    return next;
  }

  if (methodName === 'agg') {
    const aggregations = positional.map((token) => normalizeAggExpression(token));
    const groupBy = Array.isArray(next.pendingGroupBy) ? next.pendingGroupBy : [];
    const selectList = [...groupBy, ...aggregations].join(', ');
    next.sql = `SELECT ${selectList} FROM (${next.sql}) AS t${groupBy.length > 0 ? ` GROUP BY ${groupBy.join(', ')}` : ''}`;
    next.pendingGroupBy = null;
    return next;
  }

  if (methodName === 'count') {
    const groupBy = Array.isArray(next.pendingGroupBy) ? next.pendingGroupBy : [];
    if (groupBy.length > 0) {
      next.sql = `SELECT ${groupBy.join(', ')}, COUNT(*) AS count FROM (${next.sql}) AS t GROUP BY ${groupBy.join(', ')}`;
    } else {
      next.sql = `SELECT COUNT(*) AS count FROM (${next.sql}) AS t`;
    }
    next.pendingGroupBy = null;
    return next;
  }

  if (methodName === 'first' || methodName === 'head') {
    const limitValue = positional.length > 0 ? Number.parseInt(positional[0], 10) : 1;
    next.sql = `SELECT * FROM (${next.sql}) AS t LIMIT ${Number.isFinite(limitValue) ? limitValue : 1}`;
    next.pendingGroupBy = null;
    return next;
  }

  if (methodName === 'alias' || methodName === 'cache' || methodName === 'persist' || methodName === 'unpersist' || methodName === 'show' || methodName === 'collect' || methodName === 'toPandas') {
    return next;
  }

  throw new Error(`Unsupported DataFrame method: ${methodName}`);
}

function parseChainedExpression(expression, env) {
  const source = stripWrappingParens(expression);
  let pipeline = null;
  let index = 0;
  const prefixes = ['spark.read.table', 'spark.table', 'spark.sql'];

  for (const prefix of prefixes) {
    if (source.startsWith(`${prefix}(`)) {
      const scanned = scanCall(source, prefix.length);
      if (!scanned) return null;
      if (prefix === 'spark.sql') {
        const sql = unquotePythonString(scanned.args);
        if (sql == null) return null;
        pipeline = createPipeline(sql.trim());
      } else {
        const tableName = unquotePythonString(scanned.args);
        if (tableName == null) return null;
        pipeline = createPipeline(`SELECT * FROM ${tableName}`);
      }
      index = scanned.endIndex;
      break;
    }
  }

  if (!pipeline) {
    const variableMatch = source.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (!variableMatch || !env[variableMatch[1]]) return null;
    pipeline = clonePipeline(env[variableMatch[1]]);
    index = variableMatch[1].length;
  }

  while (index < source.length) {
    while (source[index] === ' ') index += 1;
    if (index >= source.length) break;
    if (source[index] !== '.') return null;
    index += 1;
    const methodMatch = source.slice(index).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (!methodMatch) return null;
    const methodName = methodMatch[1];
    index += methodName.length;
    while (source[index] === ' ') index += 1;
    if (source[index] !== '(') return null;
    const scanned = scanCall(source, index);
    if (!scanned) return null;
    pipeline = applyPipelineMethod(pipeline, methodName, scanned.args);
    index = scanned.endIndex;
  }

  return pipeline;
}

function extractPythonLogicalStatements(code) {
  const lines = String(code || '').split(/\r?\n/);
  const statements = [];
  let current = '';
  let depth = 0;
  let quote = null;
  let escaped = false;

  const consume = (line) => {
    for (const char of line) {
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }

      if (char === '(' || char === '[' || char === '{') depth += 1;
      if (char === ')' || char === ']' || char === '}') depth -= 1;
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('from ') || trimmed.startsWith('import ')) {
      continue;
    }

    current = current ? `${current} ${trimmed}` : trimmed;
    consume(trimmed);
    if (depth <= 0 && !trimmed.endsWith('\\')) {
      statements.push(current.trim());
      current = '';
    }
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

function translatePythonDataFrameCodeToSql(code) {
  const statements = extractPythonLogicalStatements(code);
  const env = {};
  let lastPipeline = null;

  for (const statement of statements) {
    const assignmentMatch = statement.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/);
    if (assignmentMatch) {
      let pipeline = null;
      try {
        pipeline = parseChainedExpression(assignmentMatch[2], env);
      } catch {
        pipeline = null;
      }
      if (!pipeline) continue;
      env[assignmentMatch[1]] = pipeline;
      lastPipeline = pipeline;
      continue;
    }

    const displayMatch = statement.match(/^display\((.*)\)$/);
    if (displayMatch) {
      let pipeline = null;
      try {
        pipeline = parseChainedExpression(displayMatch[1], env);
      } catch {
        pipeline = null;
      }
      if (pipeline) return pipeline.sql;
      continue;
    }

    const showMatch = statement.match(/^([A-Za-z_][A-Za-z0-9_]*)\.show\((.*)\)$/);
    if (showMatch && env[showMatch[1]]) {
      return env[showMatch[1]].sql;
    }
  }

  return lastPipeline ? lastPipeline.sql : null;
}

function normalizeTodoItems(todoList) {
  return Array.isArray(todoList)
    ? todoList.map((item) => ({
        content:
          item.content ||
          item.text ||
          [item.title, item.description].filter(Boolean).join(' - ') ||
          '',
        status: item.status || 'pending',
        priority: item.priority || 'medium',
      }))
    : [];
}

async function executeManageTodoList(toolCall, args, context) {
  const operation = args.operation || 'read';
  if (operation === 'write') {
    context.todoList = normalizeTodoItems(args.todoList);
    return {
      success: true,
      operation,
      todoList: context.todoList,
    };
  }

  if (operation === 'read') {
    return {
      success: true,
      operation,
      todoList: context.todoList || [],
    };
  }

  throw new Error(`Unsupported manageTodoList operation: ${operation}`);
}

function createParsedResult() {
  return {
    text: '',
    finishReason: null,
    reasoning: '',
    reasoningSignature: '',
    toolCalls: [],
    events: [],
    assistantMessage: {
      role: 'assistant',
      content: [],
    },
  };
}

function ensureToolCall(result, index) {
  if (!result.toolCalls[index]) {
    result.toolCalls[index] = {
      id: '',
      type: '',
      function: {
        name: '',
        arguments: '',
      },
    };
  }
  return result.toolCalls[index];
}

function ensureLineBreak(outputState) {
  if (!outputState.streamToStdout || outputState.lastEndedWithNewline) return;
  process.stdout.write('\n');
  outputState.lastEndedWithNewline = true;
}

function streamEvent(event, outputState, result) {
  if (!outputState.streamToStdout) return;

  if (event.type === 'text') {
    process.stdout.write(event.text);
    outputState.lastEndedWithNewline = event.text.endsWith('\n');
    return;
  }

  ensureLineBreak(outputState);

  if (event.type === 'reasoning') {
    process.stdout.write(`[reasoning] ${event.text}\n`);
    outputState.lastEndedWithNewline = true;
    return;
  }

  if (event.type === 'tool_call_delta') {
    const toolCall = ensureToolCall(result, event.index);
    const name = toolCall.function.name || 'unknown';

    if (!outputState.toolHeadersPrinted.has(event.index) && (toolCall.function.name || event.argumentsDelta || event.idDelta)) {
      process.stdout.write(`[tool_call ${event.index}:${name}] `);
      outputState.toolHeadersPrinted.add(event.index);
      outputState.lastEndedWithNewline = false;
    }

    if (event.argumentsDelta) {
      process.stdout.write(event.argumentsDelta);
      outputState.lastEndedWithNewline = event.argumentsDelta.endsWith('\n');
    }

    return;
  }

  if (event.type === 'finish') {
    if (outputState.toolHeadersPrinted.size > 0) {
      ensureLineBreak(outputState);
    }
    if (event.reason && event.reason !== 'stop') {
      process.stdout.write(`[finish_reason] ${event.reason}\n`);
      outputState.lastEndedWithNewline = true;
    }
  }
}

function normalizeStreamedStdout(text, sessionName) {
  const value = String(text || '');
  if (!sessionName) return value;
  const expectedSuffix = `[session ${sessionName}]\n`;
  if (!value.endsWith(expectedSuffix)) return value;
  return expectedSuffix + value.slice(0, -expectedSuffix.length);
}

function applyStreamingPayload(payloadText, result, outputState) {
  if (!payloadText || payloadText === '[DONE]') return;

  let parsed;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return;
  }

  const choice = parsed.choices && parsed.choices[0];
  const delta = choice && choice.delta;

  if (choice && choice.finish_reason) {
    result.finishReason = choice.finish_reason;
    const event = { type: 'finish', reason: choice.finish_reason };
    result.events.push(event);
    streamEvent(event, outputState, result);
  }

  if (delta && typeof delta.content === 'string') {
    result.text += delta.content;
    const event = { type: 'text', text: delta.content };
    result.events.push(event);
    streamEvent(event, outputState, result);
  }

  if (delta && Array.isArray(delta.content)) {
    for (const item of delta.content) {
      if (item && item.type === 'reasoning' && Array.isArray(item.summary)) {
        for (const summary of item.summary) {
          if (!summary || typeof summary.text !== 'string') continue;
          result.reasoning += summary.text;
          if (summary.signature) {
            result.reasoningSignature = summary.signature;
          }
          const event = {
            type: 'reasoning',
            text: summary.text,
            signature: summary.signature || '',
          };
          result.events.push(event);
          streamEvent(event, outputState, result);
        }
      }
    }
  }

  if (delta && Array.isArray(delta.tool_calls)) {
    for (const chunk of delta.tool_calls) {
      const index = Number.isInteger(chunk.index) ? chunk.index : 0;
      const toolCall = ensureToolCall(result, index);
      const event = {
        type: 'tool_call_delta',
        index,
        idDelta: chunk.id || '',
        toolType: chunk.type || '',
        nameDelta: chunk.function && chunk.function.name ? chunk.function.name : '',
        argumentsDelta: chunk.function && chunk.function.arguments ? chunk.function.arguments : '',
      };

      if (event.idDelta) toolCall.id += event.idDelta;
      if (event.toolType) toolCall.type = event.toolType;
      if (event.nameDelta) toolCall.function.name += event.nameDelta;
      if (event.argumentsDelta) toolCall.function.arguments += event.argumentsDelta;

      result.events.push(event);
      streamEvent(event, outputState, result);
    }
  }
}

function finalizeAssistantMessage(result) {
  const content = [];

  if (result.reasoning || result.reasoningSignature) {
    content.push({
      type: 'reasoning',
      summary: [
        {
          type: 'summary_text',
          text: result.reasoning,
          signature: result.reasoningSignature,
        },
      ],
    });
  }

  if (result.text) {
    content.push({
      type: 'text',
      text: result.text,
      cache_control: {
        type: 'ephemeral',
      },
    });
  }

  result.assistantMessage = {
    role: 'assistant',
    content,
  };

  if (result.toolCalls.length > 0) {
    result.assistantMessage.tool_calls = result.toolCalls.map((toolCall) => structuredClone(toolCall));
  }
}

async function postCompletionStream(url, headers, body, options) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const result = createParsedResult();
  const outputState = {
    streamToStdout: !options.jsonOutput,
    lastEndedWithNewline: true,
    toolHeadersPrinted: new Set(),
  };
  let rawText = '';

  if (!response.body) {
    const text = await response.text();
    rawText = text;
    for (const line of String(text).split('\n')) {
      if (!line.startsWith('data:')) continue;
      applyStreamingPayload(line.slice(5).trimStart(), result, outputState);
    }
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines = [];

    const flushEvent = () => {
      if (dataLines.length === 0) return;
      const payloadText = dataLines.join('\n');
      dataLines = [];
      applyStreamingPayload(payloadText, result, outputState);
    };

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;

      const decoded = decoder.decode(chunk.value, { stream: true });
      rawText += decoded;
      buffer += decoded;

      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) break;

        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          flushEvent();
          continue;
        }

        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }

    const finalDecoded = decoder.decode();
    rawText += finalDecoded;
    buffer += finalDecoded;

    if (buffer) {
      const remainingLines = buffer.split('\n');
      for (const rawLine of remainingLines) {
        let line = rawLine;
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          flushEvent();
          continue;
        }

        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }

    flushEvent();
  }

  finalizeAssistantMessage(result);

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    rawText,
    parsed: result,
  };
}

function buildTableSearchQueryText(args) {
  const terms = [];

  if (Array.isArray(args.keywords)) {
    for (const keyword of args.keywords) {
      if (keyword) terms.push(String(keyword).trim());
    }
  }

  if (args.dataSchema) terms.push(String(args.dataSchema).trim());

  const queryText = terms.filter(Boolean).join(' ').trim();
  if (queryText) return queryText;

  return String(args.searchQuery || '').trim();
}

function normalizeColumn(column) {
  return {
    name: column.name,
    comments: column.comment || column.comments || null,
    typeText: column.type_text || column.typeText || null,
    nullable: typeof column.nullable === 'boolean' ? column.nullable : null,
  };
}

function normalizeUcTable(item) {
  const catalogName = item.catalog_name || item.catalogName || '';
  const schemaName = item.schema_name || item.schemaName || '';
  const tableName = item.name || item.table_name || item.tableName || '';
    const fullyQualifiedName = [catalogName, schemaName, tableName].filter(Boolean).join('.');

    return {
      fullyQualifiedName,
      catalogName,
      schemaName,
      tableName,
      description: item.comment || item.description || null,
      columns: Array.isArray(item.columns)
        ? item.columns.map((column) => normalizeColumn(column))
        : [],
      tableType: item.table_type || item.tableType || null,
      dataSourceFormat: item.data_source_format || item.dataSourceFormat || null,
      id: item.table_id || item.id || null,
    };
}

function simplifySearchResults(results) {
  return results.map((item) => normalizeUcTable(item));
}

function matchesKeywords(table, keywords) {
  if (!keywords || keywords.length === 0) return true;

  const haystack = [
    table.fullyQualifiedName,
    table.tableName,
    table.description,
    ...table.columns.map((column) => `${column.name} ${column.comments || ''}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return keywords.some((keyword) => haystack.includes(String(keyword).toLowerCase()));
}

async function listUnityCatalogs(context) {
  if (Array.isArray(context.unityCatalogs)) return context.unityCatalogs;

  const { response, text } = await requestText(`${context.origin}/ajax-api/2.1/unity-catalog/catalogs`, {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`catalog list failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  const parsed = JSON.parse(text);
  context.unityCatalogs = Array.isArray(parsed.catalogs) ? parsed.catalogs : [];
  return context.unityCatalogs;
}

async function listUnitySchemas(catalogName, context) {
  if (context.unitySchemasByCatalog.has(catalogName)) {
    return context.unitySchemasByCatalog.get(catalogName);
  }

  const url = new URL(`${context.origin}/ajax-api/2.1/unity-catalog/schemas`);
  url.searchParams.set('catalog_name', catalogName);

  const { response, text } = await requestText(url.toString(), {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`schema list failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  const parsed = JSON.parse(text);
  const schemas = Array.isArray(parsed.schemas) ? parsed.schemas : [];
  context.unitySchemasByCatalog.set(catalogName, schemas);
  return schemas;
}

function buildTableSearchTerms(args, queryText) {
  const keywordTerms = Array.isArray(args.keywords)
    ? args.keywords.map((keyword) => String(keyword || '').trim().toLowerCase()).filter(Boolean)
    : [];
  return Array.from(new Set([...keywordTerms, ...splitSearchTerms(queryText)]));
}

function scoreSchemaCandidate(schema, args, terms) {
  const haystack = [schema.name, schema.full_name, schema.comment].filter(Boolean).join(' ').toLowerCase();
  let score = countTermMatches(haystack, terms);

  if (args.dataSchema && String(schema.name).toLowerCase() === String(args.dataSchema).toLowerCase()) {
    score += 100;
  } else if (args.dataSchema && haystack.includes(String(args.dataSchema).toLowerCase())) {
    score += 10;
  }

  return score;
}

function scoreTableCandidate(table, schemaScore, terms) {
  const haystack = [
    table.fullyQualifiedName,
    table.catalogName,
    table.schemaName,
    table.tableName,
    table.description,
    ...table.columns.map((column) => `${column.name} ${column.comments || ''}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return {
    schemaScore,
    tableScore: countTermMatches(haystack, terms),
  };
}

async function listTablesForSearch(args, context, queryText) {
  if (args.dataCatalog && args.dataSchema) {
    return (await listTablesInSchema(args, context)).map((item) => ({ item, schemaScore: 100, catalogName: args.dataCatalog, schemaName: args.dataSchema }));
  }

  const terms = buildTableSearchTerms(args, queryText);
  const catalogs = (await listUnityCatalogs(context)).filter((catalog) => catalog.accessible_in_current_workspace !== false);
  const catalogsToScan = args.dataCatalog
    ? catalogs.filter((catalog) => String(catalog.name).toLowerCase() === String(args.dataCatalog).toLowerCase())
    : catalogs;

  const schemaGroups = await Promise.all(
    catalogsToScan.map(async (catalog) => ({
      catalogName: catalog.name,
      schemas: await listUnitySchemas(catalog.name, context),
    })),
  );

  const rankedSchemas = schemaGroups
    .flatMap(({ catalogName, schemas }) =>
      schemas.map((schema) => ({
        catalogName,
        schemaName: schema.name,
        score: scoreSchemaCandidate(schema, args, terms),
      })),
    )
    .sort((a, b) => b.score - a.score || a.catalogName.localeCompare(b.catalogName) || a.schemaName.localeCompare(b.schemaName));

  const selectedSchemas = rankedSchemas.filter((schema) => schema.score > 0).slice(0, 12);
  const fallbackSchemas = selectedSchemas.length > 0 ? selectedSchemas : rankedSchemas.slice(0, 12);

  const tableGroups = await Promise.all(
    fallbackSchemas.map(async (schema) => ({
      ...schema,
      tables: await listTablesInSchema({ dataCatalog: schema.catalogName, dataSchema: schema.schemaName }, context),
    })),
  );

  return tableGroups.flatMap((group) => group.tables.map((item) => ({ item, schemaScore: group.score, catalogName: group.catalogName, schemaName: group.schemaName })));
}

async function listTablesInSchema(args, context) {
  if (!args.dataCatalog || !args.dataSchema) {
    throw new Error('tableSearch currently requires both dataCatalog and dataSchema in browserless mode.');
  }

  const url = new URL(`${context.origin}/ajax-api/2.1/unity-catalog/tables`);
  url.searchParams.set('catalog_name', args.dataCatalog);
  url.searchParams.set('schema_name', args.dataSchema);

  const { response, text } = await requestText(url.toString(), {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`tableSearch failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  const parsed = JSON.parse(text);
  return Array.isArray(parsed.tables) ? parsed.tables : [];
}

async function getTableDetails(fullyQualifiedName, context) {
  const url = `${context.origin}/ajax-api/2.1/unity-catalog/tables/${encodeURIComponent(fullyQualifiedName)}`;
  const { response, text } = await requestText(url, {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`readTable failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  return JSON.parse(text);
}

function encodeWorkspacePath(path) {
  return String(path || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function readWorkspaceFile(path, context) {
  const encodedPath = encodeWorkspacePath(path);
  const url = `${context.origin}/ajax-api/2.0/workspace-files/${encodedPath}`;
  const { response, text } = await requestText(url, {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`readSkillFile failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  return text;
}

function getWorkspaceHomePath(context) {
  return context.workspaceUser ? `/Workspace/Users/${context.workspaceUser}` : '/Workspace/Users';
}

function pathBasename(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

function workspaceObjectToAssetType(objectType) {
  if (objectType === 'NOTEBOOK') return 'notebook';
  if (objectType === 'FILE') return 'file';
  if (objectType === 'DIRECTORY') return 'directory';
  return '';
}

function normalizeWorkspaceAsset(item) {
  const assetType = workspaceObjectToAssetType(item.object_type || item.objectType || '');
  return {
    assetType,
    assetId: String(item.object_id || item.objectId || item.resource_id || item.resourceId || ''),
    name: pathBasename(item.path || ''),
    path: item.path || '',
    objectType: item.object_type || item.objectType || '',
    resourceId: String(item.resource_id || item.resourceId || ''),
  };
}

function normalizeQueryAsset(item) {
  return {
    assetType: 'query',
    assetId: String(item.id || ''),
    name: item.name || '',
    description: item.description || null,
    queryText: item.query || item.query_text || '',
    updatedAt: item.updated_at || null,
    createdAt: item.created_at || null,
    parent: item.parent || null,
    ownerEmail: item.user && item.user.email ? item.user.email : null,
  };
}

function normalizeDashboardAsset(item) {
  return {
    assetType: 'dashboard',
    assetId: String(item.id || ''),
    name: item.name || item.display_name || '',
    description: item.description || null,
    updatedAt: item.updated_at || null,
    createdAt: item.created_at || null,
    ownerEmail: item.user && item.user.email ? item.user.email : null,
  };
}

function normalizeGenieSpace(item) {
  return {
    assetType: 'genie',
    assetId: String(item.space_id || item.id || ''),
    name: item.title || item.name || '',
    description: item.description || null,
    sampleQuestions: item.sample_questions || item.sampleQuestions || [],
    warehouseId: item.warehouse_id || item.warehouseId || null,
    raw: item,
  };
}

function rememberAsset(asset, context) {
  if (!asset || !asset.assetId) return asset;
  context.assetCacheById.set(`${asset.assetType}:${asset.assetId}`, asset);
  if (asset.path) {
    context.assetCacheByPath.set(asset.path, asset);
  }
  return asset;
}

function rememberAssets(assets, context) {
  return assets.map((asset) => rememberAsset(asset, context));
}

function matchesSearchText(value, query) {
  if (!query) return true;
  return String(value || '').toLowerCase().includes(String(query).toLowerCase());
}

function matchesAssetSearch(asset, query) {
  if (!query) return true;
  const haystack = [asset.name, asset.description, asset.path, asset.queryText, asset.assetType]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(String(query).toLowerCase());
}

function requestedAssetTypes(args, fallback) {
  const alias = {
    queries: 'query',
    notebooks: 'notebook',
    files: 'file',
    directories: 'directory',
    folders: 'directory',
    dashboards: 'dashboard',
    datarooms: 'genie',
    genieSpaces: 'genie',
  };
  const requested = Array.isArray(args.assetTypes)
    ? args.assetTypes.filter(Boolean).map((type) => alias[type] || type)
    : [];
  return requested.length > 0 ? requested : fallback;
}

function normalizeAssetTypeName(assetType) {
  const alias = {
    queries: 'query',
    notebooks: 'notebook',
    files: 'file',
    directories: 'directory',
    folder: 'directory',
    folders: 'directory',
    dashboards: 'dashboard',
    datarooms: 'genie',
    genieSpaces: 'genie',
  };
  return alias[assetType] || assetType;
}

async function listWorkspaceDirectory(path, context) {
  const url = new URL(`${context.origin}/ajax-api/2.0/workspace/list`);
  url.searchParams.set('path', path);
  const { response, text } = await requestText(url.toString(), {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`workspace list failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  const parsed = JSON.parse(text);
  return Array.isArray(parsed.objects) ? parsed.objects : [];
}

async function walkWorkspaceForAssets(roots, context, options = {}) {
  const maxDepth = options.maxDepth == null ? 3 : options.maxDepth;
  const maxDirectories = options.maxDirectories == null ? 80 : options.maxDirectories;
  const queue = roots.map((path) => ({ path, depth: 0 }));
  const seen = new Set();
  const assets = [];
  let visitedDirectories = 0;

  while (queue.length > 0 && visitedDirectories < maxDirectories) {
    const current = queue.shift();
    if (!current || seen.has(current.path)) continue;
    seen.add(current.path);
    visitedDirectories += 1;

    let children = [];
    try {
      children = await listWorkspaceDirectory(current.path, context);
    } catch {
      continue;
    }

    for (const child of children) {
      const normalized = normalizeWorkspaceAsset(child);
      if (normalized.assetType) assets.push(normalized);
      if (child.object_type === 'DIRECTORY' && current.depth < maxDepth) {
        queue.push({ path: child.path, depth: current.depth + 1 });
      }
    }
  }

  return assets;
}

async function listSqlQueries(context, pageSize = 100) {
  const url = new URL(`${context.origin}/ajax-api/2.0/preview/sql/queries`);
  url.searchParams.set('page_size', String(pageSize));
  url.searchParams.set('page', '1');
  const { response, text } = await requestText(url.toString(), {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`query list failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  const parsed = JSON.parse(text);
  return Array.isArray(parsed.results) ? parsed.results : [];
}

async function listSqlDashboards(context, pageSize = 100) {
  const url = new URL(`${context.origin}/ajax-api/2.0/preview/sql/dashboards`);
  url.searchParams.set('page_size', String(pageSize));
  url.searchParams.set('page', '1');
  const { response, text } = await requestText(url.toString(), {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`dashboard list failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  const parsed = JSON.parse(text);
  return Array.isArray(parsed.results) ? parsed.results : [];
}

async function searchWorkspaceAssets(args, context) {
  const roots = args.ownerOnly ? [getWorkspaceHomePath(context)] : [getWorkspaceHomePath(context), '/Workspace/Shared'];
  const requestedTypes = new Set(requestedAssetTypes(args, ['notebook', 'file', 'directory']));
  const allAssets = await walkWorkspaceForAssets(roots, context, {
    maxDepth: args.searchQuery ? 4 : 2,
    maxDirectories: args.searchQuery ? 120 : 40,
  });

  return allAssets
    .filter((asset) => requestedTypes.has(asset.assetType))
    .filter((asset) => matchesAssetSearch(asset, args.searchQuery))
    .slice(0, args.numResultsPerAssetType || 5);
}

async function searchQueryAssets(args, context) {
  const queries = rememberAssets((await listSqlQueries(context, 100)).map((item) => normalizeQueryAsset(item)), context);
  return queries
    .filter((asset) => !args.ownerOnly || asset.ownerEmail === context.workspaceUser)
    .filter((asset) => matchesAssetSearch(asset, args.searchQuery))
    .slice(0, args.numResultsPerAssetType || 5);
}

async function searchDashboardAssets(args, context) {
  const dashboards = rememberAssets((await listSqlDashboards(context, 100)).map((item) => normalizeDashboardAsset(item)), context);
  return dashboards
    .filter((asset) => !args.ownerOnly || asset.ownerEmail === context.workspaceUser)
    .filter((asset) => matchesAssetSearch(asset, args.searchQuery))
    .slice(0, args.numResultsPerAssetType || 5);
}

async function exportWorkspaceObject(path, format, context) {
  const url = new URL(`${context.origin}/ajax-api/2.0/workspace/export`);
  url.searchParams.set('path', path);
  url.searchParams.set('format', format);
  const { response, text } = await requestText(url.toString(), {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`workspace export failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  const parsed = JSON.parse(text);
  const content = parsed.content ? Buffer.from(parsed.content, 'base64').toString('utf8') : '';
  return {
    ...parsed,
    decodedContent: content,
  };
}

async function getWorkspaceStatus(path, context) {
  const url = new URL(`${context.origin}/ajax-api/2.0/workspace/get-status`);
  url.searchParams.set('path', path);
  const { response, text } = await requestText(url.toString(), {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`workspace get-status failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  return JSON.parse(text);
}

async function readSqlQuery(assetId, context) {
  const { response, text } = await requestText(`${context.origin}/ajax-api/2.0/preview/sql/queries/${encodeURIComponent(assetId)}`, {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`query read failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  return JSON.parse(text);
}

async function readSqlDashboard(assetId, context) {
  const { response, text } = await requestText(`${context.origin}/ajax-api/2.0/preview/sql/dashboards/${encodeURIComponent(assetId)}`, {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`dashboard read failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  return JSON.parse(text);
}

function normalizeWorkspaceInputPath(assetIdOrPath, context) {
  const value = String(assetIdOrPath || '').trim();
  if (!value) return '';
  if (value.startsWith('/Workspace/')) return value;
  if (value.startsWith('/Users/')) return `/Workspace${value}`;
  if (value.startsWith('/')) return `/Workspace${value}`;
  return `${getWorkspaceHomePath(context)}/${value}`;
}

function resolveCachedAsset(assetType, assetIdOrPath, context) {
  const direct = context.assetCacheById.get(`${assetType}:${assetIdOrPath}`);
  if (direct) return direct;
  const byPath = context.assetCacheByPath.get(assetIdOrPath);
  if (byPath) return byPath;
  return null;
}

async function executeTableSearch(toolCall, args, context) {
  const queryText = buildTableSearchQueryText(args);
  const terms = buildTableSearchTerms(args, queryText);
  const rankedTables = (await listTablesForSearch(args, context, queryText)).map((entry) => {
    const table = normalizeUcTable(entry.item);
    const score = scoreTableCandidate(table, entry.schemaScore, terms);
    return {
      table,
      totalScore: score.schemaScore + score.tableScore,
      include: terms.length === 0 || score.schemaScore > 0 || score.tableScore > 0,
    };
  });

  const filteredTables = rankedTables
    .filter((entry) => entry.include)
    .sort((a, b) => b.totalScore - a.totalScore || a.table.fullyQualifiedName.localeCompare(b.table.fullyQualifiedName))
    .map((entry) => entry.table)
    .slice(0, 25);

  return {
    success: true,
    __toolCallId: toolCall.id,
    data: filteredTables,
    searchMetadata: {
      queryText,
      dataCatalog: args.dataCatalog || '',
      dataSchema: args.dataSchema || '',
      searchQuery: args.searchQuery || '',
    },
  };
}

async function executeReadTable(toolCall, args, context) {
  const fullyQualifiedName = `${args.catalog}.${args.schema}.${args.name}`;
  const table = await getTableDetails(fullyQualifiedName, context);

  return {
    success: true,
    __toolCallId: toolCall.id,
    data: normalizeUcTable(table),
    extraDetails: Boolean(args.extraDetails),
  };
}

function extractSparkSql(code) {
  const text = String(code || '');
  const patterns = [
    /spark\.sql\(\s*"""([\s\S]*?)"""\s*\)/,
    /spark\.sql\(\s*'''([\s\S]*?)'''\s*\)/,
    /spark\.sql\(\s*"([\s\S]*?)"\s*\)/,
    /spark\.sql\(\s*'([\s\S]*?)'\s*\)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function parseQualifiedName(name) {
  const parts = String(name || '')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length !== 3) {
    throw new Error(`Expected a fully qualified name (catalog.schema.table), got: ${name}`);
  }

  return {
    catalog: parts[0],
    schema: parts[1],
    table: parts[2],
  };
}

async function emulateSparkSql(sql, context) {
  const normalized = String(sql || '').trim().replace(/;$/, '');

  let match = normalized.match(/^SHOW\s+TABLES\s+IN\s+([A-Za-z0-9_]+\.[A-Za-z0-9_]+)$/i);
  if (match) {
    const [catalog, schema] = match[1].split('.');
    const tables = simplifySearchResults(
      await listTablesInSchema(
        {
          dataCatalog: catalog,
          dataSchema: schema,
          keywords: [],
          searchQuery: normalized,
        },
        context,
      ),
    );

    return {
      type: 'table',
      columns: [
        { name: 'database', type: 'STRING' },
        { name: 'tableName', type: 'STRING' },
        { name: 'isTemporary', type: 'BOOLEAN' },
      ],
      rowCount: tables.length,
      rows: tables.map((table) => ({
        database: table.schemaName,
        tableName: table.tableName,
        isTemporary: false,
      })),
    };
  }

  match = normalized.match(/^DESCRIBE\s+(?:TABLE\s+)?([A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+)$/i);
  if (match) {
    const { catalog, schema, table } = parseQualifiedName(match[1]);
    const detail = normalizeUcTable(await getTableDetails(`${catalog}.${schema}.${table}`, context));

    return {
      type: 'table',
      columns: [
        { name: 'col_name', type: 'STRING' },
        { name: 'data_type', type: 'STRING' },
        { name: 'comment', type: 'STRING' },
      ],
      rowCount: detail.columns.length,
      rows: detail.columns.map((column) => ({
        col_name: column.name,
        data_type: column.typeText,
        comment: column.comments,
      })),
      table: detail,
    };
  }

  throw new Error(`Unsupported browserless executeCode SQL: ${normalized}`);
}

async function executeCode(toolCall, args, context) {
  const sqlStatements = args.language === 'python' ? extractSparkSqlStatements(args.code) : [];
  const translatedSql = args.language === 'python' ? translatePythonDataFrameCodeToSql(args.code) : null;
  const executedSql = translatedSql || (sqlStatements.length > 0 ? sqlStatements[sqlStatements.length - 1].trim() : null);

  if (!executedSql) {
    throw new Error(`Unsupported browserless executeCode payload for language ${args.language}`);
  }

  let result;
  try {
    const executed = await executeSqlStatement(executedSql, context);
    result = {
      type: 'table',
      statementId: executed.statementId,
      warehouseId: executed.warehouseId,
      columns: ((executed.manifest && executed.manifest.schema && executed.manifest.schema.columns) || []).map((column) => ({
        name: column.name,
        type: column.type_text || column.typeText || column.type_name || column.typeName || null,
      })),
      rowCount: executed.rows.length,
      rows: executed.rows,
    };
  } catch (error) {
    result = await emulateSparkSql(executedSql, context);
  }

  return {
    success: true,
    __toolCallId: toolCall.id,
    executionMode: result.statementId ? 'browserless-sql-warehouse' : 'browserless-sql-emulation',
    language: args.language,
    summary: args.summary,
    code: args.code,
    executedSql,
    translationMode: translatedSql ? 'dataframe-to-sql' : 'spark-sql',
    result,
  };
}

async function executeReadSkillFile(toolCall, args, context) {
  if (!args.filePath) {
    return {
      success: true,
      __toolCallId: toolCall.id,
      filePath: '',
      content: '',
    };
  }

  if (!context.workspaceUser) {
    throw new Error('Could not determine workspace user for readSkillFile.');
  }

  const relativePath = String(args.filePath).replace(/^skills\//, '');
  const workspacePath = `/Workspace/Users/${context.workspaceUser}/.assistant/skills/${relativePath}`;
  const content = await readWorkspaceFile(workspacePath, context);

  return {
    success: true,
    __toolCallId: toolCall.id,
    filePath: args.filePath,
    workspacePath,
    content,
  };
}

async function collectAssetSearchResults(args, context) {
  const requestedTypes = requestedAssetTypes(args, ['notebook', 'file', 'directory', 'query', 'dashboard']);
  const requestedSet = new Set(requestedTypes);
  const results = [];

  if (requestedSet.has('notebook') || requestedSet.has('file') || requestedSet.has('directory')) {
    results.push(...rememberAssets(await searchWorkspaceAssets(args, context), context));
  }

  if (requestedSet.has('query')) {
    results.push(...rememberAssets(await searchQueryAssets(args, context), context));
  }

  if (requestedSet.has('dashboard')) {
    results.push(...rememberAssets(await searchDashboardAssets(args, context), context));
  }

  if (requestedSet.has('genie')) {
    const spaces = await listGenieSpaces(context);
    results.push(
      ...spaces
        .filter((asset) => matchesAssetSearch(asset, args.searchQuery))
        .slice(0, args.numResultsPerAssetType || 5),
    );
  }

  return results;
}

async function executeSearchAssets(toolCall, args, context) {
  const results = await collectAssetSearchResults(args, context);
  const supportedAssetTypes = ['notebook', 'file', 'directory', 'query', 'dashboard', 'genie'];

  return {
    success: true,
    searchQuery: args.searchQuery || '',
    ownerOnly: Boolean(args.ownerOnly),
    supportedAssetTypes,
    unsupportedRequestedAssetTypes: requestedAssetTypes(args, supportedAssetTypes).filter((type) => !supportedAssetTypes.includes(type)),
    nextPageToken: '',
    results,
  };
}

async function executeForYouAssets(toolCall, args, context) {
  const numResults = Number.isFinite(args.numResults) ? args.numResults : 5;
  const searchArgs = {
    searchQuery: args.keywords || '',
    assetTypes: Array.isArray(args.assetTypes) ? args.assetTypes : ['query', 'notebook', 'file', 'directory'],
    numResultsPerAssetType: numResults,
    ownerOnly: true,
  };
  const results = await collectAssetSearchResults(searchArgs, context);

  return {
    success: true,
    favorites: args.includeFavorites ? [] : [],
    suggestedAssets: args.includeSuggestedAssets ? results : [],
    popularAssets: args.includePopularAssets ? [] : [],
    metadata: {
      page: args.page || '',
      interface: args.interface || '',
      keywords: args.keywords || '',
    },
  };
}

async function executeReadAssetById(toolCall, args, context) {
  const assetType = normalizeAssetTypeName(args.assetType);
  const cached = resolveCachedAsset(assetType, args.assetId, context);

  if (assetType === 'query') {
    const query = normalizeQueryAsset(await readSqlQuery(args.assetId, context));
    return {
      success: true,
      asset: rememberAsset(query, context),
    };
  }

  if (assetType === 'genie') {
    const spaces = await listGenieSpaces(context);
    const match = spaces.find((space) => space.assetId === String(args.assetId));
    if (!match) {
      throw new Error(`Genie space not found: ${args.assetId}`);
    }
    return {
      success: true,
      asset: rememberAsset(match, context),
    };
  }

  if (assetType === 'dashboard') {
    const dashboard = normalizeDashboardAsset(await readSqlDashboard(args.assetId, context));
    return {
      success: true,
      asset: rememberAsset(dashboard, context),
    };
  }

  if (assetType === 'directory') {
    const path = cached && cached.path ? cached.path : normalizeWorkspaceInputPath(args.assetId, context);
    const status = await getWorkspaceStatus(path, context);
    const objects = await listWorkspaceDirectory(path, context);
    return {
      success: true,
      asset: rememberAsset(normalizeWorkspaceAsset(status), context),
      children: rememberAssets(objects.map((item) => normalizeWorkspaceAsset(item)), context),
    };
  }

  if (assetType === 'file' || assetType === 'notebook') {
    const path = cached && cached.path ? cached.path : normalizeWorkspaceInputPath(args.assetId, context);
    const status = await getWorkspaceStatus(path, context);
    const exported = await exportWorkspaceObject(path, assetType === 'notebook' ? 'SOURCE' : 'AUTO', context);
    return {
      success: true,
      asset: rememberAsset(normalizeWorkspaceAsset(status), context),
      content: exported.decodedContent,
      language: exported.language || null,
      format: exported.format || null,
    };
  }

  throw new Error(`Unsupported browserless readAssetById asset type: ${assetType}`);
}

function extensionToNotebookLanguage(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.sql')) return 'SQL';
  if (lower.endsWith('.scala')) return 'SCALA';
  if (lower.endsWith('.r')) return 'R';
  return 'PYTHON';
}

function resolveCreateAssetPath(name, context) {
  const value = String(name || '').trim();
  if (!value) throw new Error('Missing asset name/path.');
  if (value.startsWith('/Workspace/')) return value;
  if (value.startsWith('/Users/')) return `/Workspace${value}`;
  if (value.startsWith('/')) return `${getWorkspaceHomePath(context)}${value}`;
  return `${getWorkspaceHomePath(context)}/${value}`;
}

async function createWorkspaceDirectory(path, context) {
  const { response, text } = await requestText(`${context.origin}/ajax-api/2.0/workspace/mkdirs`, {
    method: 'POST',
    headers: { ...context.ajaxHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    throw new Error(`workspace mkdirs failed (${response.status}): ${text.slice(0, 1000)}`);
  }
}

async function importWorkspaceObject(path, payload, context) {
  const { response, text } = await requestText(`${context.origin}/ajax-api/2.0/workspace/import`, {
    method: 'POST',
    headers: { ...context.ajaxHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`workspace import failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  return JSON.parse(text);
}

async function createSqlQuery(name, context) {
  const payload = {
    name,
    query: '',
    description: 'Created by genie-direct',
  };
  const { response, text } = await requestText(`${context.origin}/ajax-api/2.0/preview/sql/queries`, {
    method: 'POST',
    headers: { ...context.ajaxHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`query create failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  return JSON.parse(text);
}

async function executeCreateAsset(toolCall, args, context) {
  const assetType = normalizeAssetTypeName(args.assetType);

  if (assetType === 'directory') {
    const path = resolveCreateAssetPath(args.name, context);
    await createWorkspaceDirectory(path, context);
    const status = normalizeWorkspaceAsset(await getWorkspaceStatus(path, context));
    return {
      success: true,
      asset: rememberAsset(status, context),
    };
  }

  if (assetType === 'file') {
    const path = resolveCreateAssetPath(args.name, context);
    const imported = await importWorkspaceObject(
      path,
      {
        path,
        format: 'AUTO',
        content: Buffer.from('', 'utf8').toString('base64'),
        overwrite: true,
      },
      context,
    );
    const status = normalizeWorkspaceAsset(await getWorkspaceStatus(path, context));
    status.assetId = String(imported.object_id || status.assetId);
    return {
      success: true,
      asset: rememberAsset(status, context),
    };
  }

  if (assetType === 'notebook') {
    const path = resolveCreateAssetPath(args.name, context);
    const language = extensionToNotebookLanguage(args.name);
    const imported = await importWorkspaceObject(
      path,
      {
        path,
        format: 'SOURCE',
        language,
        content: Buffer.from('# Databricks notebook source\n', 'utf8').toString('base64'),
        overwrite: true,
      },
      context,
    );
    const status = normalizeWorkspaceAsset(await getWorkspaceStatus(path, context));
    status.assetId = String(imported.object_id || status.assetId);
    return {
      success: true,
      asset: rememberAsset(status, context),
      language,
    };
  }

  if (assetType === 'query') {
    const created = normalizeQueryAsset(await createSqlQuery(args.name, context));
    return {
      success: true,
      asset: rememberAsset(created, context),
    };
  }

  throw new Error(`Unsupported browserless createAsset asset type: ${assetType}`);
}

function buildWorkspaceUrl(path, context) {
  const suffix = path.startsWith('/Workspace') ? path.slice('/Workspace'.length) : path;
  return `${context.origin}/?o=${context.orgId}#workspace${suffix}`;
}

function buildAssetUrl(assetType, assetId, assetName, context) {
  assetType = normalizeAssetTypeName(assetType);
  if (assetType === 'query') return `${context.origin}/sql/editor/${assetId}`;
  if (assetType === 'dashboard') return `${context.origin}/sql/dashboards/${assetId}`;
  if (assetType === 'genie') return `${context.origin}/genie/rooms/${assetId}`;
  if (assetType === 'table' && assetName) {
    return `${context.origin}/explore/data/${assetName}`;
  }

  const cached = resolveCachedAsset(assetType, assetId, context);
  if (cached && cached.path) return buildWorkspaceUrl(cached.path, context);
  if (assetId && (String(assetId).startsWith('/Workspace/') || String(assetId).startsWith('/Users/'))) {
    return buildWorkspaceUrl(normalizeWorkspaceInputPath(assetId, context), context);
  }

  return '';
}

async function executeOpenAsset(toolCall, args, context) {
  const assetType = normalizeAssetTypeName(args.assetType);
  const url = buildAssetUrl(assetType, args.assetId, args.assetName, context);
  if (!url) {
    throw new Error(`Unsupported browserless openAsset asset type or identifier: ${args.assetType}`);
  }

  return {
    success: true,
    assetType,
    assetId: args.assetId,
    assetName: args.assetName || '',
    navigateRequested: Boolean(args.navigate),
    continueMessage: args.continueMessage || '',
    url,
    note: args.navigate
      ? 'Browserless mode returns the target URL instead of navigating a browser.'
      : 'URL returned without navigation.',
  };
}

async function listGenieSpaces(context) {
  const candidates = [
    `${context.origin}/ajax-api/2.0/genie/spaces?include_serialized_space=true`,
    `${context.origin}/ajax-api/2.0/genie/spaces`,
  ];

  for (const url of candidates) {
    const { response, text } = await requestText(url, {
      method: 'GET',
      headers: context.ajaxHeaders,
    });

    if (!response.ok) continue;
    let parsed = {};
    try {
      parsed = JSON.parse(text || '{}');
    } catch {
      parsed = {};
    }

    const rawSpaces = parsed.spaces || parsed.results || parsed.data || [];
    if (Array.isArray(rawSpaces)) {
      const spaces = rememberAssets(rawSpaces.map((item) => normalizeGenieSpace(item)), context);
      for (const space of spaces) {
        context.genieSpaceCacheById.set(space.assetId, space);
      }
      return spaces;
    }
  }

  return [];
}

function scoreGenieSpace(space, query) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return 0;

  const haystack = [space.name, space.description, ...(space.sampleQuestions || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

async function executeRecommendDataroom(toolCall, args, context) {
  const spaces = await listGenieSpaces(context);
  const ranked = spaces
    .map((space) => ({ space, score: scoreGenieSpace(space, args.query) }))
    .filter((item) => item.score > 0 || !args.query)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => ({
      dataroomId: item.space.assetId,
      title: item.space.name,
      description: item.space.description,
      sampleQuestions: item.space.sampleQuestions,
      score: item.score,
    }));

  return {
    success: true,
    query: args.query || '',
    spaces: ranked,
  };
}

async function startGenieConversation(spaceId, question, context) {
  const candidates = [
    {
      url: `${context.origin}/ajax-api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/conversations`,
      body: { content: question },
    },
    {
      url: `${context.origin}/ajax-api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/start-conversation`,
      body: { content: question },
    },
  ];

  let lastError = null;
  for (const candidate of candidates) {
    const { response, text } = await requestText(candidate.url, {
      method: 'POST',
      headers: { ...context.ajaxHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(candidate.body),
    });

    if (!response.ok) {
      lastError = `${response.status}: ${text.slice(0, 400)}`;
      continue;
    }

    return JSON.parse(text || '{}');
  }

  throw new Error(`askDataroom failed to start conversation: ${lastError || 'unknown error'}`);
}

function extractConversationIdentifiers(payload) {
  return {
    conversationId:
      payload.conversation_id || payload.conversationId || (payload.conversation && (payload.conversation.conversation_id || payload.conversation.id)) || '',
    messageId:
      payload.message_id || payload.messageId || (payload.message && (payload.message.message_id || payload.message.id)) || '',
  };
}

async function pollGenieMessage(spaceId, conversationId, messageId, context) {
  const url = `${context.origin}/ajax-api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { response, text } = await requestText(url, {
      method: 'GET',
      headers: context.ajaxHeaders,
    });

    if (!response.ok) {
      throw new Error(`askDataroom polling failed (${response.status}): ${text.slice(0, 1000)}`);
    }

    const payload = JSON.parse(text || '{}');
    const status = String(payload.status || payload.state || '').toUpperCase();
    if (!status || ['COMPLETED', 'FINISHED', 'SUCCEEDED', 'SUCCESS'].includes(status)) {
      return payload;
    }

    if (['FAILED', 'ERROR', 'CANCELLED'].includes(status)) {
      throw new Error(`askDataroom message failed with status ${status}`);
    }

    await sleep(1000);
  }

  throw new Error('askDataroom polling timed out.');
}

async function fetchGenieAttachment(spaceId, conversationId, messageId, attachmentId, context) {
  const url = `${context.origin}/ajax-api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/query-result`;
  const { response, text } = await requestText(url, {
    method: 'GET',
    headers: context.ajaxHeaders,
  });

  if (!response.ok) {
    throw new Error(`askDataroom attachment fetch failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  return JSON.parse(text || '{}');
}

async function executeAskDataroom(toolCall, args, context) {
  const started = await startGenieConversation(args.dataroomId, args.question, context);
  const ids = extractConversationIdentifiers(started);
  if (!ids.conversationId || !ids.messageId) {
    return {
      success: true,
      dataroomId: args.dataroomId,
      question: args.question,
      raw: started,
    };
  }

  const message = await pollGenieMessage(args.dataroomId, ids.conversationId, ids.messageId, context);
  let attachmentResult = null;
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const queryAttachment = attachments.find((attachment) => attachment.attachment_id || attachment.attachmentId);
  if (queryAttachment) {
    attachmentResult = await fetchGenieAttachment(
      args.dataroomId,
      ids.conversationId,
      ids.messageId,
      queryAttachment.attachment_id || queryAttachment.attachmentId,
      context,
    );
  }

  return {
    success: true,
    dataroomId: args.dataroomId,
    conversationId: ids.conversationId,
    messageId: ids.messageId,
    message,
    attachmentResult,
  };
}

async function executeFetchOmittedContent(toolCall, args, context) {
  if (!context.toolOutputCache.has(args.toolCallId)) {
    throw new Error(`No cached tool output found for ${args.toolCallId}`);
  }

  const cached = context.toolOutputCache.get(args.toolCallId);
  const evaluated = evaluateCachedPath(cached, args.path);

  return {
    success: true,
    toolCallId: args.toolCallId,
    path: args.path,
    value: evaluated.value,
    sliceInfo: evaluated.sliceInfo,
  };
}

async function executeToolCall(toolCall, context) {
  let args;
  try {
    args = toolCall.function && toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
  } catch (error) {
    throw new Error(`Invalid JSON arguments for tool ${toolCall.function && toolCall.function.name ? toolCall.function.name : 'unknown'}: ${String(error)}`);
  }

  const toolName = toolCall.function.name;
  const executor = getToolExecutorRegistry()[toolName];
  if (executor) {
    const rawOutput = await executor(toolCall, args, context);
    return {
      input: args,
      rawOutput,
      output: prepareToolOutput(toolCall.id, rawOutput, context),
    };
  }

  throw new Error(`Unsupported browserless Genie tool: ${toolCall.function.name}`);
}

function createToolMessage(toolCallId, output) {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: JSON.stringify(output),
  };
}

async function runConversation(context, templatePayload, prompt, options) {
  const basePayload = structuredClone(templatePayload);
  basePayload.params = basePayload.params || {};
  basePayload.params.messages = Array.isArray(basePayload.params.messages) ? basePayload.params.messages : [];

  if (basePayload.params.messages.length === 0) {
    throw new Error('Template payload does not contain any messages.');
  }

  const baseMessages = basePayload.params.messages.slice(0, -1);
  const persistedMessages = Array.isArray(context.sessionConversationMessages)
    ? structuredClone(context.sessionConversationMessages)
    : [];
  const userMessage = {
    role: 'user',
    content: prompt,
  };

  basePayload.metadata = basePayload.metadata || {};
  basePayload.metadata.sessionId = context.sessionId;
  basePayload.metadata.traceId = context.traceId;

  let messages = [...baseMessages, ...persistedMessages, userMessage];
  const conversationOffset = baseMessages.length;
  const turns = [];

  for (let round = 0; round < options.maxToolRounds; round += 1) {
    const payload = structuredClone(basePayload);
    payload.params.messages = messages;
    payload.metadata.callId = crypto.randomUUID();

    const streamed = await postCompletionStream(context.completionUrl, context.completionHeaders, payload, options);
    if (streamed.status !== 200) {
      throw new Error(`Genie direct call failed (${streamed.status}): ${streamed.rawText.slice(0, 1000)}`);
    }

    const parsed = streamed.parsed;
    const turn = {
      round: round + 1,
      finishReason: parsed.finishReason,
      response: parsed.text,
      reasoning: parsed.reasoning,
      toolCalls: parsed.toolCalls.map((toolCall) => structuredClone(toolCall)),
      events: parsed.events.map((event) => structuredClone(event)),
      toolResults: [],
    };
    turns.push(turn);

    if (parsed.finishReason !== 'tool_calls' || parsed.toolCalls.length === 0) {
      messages = [...messages, structuredClone(parsed.assistantMessage)];
      return {
        final: parsed,
        turns,
        conversationMessages: messages.slice(conversationOffset),
      };
    }

    messages = [...messages, structuredClone(parsed.assistantMessage)];

    for (const toolCall of parsed.toolCalls) {
      const executed = await executeToolCall(toolCall, context);
      turn.toolResults.push({
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        input: executed.input,
        output: executed.output,
      });
      messages.push(createToolMessage(toolCall.id, executed.output));
    }
  }

  throw new Error(`Exceeded max tool rounds (${options.maxToolRounds}) without a final answer.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stdinPrompt = readStdin().trim();
  const prompt = options.promptParts.join(' ').trim() || stdinPrompt;
  let bufferedStdout = '';
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  if (!options.jsonOutput) {
    process.stdout.write = (chunk, encoding, callback) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk);
      bufferedStdout += text;
      if (typeof callback === 'function') callback();
      return true;
    };
  }

  try {
    if (options.listProfiles) {
      printProfiles(loadDatabricksProfiles());
      return;
    }

    const templateFileForRead = options.templateFile || DEFAULT_SHARED_TEMPLATE_FILE;
    let template = loadTemplatePayload(templateFileForRead);

    if (options.listTools) {
      const tools = summarizeTemplateTools(template.payload);
      if (options.jsonOutput) {
        console.log(JSON.stringify({ tools }, null, 2));
      } else {
        printToolSummary(tools);
      }
      return;
    }

    if (options.listSupportedTools) {
      const summary = summarizeSupportedTools(template.payload);
      if (options.jsonOutput) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        printSupportedToolSummary(summary);
      }
      return;
    }

    if (!prompt) {
      printUsage();
      throw new Error('Missing prompt text.');
    }

    const workspace = resolveWorkspaceSelection({
      profileName: options.profileName,
      stateFile: options.stateFile,
      metadataFile: options.metadataFile,
      templateFile: options.templateFileExplicit ? options.templateFile : '',
    });

    if (workspace.templateFile && workspace.templateFile !== templateFileForRead) {
      template = loadTemplatePayload(workspace.templateFile);
    }

    const completionUrl = new URL('/ajax-api/2.0/conversation/proxy/chat/completions', workspace.workspaceHost).toString();
    const origin = new URL(completionUrl).origin;

    const authState = await ensureDatabricksAuthState({
      profileName: workspace.profileName,
      stateFile: workspace.stateFile,
      metadataFile: workspace.metadataFile,
      workspaceUrl: workspace.workspaceUrl,
      log: (message) => process.stderr.write(`[auth] ${message}\n`),
    });

    const activeWorkspaceUrl = authState.workspaceUrl || workspace.workspaceUrl;
    const orgId = authState.orgId || getOrgIdFromWorkspaceUrl(activeWorkspaceUrl) || template.headers['x-databricks-org-id'];
    const referer = activeWorkspaceUrl || template.headers.referer || `${origin}/`;

    const cookieHeader = loadCookies(workspace.stateFile, 'azuredatabricks.net');
    const workspaceUser = detectWorkspaceUser(workspace.stateFile);

    const baseHeaders = {
      cookie: cookieHeader,
      referer,
      'user-agent': template.headers['user-agent'] || 'Mozilla/5.0',
      'x-databricks-org-id': orgId,
    };

    const sessionInfo = await getSessionInfo(origin, baseHeaders);
    const sessionFile = resolveSessionFilePath(options.sessionDir, options.sessionName, orgId || workspace.profileName);
    const persistedSession = loadPersistentSession(sessionFile, options.newSession);
    const sessionId = persistedSession.sessionId || crypto.randomUUID();
    const traceId = crypto.randomUUID();

    const completionHeaders = {
      ...baseHeaders,
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'x-csrf-token': sessionInfo.csrfToken,
      'x-databricks-self': 'true',
    };

    const ajaxHeaders = {
      ...baseHeaders,
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-csrf-token': sessionInfo.csrfToken,
      'x-databricks-self': 'true',
      'x-requested-with': 'XMLHttpRequest',
    };

    const context = {
      origin,
      orgId,
      sessionInfo,
      sessionId,
      traceId,
      completionUrl,
      completionHeaders,
      ajaxHeaders,
      workspaceUser,
      sessionConversationMessages: persistedSession.conversationMessages,
      assetCacheById: deserializeMap(persistedSession.assetCacheById),
      assetCacheByPath: deserializeMap(persistedSession.assetCacheByPath),
      genieSpaceCacheById: deserializeMap(persistedSession.genieSpaceCacheById),
      toolOutputCache: deserializeMap(persistedSession.toolOutputCache),
      todoList: persistedSession.todoList,
      docsUrls: null,
      docPageCache: new Map(),
      sqlWarehouses: null,
      defaultWarehouseId: null,
      unityCatalogs: null,
      unitySchemasByCatalog: new Map(),
    };

    const conversation = await runConversation(context, template.payload, prompt, options);
    savePersistentSession(sessionFile, context, conversation.conversationMessages);

    if (!options.jsonOutput) {
      originalStdoutWrite(normalizeStreamedStdout(bufferedStdout, options.sessionName));
      originalStdoutWrite(`\n[session ${options.sessionName}]\n`);
      return;
    }

    console.log(
      JSON.stringify(
        {
          prompt,
          profile: workspace.profileName,
          response: conversation.final.text,
          finishReason: conversation.final.finishReason,
          reasoning: conversation.final.reasoning,
          toolCalls: conversation.final.toolCalls,
          turns: conversation.turns,
          model: template.payload.model,
          sessionName: options.sessionName,
          sessionFile,
          sessionId,
          traceId,
          templateFile: workspace.templateFile || templateFileForRead,
          stateFile: workspace.stateFile,
          metadataFile: workspace.metadataFile,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!options.jsonOutput) {
      process.stdout.write = originalStdoutWrite;
    }
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
