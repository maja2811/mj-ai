const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { DEFAULT_STATE_ROOT, loadWorkspaceMetadata, saveWorkspaceMetadata } = require('./genie-workspace');

const DEFAULT_GENIE_WORKSPACE_URL = process.env.GENIE_WORKSPACE_URL || '';
const DEFAULT_GENIE_STATE_FILE = process.env.GENIE_STATE_FILE || path.join(os.tmpdir(), 'dbx-genie-state.json');
const DEFAULT_MS_AUTH_STATE_FILE = process.env.GENIE_MS_AUTH_STATE_FILE || process.env.GENIE_SEED_STATE_FILE || path.join(__dirname, '..', 'playwright', '.auth', 'microsoft.json');
const DEFAULT_AUTH_TIMEOUT_MS = Number.parseInt(process.env.GENIE_SETUP_TIMEOUT_MS || '180000', 10);
const GENIE_INPUT_SELECTOR = '[data-testid="magic-input-editable"][role="textbox"]';
const OPEN_ASSISTANT_SELECTORS = [
  '[data-testid="global-assistant"]',
  'button[aria-label*="Assistant"]',
  'button[aria-label*="Genie"]',
];

function asBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function emit(log, message) {
  if (typeof log === 'function') {
    log(message);
  }
}

function createDeadline(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Number.POSITIVE_INFINITY;
  return Date.now() + timeoutMs;
}

function getOrigin(workspaceUrl) {
  return new URL(workspaceUrl).origin;
}

function getHost(workspaceUrl) {
  return new URL(workspaceUrl).host;
}

function isMicrosoftHost(urlString) {
  try {
    return new URL(urlString).host.endsWith('microsoftonline.com');
  } catch {
    return false;
  }
}

function isDatabricksHost(urlString) {
  try {
    return new URL(urlString).host.endsWith('azuredatabricks.net');
  } catch {
    return false;
  }
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copyStorageState(sourceFile, targetFile) {
  if (!sourceFile || !targetFile || sourceFile === targetFile) return false;
  if (!fs.existsSync(sourceFile)) return false;
  ensureParentDirectory(targetFile);
  fs.copyFileSync(sourceFile, targetFile);
  return true;
}

function listWorkspaceStateCandidates(preferredStateFile) {
  const candidates = [];
  const seen = new Set();

  const remember = (filePath) => {
    if (!filePath || seen.has(filePath) || !fs.existsSync(filePath)) return;
    seen.add(filePath);
    candidates.push(filePath);
  };

  remember(preferredStateFile);
  remember(path.join(os.tmpdir(), 'dbx-genie-state.json'));

  const profilesRoot = path.join(DEFAULT_STATE_ROOT, 'profiles');
  if (fs.existsSync(profilesRoot)) {
    for (const entry of fs.readdirSync(profilesRoot)) {
      remember(path.join(profilesRoot, entry, 'dbx-genie-state.json'));
    }
  }

  return candidates;
}

function seedMicrosoftStateFromWorkspaceState(seedStateFile, preferredStateFile) {
  if (!seedStateFile || fs.existsSync(seedStateFile)) return false;
  for (const candidate of listWorkspaceStateCandidates(preferredStateFile)) {
    if (copyStorageState(candidate, seedStateFile)) {
      return true;
    }
  }
  return false;
}

function getOrgIdFromUrl(urlString) {
  try {
    return new URL(urlString).searchParams.get('o') || '';
  } catch {
    return '';
  }
}

function buildCookieHeader(cookies, targetHost) {
  const pairs = (cookies || [])
    .filter((cookie) => String(cookie.domain || '').includes(targetHost))
    .map((cookie) => `${cookie.name}=${cookie.value}`);

  if (pairs.length === 0) {
    throw new Error(`No ${targetHost} cookies available.`);
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

async function requestFinalUrl(url, options) {
  const response = await fetch(url, {
    ...options,
    redirect: 'follow',
  });
  await response.text();
  return {
    response,
    finalUrl: response.url,
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

async function validateDatabricksCookieHeader(cookieHeader, workspaceUrl) {
  const origin = getOrigin(workspaceUrl);
  const sessionInfo = await getSessionInfo(origin, {
    cookie: cookieHeader,
    referer: `${origin}/`,
    'user-agent': 'Mozilla/5.0',
  });

  if (!sessionInfo || typeof sessionInfo.csrfToken !== 'string' || !sessionInfo.csrfToken) {
    throw new Error('Databricks session info did not include a csrfToken.');
  }

  return {
    origin,
    sessionInfo,
  };
}

async function discoverWorkspaceMetadata(cookieHeader, workspaceUrl) {
  const origin = getOrigin(workspaceUrl);
  const { response, finalUrl } = await requestFinalUrl(workspaceUrl, {
    method: 'GET',
    headers: {
      cookie: cookieHeader,
      referer: `${origin}/`,
      'user-agent': 'Mozilla/5.0',
    },
  });

  return {
    origin,
    workspaceUrl: finalUrl || workspaceUrl,
    orgId: getOrgIdFromUrl(finalUrl || workspaceUrl),
    landingStatus: response.status,
  };
}

async function validateDatabricksStateFile(stateFile, workspaceUrl, metadataFile = '') {
  if (!fs.existsSync(stateFile)) {
    return {
      ok: false,
      reason: `State file not found: ${stateFile}`,
    };
  }

  try {
    const state = loadJson(stateFile);
    const cookieHeader = buildCookieHeader(state.cookies || [], getHost(workspaceUrl));
    const validated = await validateDatabricksCookieHeader(cookieHeader, workspaceUrl);
    const existingMetadata = loadWorkspaceMetadata(metadataFile);
    const discoveredMetadata = !existingMetadata || !existingMetadata.workspaceUrl || !existingMetadata.orgId
      ? await discoverWorkspaceMetadata(cookieHeader, workspaceUrl)
      : null;
    const metadata = {
      ...(existingMetadata || {}),
      ...(discoveredMetadata || {}),
      workspaceUrl: (discoveredMetadata && discoveredMetadata.workspaceUrl) || (existingMetadata && existingMetadata.workspaceUrl) || workspaceUrl,
      orgId: (discoveredMetadata && discoveredMetadata.orgId) || (existingMetadata && existingMetadata.orgId) || getOrgIdFromUrl(workspaceUrl),
      host: getOrigin(workspaceUrl),
      updatedAt: new Date().toISOString(),
    };

    if (metadataFile) {
      saveWorkspaceMetadata(metadataFile, metadata);
    }

    return {
      ok: true,
      stateFile,
      cookieHeader,
      metadata,
      ...validated,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error.message || String(error),
    };
  }
}

async function validateDatabricksContext(context, workspaceUrl) {
  try {
    const cookies = await context.cookies();
    const cookieHeader = buildCookieHeader(cookies, getHost(workspaceUrl));
    const validated = await validateDatabricksCookieHeader(cookieHeader, workspaceUrl);
    return {
      ok: true,
      cookieHeader,
      ...validated,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error.message || String(error),
    };
  }
}

async function isVisible(locator) {
  try {
    if ((await locator.count()) === 0) return false;
    return await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function clickFirstVisible(locators) {
  for (const locator of locators) {
    const target = locator.first();
    if (await isVisible(target)) {
      try {
        await target.click();
        return true;
      } catch {}
    }
  }
  return false;
}

async function hasGenieInput(page) {
  return isVisible(page.locator(GENIE_INPUT_SELECTOR));
}

async function openAssistant(page) {
  for (const selector of OPEN_ASSISTANT_SELECTORS) {
    const button = page.locator(selector);
    if (await isVisible(button)) {
      try {
        await button.first().click();
        await page.waitForTimeout(500);
      } catch {}
    }
  }
}

async function detectWorkspaceUser(page) {
  try {
    return await page.evaluate(() => {
      const orgId = new URL(location.href).searchParams.get('o') || '';
      const threadKey = Object.keys(localStorage).find((key) => key.startsWith('global-assistant-notebook-id_v0.1_user_') && (!orgId || key.endsWith(`_org_${orgId}`)));
      if (!threadKey) return '';
      const match = threadKey.match(/^global-assistant-notebook-id_v0\.1_user_(.+)_org_/);
      return match ? match[1] : '';
    });
  } catch {
    return '';
  }
}

async function hasVisibleMicrosoftLogin(page) {
  const selectors = [
    page.locator('input[name="loginfmt"]'),
    page.locator('input[type="email"]'),
    page.locator('input[name="passwd"]'),
    page.locator('input[type="password"]'),
  ];
  for (const locator of selectors) {
    if (await isVisible(locator)) return true;
  }
  return false;
}

async function maybeAdvanceDatabricksLogin(page) {
  const clicked = await clickFirstVisible([
    page.getByRole('button', { name: /sign in|log in|login/i }),
    page.getByRole('link', { name: /sign in|log in|login/i }),
    page.getByRole('button', { name: /microsoft|entra|sso|single sign[- ]?on|company/i }),
    page.getByRole('link', { name: /microsoft|entra|sso|single sign[- ]?on|company/i }),
    page.locator('a[href*="login"]'),
  ]);

  if (clicked) return true;

  return page.evaluate(() => {
    const queue = [document];
    const candidates = [];

    while (queue.length > 0) {
      const root = queue.shift();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;

      while (node) {
        if (node.shadowRoot) queue.push(node.shadowRoot);

        const text = (node.innerText || node.textContent || '').trim();
        const href = node.getAttribute && node.getAttribute('href');
        const role = node.getAttribute && node.getAttribute('role');
        const clickable = node.tagName === 'A' || node.tagName === 'BUTTON' || role === 'button';

        if ((node.tagName === 'A' && href && href.includes('/aad/auth')) || (clickable && /continue with microsoft entra id/i.test(text))) {
          candidates.push(node);
        }

        node = walker.nextNode();
      }
    }

    if (candidates.length === 0) return false;

    candidates
      .sort((left, right) => ((left.innerText || left.textContent || '').length - (right.innerText || right.textContent || '').length))[0]
      .click();
    return true;
  }).catch(() => false);
}

async function maybeAdvanceMicrosoftPrompt(page) {
  const emailInput = page.locator('#i0116, input[name="loginfmt"], input[type="email"]');
  const passwordInput = page.locator('#i0118, input[name="passwd"], input[type="password"]');
  if (await isVisible(emailInput) || await isVisible(passwordInput)) {
    return false;
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');

  if (/pick an account/i.test(bodyText)) {
    const accountTile = page.getByText(/@[^\s]+/i).first();
    if (await isVisible(accountTile)) {
      try {
        await accountTile.click();
        return true;
      } catch {}
    }
  }

  if (/stay signed in/i.test(bodyText)) {
    return clickFirstVisible([
      page.locator('#idBtn_Back'),
      page.getByRole('button', { name: /^no$/i }),
      page.locator('#idSIButton9'),
      page.getByRole('button', { name: /^yes$/i }),
      page.getByRole('button', { name: /^continue$/i }),
    ]);
  }

  const accountTile = page.getByText(/@[^\s]+/i).first();
  if (await isVisible(accountTile) && !/enter password/i.test(bodyText)) {
    try {
      await accountTile.click();
      return true;
    } catch {}
  }

  return false;
}

function relayLines(log, text) {
  if (!text) return;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) emit(log, trimmed);
  }
}

function refreshMicrosoftSeedAuth(options = {}) {
  const seedStateFile = options.seedStateFile || DEFAULT_MS_AUTH_STATE_FILE;
  const headless = options.headless === undefined ? asBool(process.env.HEADLESS, true) : Boolean(options.headless);
  const log = options.log;
  const authScriptPath = path.join(__dirname, 'genie-auth-microsoft.js');

  if (seedMicrosoftStateFromWorkspaceState(seedStateFile, options.stateFile || '')) {
    emit(log, `Seeded standalone Microsoft auth from an existing Genie workspace state: ${seedStateFile}`);
    return;
  }

  emit(log, 'Refreshing standalone Microsoft auth for Genie...');

  const result = spawnSync(process.execPath, [authScriptPath], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      AUTH_STATE_PATH: seedStateFile,
      FORCE_RELOGIN: '1',
      HEADLESS: headless ? '1' : '0',
      GENIE_WORKSPACE_URL: options.workspaceUrl || process.env.GENIE_WORKSPACE_URL || '',
      GENIE_PROFILE: options.profileName || process.env.GENIE_PROFILE || process.env.DATABRICKS_CONFIG_PROFILE || '',
    },
  });

  if (result.error) {
    throw result.error;
  }

  relayLines(log, result.stdout);
  relayLines(log, result.stderr);

  if (result.status !== 0) {
    throw new Error(`Microsoft auth refresh failed with status ${result.status}.`);
  }
}

async function waitForDatabricksReady(page, context, options) {
  const { workspaceUrl, timeoutMs, headless, log } = options;
  const deadline = createDeadline(timeoutMs);
  let authenticatedAt = 0;
  let promptedForManualMicrosoftLogin = false;

  while (Date.now() < deadline) {
    const validated = await validateDatabricksContext(context, workspaceUrl);
    if (validated.ok) {
      if (!authenticatedAt) {
        authenticatedAt = Date.now();
        emit(log, 'Databricks session is authenticated. Finalizing Genie workspace state...');
      }

      if (await hasGenieInput(page)) {
        return {
          ...validated,
          currentUrl: page.url(),
          orgId: getOrgIdFromUrl(page.url()),
          workspaceUser: await detectWorkspaceUser(page),
          readyVia: 'genie-input',
        };
      }

      await openAssistant(page);

      if (await hasGenieInput(page)) {
        return {
          ...validated,
          currentUrl: page.url(),
          orgId: getOrgIdFromUrl(page.url()),
          workspaceUser: await detectWorkspaceUser(page),
          readyVia: 'assistant-opened',
        };
      }

      if (Date.now() - authenticatedAt >= 5000) {
        return {
          ...validated,
          currentUrl: page.url(),
          orgId: getOrgIdFromUrl(page.url()),
          workspaceUser: await detectWorkspaceUser(page),
          readyVia: 'session-info',
        };
      }
    }

    const currentUrl = page.url();
    if (isMicrosoftHost(currentUrl)) {
      const advanced = await maybeAdvanceMicrosoftPrompt(page);
      if (advanced) {
        await page.waitForTimeout(1000);
        continue;
      }

      if (await hasVisibleMicrosoftLogin(page)) {
        if (headless) {
          throw new Error(
            'Microsoft sign-in is required before Databricks can authenticate. Refresh the standalone Genie Microsoft auth first with: npm run genie:auth:ms'
          );
        }

        if (!promptedForManualMicrosoftLogin) {
          emit(log, 'Complete the Microsoft sign-in in the opened browser window to finish Databricks auth.');
          promptedForManualMicrosoftLogin = true;
        }
      }
    } else if (isDatabricksHost(currentUrl)) {
      const advanced = await maybeAdvanceDatabricksLogin(page);
      if (advanced) {
        await page.waitForTimeout(1000);
        continue;
      }

      await openAssistant(page);
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`Timed out waiting for Databricks authentication after ${timeoutMs}ms.`);
}

async function bootstrapDatabricksAuthState(options = {}) {
  const stateFile = options.stateFile || DEFAULT_GENIE_STATE_FILE;
  const seedStateFile = options.seedStateFile || DEFAULT_MS_AUTH_STATE_FILE;
  const workspaceUrl = options.workspaceUrl || DEFAULT_GENIE_WORKSPACE_URL;
  const metadataFile = options.metadataFile || '';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_AUTH_TIMEOUT_MS;
  const headless = options.headless === undefined ? asBool(process.env.HEADLESS, true) : Boolean(options.headless);
  const log = options.log;

  seedMicrosoftStateFromWorkspaceState(seedStateFile, stateFile);
  const useSeedState = fs.existsSync(seedStateFile);

  if (!useSeedState && headless) {
    throw new Error(
      `Microsoft auth seed not found at ${seedStateFile}. Run npm run genie:auth:ms first, or rerun genie auth with --headed for manual sign-in.`
    );
  }

  if (!workspaceUrl) {
    throw new Error('Missing Databricks workspace URL. Pass --profile or --url.');
  }

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  emit(log, useSeedState
    ? `Refreshing Databricks auth from ${seedStateFile}...`
    : 'Seed auth state not found; starting manual Databricks sign-in...');

  const browser = await chromium.launch({ headless });
  let context;

  try {
    context = useSeedState
      ? await browser.newContext({ storageState: seedStateFile })
      : await browser.newContext();

    const page = await context.newPage();
    await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const validated = await waitForDatabricksReady(page, context, { workspaceUrl, timeoutMs, headless, log });

    await context.storageState({ path: stateFile });
    if (seedStateFile) {
      ensureParentDirectory(seedStateFile);
      await context.storageState({ path: seedStateFile });
    }

    const metadata = {
      workspaceUrl: validated.currentUrl || page.url() || workspaceUrl,
      orgId: validated.orgId || getOrgIdFromUrl(validated.currentUrl || page.url() || workspaceUrl),
      workspaceUser: validated.workspaceUser || '',
      origin: validated.origin || getOrigin(workspaceUrl),
      host: getHost(workspaceUrl),
      seedStateFile: useSeedState ? seedStateFile : '',
      updatedAt: new Date().toISOString(),
    };

    if (metadataFile) {
      saveWorkspaceMetadata(metadataFile, metadata);
    }

    return {
      ok: true,
      refreshed: true,
      stateFile,
      metadataFile,
      seedStateFile: useSeedState ? seedStateFile : '',
      workspaceUrl: metadata.workspaceUrl,
      orgId: metadata.orgId,
      workspaceUser: metadata.workspaceUser,
      metadata,
      ...validated,
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}

async function ensureDatabricksAuthState(options = {}) {
  const stateFile = options.stateFile || DEFAULT_GENIE_STATE_FILE;
  const workspaceUrl = options.workspaceUrl || DEFAULT_GENIE_WORKSPACE_URL;
  const metadataFile = options.metadataFile || '';
  const seedStateFile = options.seedStateFile || DEFAULT_MS_AUTH_STATE_FILE;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_AUTH_TIMEOUT_MS;
  const autoRefresh = options.autoRefresh === undefined ? asBool(process.env.GENIE_AUTH_AUTO, true) : Boolean(options.autoRefresh);
  const forceRefresh = Boolean(options.forceRefresh);
  const refreshMicrosoftAuth = options.refreshMicrosoftAuth === undefined
    ? asBool(process.env.GENIE_AUTH_REFRESH_MS, true)
    : Boolean(options.refreshMicrosoftAuth);
  const log = options.log;

  if (!forceRefresh) {
    const existing = await validateDatabricksStateFile(stateFile, workspaceUrl, metadataFile);
    if (existing.ok) {
      seedMicrosoftStateFromWorkspaceState(seedStateFile, stateFile);
      return {
        ...existing,
        refreshed: false,
        metadataFile,
        seedStateFile,
        workspaceUrl: (existing.metadata && existing.metadata.workspaceUrl) || workspaceUrl,
        orgId: existing.metadata && existing.metadata.orgId ? existing.metadata.orgId : getOrgIdFromUrl(workspaceUrl),
        workspaceUser: existing.metadata && existing.metadata.workspaceUser ? existing.metadata.workspaceUser : '',
      };
    }

    if (!autoRefresh) {
      throw new Error(existing.reason || `Databricks auth is not valid: ${stateFile}`);
    }

    emit(log, `Databricks auth is missing or expired. ${existing.reason || ''}`.trim());
  } else {
    emit(log, 'Force-refreshing Databricks auth state...');
  }

  const bootstrapOptions = {
    ...options,
      stateFile,
      metadataFile,
      seedStateFile,
      workspaceUrl,
      timeoutMs,
  };

  try {
    return await bootstrapDatabricksAuthState(bootstrapOptions);
  } catch (error) {
    if (!refreshMicrosoftAuth) {
      throw error;
    }

    emit(log, `Databricks bootstrap from standalone Microsoft auth did not complete: ${error.message || String(error)}`);
    refreshMicrosoftSeedAuth({
      seedStateFile,
      stateFile,
      profileName: options.profileName,
      workspaceUrl,
      headless: bootstrapOptions.headless,
      log,
    });
    return bootstrapDatabricksAuthState(bootstrapOptions);
  }
}

module.exports = {
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_GENIE_STATE_FILE,
  DEFAULT_GENIE_WORKSPACE_URL,
  DEFAULT_MS_AUTH_STATE_FILE,
  bootstrapDatabricksAuthState,
  ensureDatabricksAuthState,
  validateDatabricksStateFile,
};
