const { chromium } = require('playwright');
const OTPAuth = require('otpauth');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveWorkspaceSelection } = require('./genie-workspace');

const skillRoot = path.resolve(__dirname, '..');
const authPath = process.env.AUTH_STATE_PATH || process.env.GENIE_MS_AUTH_STATE_FILE || path.join(skillRoot, 'playwright', '.auth', 'microsoft.json');
const failureScreenshotPath = path.join(path.dirname(authPath), 'microsoft-login-failure.png');

const username = process.env.MS_USERNAME || process.env.ENTRA_ACCOUNT || '';
const envPassword = process.env.MS_PASSWORD || process.env.ENTRA_PASSWORD || '';
const envTotpSecret = process.env.MS_TOTP_SECRET || '';

const headless = asBool(process.env.HEADLESS, true);
const useExistingAuthState = asBool(process.env.USE_EXISTING_AUTH_STATE, true);
const forceRelogin = asBool(process.env.FORCE_RELOGIN, false);
const staySignedIn = (process.env.STAY_SIGNED_IN || 'no').toLowerCase();
const loginWaitTimeoutMs = Number.parseInt(process.env.LOGIN_WAIT_TIMEOUT_MS || '180000', 10);
const ssoRedirectTimeoutMs = Number.parseInt(process.env.SSO_REDIRECT_TIMEOUT_MS || '15000', 10);
const useAgentBrowserAuth = asBool(process.env.USE_AGENT_BROWSER_AUTH, true);
const allowEnvSecretFallback = asBool(process.env.ALLOW_ENV_SECRET_FALLBACK, false);
const agentBrowserAuthProfile = process.env.AB_AUTH_PROFILE || 'jira-secrets';
const agentBrowserDir = process.env.AGENT_BROWSER_HOME || path.join(os.homedir(), '.agent-browser');
const EMAIL_SELECTOR = '#i0116:not([aria-hidden="true"]):not(.moveOffScreen), input[name="loginfmt"]:not([aria-hidden="true"]):not(.moveOffScreen)';
const PASSWORD_SELECTOR = '#i0118:not([aria-hidden="true"]):not(.moveOffScreen), input[name="passwd"]:not([aria-hidden="true"]):not(.moveOffScreen)';
const OTP_SELECTOR = '#idTxtBx_SAOTCC_OTC:not([aria-hidden="true"]):not(.moveOffScreen), input[name="otc"]:not([aria-hidden="true"]):not(.moveOffScreen)';

function asBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/genie-auth-microsoft.js --profile sso_commercial_uat');
  console.log('  node scripts/genie-auth-microsoft.js --profile sso_commercial_uat --headed');
  console.log('  node scripts/genie-auth-microsoft.js --profile sso_commercial_uat --force');
}

function parseArgs(argv) {
  const options = {
    profileName: process.env.GENIE_PROFILE || process.env.DATABRICKS_CONFIG_PROFILE || '',
    workspaceUrl: process.env.GENIE_WORKSPACE_URL || '',
    headless,
    forceRelogin,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

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

    if (arg === '--headed') {
      options.headless = false;
      continue;
    }

    if (arg === '--headless') {
      options.headless = true;
      continue;
    }

    if (arg === '--force' || arg === '--refresh') {
      options.forceRelogin = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function getHost(urlString) {
  try {
    return new URL(urlString).host;
  } catch {
    return '';
  }
}

function isMicrosoftHost(urlString) {
  return getHost(urlString).endsWith('microsoftonline.com');
}

function decryptAgentBrowserProfile(profileName) {
  const keyPath = path.join(agentBrowserDir, '.encryption-key');
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `agent-browser encryption key not found at ${keyPath}. Run: agent-browser auth save ${profileName} --url <url> --username <user> --password-stdin`
    );
  }

  const profilePath = path.join(agentBrowserDir, 'auth', `${profileName}.json`);
  if (!fs.existsSync(profilePath)) {
    throw new Error(
      `agent-browser auth profile "${profileName}" not found at ${profilePath}. Run: agent-browser auth save ${profileName} --url <url> --username <user> --password-stdin`
    );
  }

  const keyHex = fs.readFileSync(keyPath, 'utf-8').trim();
  const key = Buffer.from(keyHex, 'hex');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));

  if (!profile.encrypted) {
    return JSON.parse(profile.data || '{}');
  }

  const iv = Buffer.from(profile.iv, 'base64');
  const authTag = Buffer.from(profile.authTag, 'base64');
  const encrypted = Buffer.from(profile.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf-8'));
}

function getSecretBundleFromAgentBrowser(profileName) {
  const profile = decryptAgentBrowserProfile(profileName);
  const passwordField = profile.password || '';
  if (!passwordField) {
    throw new Error(
      `agent-browser auth profile "${profileName}" has no password field. Save the JSON secret bundle as the password.`
    );
  }
  return passwordField;
}

function parseSecretBundle(rawValue) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawValue).trim());
  } catch {
    throw new Error('Secret bundle is not valid JSON. Expected format: {"password":"...","totpSecret":"..."}.');
  }

  const password = String(parsed.password || parsed.msPassword || parsed.MS_PASSWORD || parsed.entraPassword || '').trim();
  const totpSecret = String(parsed.totpSecret || parsed.msTotpSecret || parsed.MS_TOTP_SECRET || parsed.totp || parsed.entraTotpSecret || '').trim();
  const bundleUsername = String(parsed.username || parsed.msUsername || parsed.MS_USERNAME || parsed.entraAccount || parsed.account || '').trim();

  if (!password || !totpSecret) {
    throw new Error('Secret bundle must contain both password and totpSecret fields.');
  }

  return {
    password,
    totpSecret,
    username: bundleUsername,
  };
}

function loadSecrets(required) {
  if (useAgentBrowserAuth) {
    try {
      const bundleValue = getSecretBundleFromAgentBrowser(agentBrowserAuthProfile);
      const parsed = parseSecretBundle(bundleValue);
      console.log('Microsoft secrets loaded from agent-browser auth vault.');
      return {
        password: parsed.password,
        totpSecret: parsed.totpSecret,
        username: username || parsed.username,
      };
    } catch (error) {
      if (!allowEnvSecretFallback && required) {
        throw error;
      }
      if (allowEnvSecretFallback) {
        console.warn(`agent-browser auth vault unavailable, falling back to env vars: ${error.message}`);
      }
    }
  }

  if (envPassword && envTotpSecret) {
    return { password: envPassword, totpSecret: envTotpSecret, username };
  }

  if (required) {
    throw new Error('No Microsoft secrets available. Configure agent-browser auth vault or set MS_PASSWORD and MS_TOTP_SECRET.');
  }

  return null;
}

async function loadSecretsIfNeeded(secretsState) {
  if (secretsState.loaded) {
    return secretsState.value;
  }

  secretsState.value = loadSecrets(false);
  secretsState.loaded = true;
  return secretsState.value;
}

function sanitizeBase32(secret) {
  return String(secret).replace(/\s+/g, '').toUpperCase();
}

function secondsLeft(periodSeconds) {
  return periodSeconds - (Math.floor(Date.now() / 1000) % periodSeconds);
}

function buildTotp(secret) {
  const normalized = sanitizeBase32(secret);
  if (!/^[A-Z2-7]+=*$/.test(normalized)) {
    throw new Error('MS_TOTP_SECRET is not valid Base32.');
  }

  return new OTPAuth.TOTP({
    issuer: 'Microsoft',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(normalized),
  });
}

async function clickFirst(locators, timeoutMs = 3000) {
  for (const locator of locators) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
      await locator.first().click();
      return true;
    } catch {}
  }
  return false;
}

async function maybeAdvanceDatabricksLogin(page) {
  const clicked = await clickFirst([
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
    candidates.sort((left, right) => ((left.innerText || left.textContent || '').length - (right.innerText || right.textContent || '').length))[0].click();
    return true;
  }).catch(() => false);
}

async function buildCookieHeader(context, workspaceUrl) {
  const cookies = await context.cookies();
  const targetHost = getHost(workspaceUrl);
  const pairs = cookies
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
  return { response, text };
}

async function validateDatabricksContext(context, workspaceUrl) {
  try {
    const origin = new URL(workspaceUrl).origin;
    const cookieHeader = await buildCookieHeader(context, workspaceUrl);
    const { response, text } = await requestText(`${origin}/auth/session/info`, {
      method: 'GET',
      headers: {
        cookie: cookieHeader,
        referer: `${origin}/`,
        'user-agent': 'Mozilla/5.0',
      },
    });
    if (!response.ok) {
      return { ok: false, reason: `Failed to fetch session info (${response.status}): ${text.slice(0, 200)}` };
    }
    const parsed = JSON.parse(text);
    return { ok: Boolean(parsed && parsed.csrfToken) };
  } catch (error) {
    return { ok: false, reason: error.message || String(error) };
  }
}

async function ensureEmailStep(page, effectiveUsername) {
  const passwordInput = page.locator(PASSWORD_SELECTOR);
  if (await passwordInput.first().isVisible().catch(() => false)) {
    return false;
  }

  const otpInput = page.locator(OTP_SELECTOR);
  if (await otpInput.first().isVisible().catch(() => false)) {
    return false;
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const isAccountPicker = /pick an account|choose an account|select an account|vælg en konto/i.test(bodyText);
  const rememberedAccount = effectiveUsername ? page.locator(`[data-test-id="${effectiveUsername}"]`) : null;
  if (isAccountPicker && rememberedAccount && await rememberedAccount.first().isVisible().catch(() => false)) {
    console.log('Microsoft account picker detected; clicking remembered account tile.');
    // Use a long timeout: the tile can be unstable during animation but will stabilize.
    // Swallow timeout errors — the click may have fired successfully even if the timeout elapsed.
    await rememberedAccount.first().click({ timeout: 60000 }).catch(() => {});
    return true;
  }

  const accountTile = isAccountPicker && effectiveUsername
    ? page.getByText(new RegExp(effectiveUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first()
    : null;
  if (accountTile && await accountTile.isVisible().catch(() => false)) {
    console.log('Microsoft account picker detected; clicking account text match.');
    await accountTile.click({ timeout: 60000 }).catch(() => {});
    return true;
  }

  if (isAccountPicker) {
    // No username known — click the first visible account option in the picker
    const firstTile = page.locator('[data-test-id]').first();
    if (await firstTile.isVisible().catch(() => false)) {
      console.log('Microsoft account picker detected (no username); clicking first account tile.');
      await firstTile.click({ timeout: 60000 }).catch(() => {});
      return true;
    }
    // Fallback: click first list item that looks like an account row
    const firstListItem = page.locator('div[role="option"], li[role="option"], .table > div').first();
    if (await firstListItem.isVisible().catch(() => false)) {
      console.log('Microsoft account picker detected (no username); clicking first list item.');
      await firstListItem.click({ timeout: 60000 }).catch(() => {});
      return true;
    }
  }

  const emailInput = page.locator(EMAIL_SELECTOR);
  if (!await emailInput.first().isVisible().catch(() => false)) return false;
  if (!effectiveUsername) {
    throw new Error('Missing required env var MS_USERNAME (or ENTRA_ACCOUNT).');
  }
  console.log(`Microsoft email step detected; filling username: ${effectiveUsername}`);
  await emailInput.first().fill(effectiveUsername);
  const submitted = await clickFirst([
    page.locator('#idSIButton9'),
    page.getByRole('button', { name: /next|sign in/i }),
    page.locator('input[type="submit"]'),
  ], 10000);
  if (!submitted) {
    await emailInput.first().press('Enter').catch(() => {});
  }
  return true;
}

async function ensurePasswordStep(page, secretsState, manualPromptState) {
  const emailInput = page.locator(EMAIL_SELECTOR);
  if (await emailInput.first().isVisible().catch(() => false)) return false;

  const passwordInput = page.locator(PASSWORD_SELECTOR);
  if (!await passwordInput.first().isVisible().catch(() => false)) return false;

  console.log('Microsoft password step detected.');
  const secrets = await loadSecretsIfNeeded(secretsState);

  if (!secrets || !secrets.password) {
    if (headless) {
      throw new Error('Microsoft password is required for headless sign-in. Configure agent-browser auth vault or set MS_PASSWORD.');
    }
    if (!manualPromptState.password) {
      console.log('Complete the Microsoft password step in the opened browser window.');
      manualPromptState.password = true;
    }
    return false;
  }

  await passwordInput.first().fill(secrets.password);
  const submitted = await clickFirst([
    page.locator('#idSIButton9'),
    page.getByRole('button', { name: /sign in|log in|next/i }),
    page.locator('input[type="submit"]'),
  ], 10000);
  if (!submitted) {
    await passwordInput.first().press('Enter').catch(() => {});
  }
  return true;
}

async function maybeSwitchToOtp(page) {
  await clickFirst([
    page.locator('a#signInAnotherWay'),
    page.getByRole('link', { name: /use another authentication method/i }),
    page.getByText(/i can.t use my microsoft authenticator app right now/i),
  ], 3000);

  return clickFirst([
    page.locator('div[data-value="PhoneAppOTP"]'),
    page.getByText(/use verification code/i),
    page.getByText(/verification code/i),
  ], 5000);
}

async function ensureOtpStep(page, secretsState, manualPromptState) {
  const emailInput = page.locator(EMAIL_SELECTOR);
  if (await emailInput.first().isVisible().catch(() => false)) return false;

  const passwordInput = page.locator(PASSWORD_SELECTOR);
  if (await passwordInput.first().isVisible().catch(() => false)) return false;

  const otpInput = page.locator(OTP_SELECTOR);
  if (!await otpInput.first().isVisible().catch(() => false)) return false;

  console.log('Microsoft verification-code step detected.');
  const secrets = await loadSecretsIfNeeded(secretsState);

  if (!secrets || !secrets.totpSecret) {
    if (headless) {
      throw new Error('Microsoft TOTP is required for headless sign-in. Configure agent-browser auth vault or set MS_TOTP_SECRET.');
    }
    if (!manualPromptState.otp) {
      console.log('Complete the Microsoft verification-code step in the opened browser window.');
      manualPromptState.otp = true;
    }
    return false;
  }

  const totp = buildTotp(secrets.totpSecret);
  const remaining = secondsLeft(totp.period);
  if (remaining < 8) {
    await sleep((remaining + 1) * 1000);
  }

  await otpInput.first().fill(totp.generate());
  await clickFirst([
    page.locator('#idSubmit_SAOTCC_Continue'),
    page.locator('#idSIButton9'),
    page.getByRole('button', { name: /verify|next|sign in/i }),
    page.locator('input[type="submit"]'),
  ], 10000);
  return true;
}

async function handleStaySignedIn(page) {
  const promptRegex = /stay signed in|forblive logget på|vil du forblive logget på/i;
  const promptLocator = page.getByText(promptRegex, { exact: false });

  try {
    await promptLocator.first().waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    return false;
  }

  if (staySignedIn === 'yes' || staySignedIn === 'true') {
    return clickFirst([
      page.locator('#idSIButton9'),
      page.getByRole('button', { name: /yes|ja|continue/i }),
      page.locator('input[type="submit"]'),
    ], 8000);
  }

  return clickFirst([
    page.locator('#idBtn_Back'),
    page.getByRole('button', { name: /no|nej/i }),
    page.locator('button[type="button"]'),
  ], 8000);
}

async function getVisibleMicrosoftError(page) {
  const candidates = [
    page.locator('#usernameError'),
    page.locator('#passwordError'),
    page.locator('#idTD_Error'),
    page.getByRole('alert'),
  ];

  for (const locator of candidates) {
    const visible = await locator.first().isVisible().catch(() => false);
    if (!visible) continue;
    const text = await locator.first().innerText().catch(() => '');
    if (text && text.trim()) return text.trim();
  }

  return '';
}

async function getMicrosoftStageSnapshot(page, effectiveUsername) {
  return page.evaluate(({ emailSelector, passwordSelector, otpSelector, effectiveUsername }) => {
    const isVisibleElement = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.hidden
        && element.getAttribute('aria-hidden') !== 'true'
        && !element.classList.contains('moveOffScreen')
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };

    const findVisible = (selector) => {
      const element = document.querySelector(selector);
      return isVisibleElement(element) ? element : null;
    };

    const visibleText = (selector) => {
      const element = document.querySelector(selector);
      if (!isVisibleElement(element)) return '';
      return (element.innerText || element.textContent || '').trim();
    };

    const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').trim();
    const lowerUser = String(effectiveUsername || '').trim().toLowerCase();
    const hasAccountTile = lowerUser
      ? Array.from(document.querySelectorAll('[data-test-id], div, span, button, a'))
          .some((element) => isVisibleElement(element) && ((element.innerText || element.textContent || '').trim().toLowerCase().includes(lowerUser)))
      : true; // If username is unknown, assume any account-picker heading means the picker is present
    const accountPicker = /pick an account|choose an account|select an account|vælg en konto/i.test(bodyText) && hasAccountTile;
    const emailVisible = Boolean(findVisible(emailSelector));
    const passwordVisible = !emailVisible && Boolean(findVisible(passwordSelector));
    const otpVisible = !emailVisible && !passwordVisible && Boolean(findVisible(otpSelector));
    const otpSwitchVisible = !emailVisible && !passwordVisible && !otpVisible && (
      Boolean(findVisible('a#signInAnotherWay'))
      || Array.from(document.querySelectorAll('div[data-value="PhoneAppOTP"], a, button, div'))
        .some((element) => isVisibleElement(element) && /use verification code|verification code/i.test((element.innerText || element.textContent || '').trim()))
    );
    const staySignedInVisible = !emailVisible && !passwordVisible && !otpVisible && /stay signed in|forblive logget på|vil du forblive logget på/i.test(bodyText);
    const errorText = visibleText('#usernameError') || visibleText('#passwordError') || visibleText('#idTD_Error');

    let stage = 'unknown';
    if (!location.host.endsWith('microsoftonline.com')) {
      stage = 'redirected';
    } else if (accountPicker) {
      stage = 'account-picker';
    } else if (emailVisible) {
      stage = 'email';
    } else if (passwordVisible) {
      stage = 'password';
    } else if (otpSwitchVisible) {
      stage = 'otp-switch';
    } else if (otpVisible) {
      stage = 'otp';
    } else if (staySignedInVisible) {
      stage = 'stay-signed-in';
    }

    return {
      stage,
      errorText,
      url: location.href,
    };
  }, {
    emailSelector: EMAIL_SELECTOR,
    passwordSelector: PASSWORD_SELECTOR,
    otpSelector: OTP_SELECTOR,
    effectiveUsername,
  });
}

async function waitForNextMicrosoftStage(page, previousStage, effectiveUsername, timeoutMs) {
  const redirectWait = page.waitForURL((url) => !String(url).includes('microsoftonline.com'), { timeout: timeoutMs })
    .then(async () => {
      // Wait briefly in case this is an intermediate OAuth redirect that returns to Microsoft
      await page.waitForTimeout(1500).catch(() => {});
      const snap = await getMicrosoftStageSnapshot(page, effectiveUsername);
      // Only count as a real redirect if we're actually away from Microsoft login
      return snap.stage === 'redirected' ? snap : null;
    })
    .catch(() => null);

  const stageWait = page.waitForFunction(
    ({ previousStage, emailSelector, passwordSelector, otpSelector, effectiveUsername }) => {
      const isVisibleElement = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return !element.hidden
          && element.getAttribute('aria-hidden') !== 'true'
          && !element.classList.contains('moveOffScreen')
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && rect.width > 0
          && rect.height > 0;
      };

      const findVisible = (selector) => {
        const element = document.querySelector(selector);
        return isVisibleElement(element) ? element : null;
      };

      const visibleText = (selector) => {
        const element = document.querySelector(selector);
        if (!isVisibleElement(element)) return '';
        return (element.innerText || element.textContent || '').trim();
      };

      const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').trim();
      const lowerUser = String(effectiveUsername || '').trim().toLowerCase();
      const hasAccountTile = lowerUser
        ? Array.from(document.querySelectorAll('[data-test-id], div, span, button, a'))
            .some((element) => isVisibleElement(element) && ((element.innerText || element.textContent || '').trim().toLowerCase().includes(lowerUser)))
        : true; // If username is unknown, assume any account-picker heading means the picker is present
      const accountPicker = /pick an account|choose an account|select an account|vælg en konto/i.test(bodyText) && hasAccountTile;
      const emailVisible = Boolean(findVisible(emailSelector));
      const passwordVisible = !emailVisible && Boolean(findVisible(passwordSelector));
      const otpVisible = !emailVisible && !passwordVisible && Boolean(findVisible(otpSelector));
      const otpSwitchVisible = !emailVisible && !passwordVisible && !otpVisible && (
        Boolean(findVisible('a#signInAnotherWay'))
        || Array.from(document.querySelectorAll('div[data-value="PhoneAppOTP"], a, button, div'))
          .some((element) => isVisibleElement(element) && /use verification code|verification code/i.test((element.innerText || element.textContent || '').trim()))
      );
      const staySignedInVisible = !emailVisible && !passwordVisible && !otpVisible && /stay signed in|forblive logget på|vil du forblive logget på/i.test(bodyText);
      const errorText = visibleText('#usernameError') || visibleText('#passwordError') || visibleText('#idTD_Error');

      let stage = 'unknown';
      if (!location.host.endsWith('microsoftonline.com')) {
        stage = 'redirected';
      } else if (accountPicker) {
        stage = 'account-picker';
      } else if (emailVisible) {
        stage = 'email';
      } else if (passwordVisible) {
        stage = 'password';
      } else if (otpSwitchVisible) {
        stage = 'otp-switch';
      } else if (otpVisible) {
        stage = 'otp';
      } else if (staySignedInVisible) {
        stage = 'stay-signed-in';
      }

      if (stage === 'redirected') {
        return { stage, errorText, url: location.href };
      }

      if (errorText) {
        return { stage, errorText, url: location.href };
      }

      if (stage !== 'unknown' && stage !== previousStage) {
        return { stage, errorText, url: location.href };
      }

      return null;
    },
    { timeout: timeoutMs, polling: 'mutation' },
    {
      previousStage,
      emailSelector: EMAIL_SELECTOR,
      passwordSelector: PASSWORD_SELECTOR,
      otpSelector: OTP_SELECTOR,
      effectiveUsername,
    }
  ).then(async (handle) => {
    const value = await handle.jsonValue();
    await handle.dispose();
    return value;
  }).catch(() => null);

  const snapshot = await Promise.race([redirectWait, stageWait]);
  if (snapshot) return snapshot;

  const finalSnapshot = await getMicrosoftStageSnapshot(page, effectiveUsername);
  if (finalSnapshot.errorText) return finalSnapshot;
  if (finalSnapshot.stage !== 'unknown' && finalSnapshot.stage !== previousStage) return finalSnapshot;
  throw new Error(`Timed out waiting for Microsoft auth transition from ${previousStage || 'start'} after ${timeoutMs}ms.`);
}

function remainingTime(deadline) {
  return Math.max(1, deadline - Date.now());
}

async function runMicrosoftLogin(page, secretsState) {
  const deadline = Date.now() + loginWaitTimeoutMs;
  const manualPromptState = { password: false, otp: false };
  // Load secrets eagerly so effectiveUsername is available for account-picker detection
  await loadSecretsIfNeeded(secretsState);
  const effectiveUsername = String((secretsState.value && secretsState.value.username) || username || '').trim();
  let snapshot = await waitForNextMicrosoftStage(page, '', effectiveUsername, remainingTime(deadline));

  while (Date.now() < deadline) {
    if (!snapshot) {
      snapshot = await getMicrosoftStageSnapshot(page, effectiveUsername);
    }

    if (snapshot.errorText) {
      throw new Error(`Microsoft sign-in is stuck on the ${snapshot.stage} step: ${snapshot.errorText}`);
    }

    if (snapshot.stage === 'redirected') {
      return;
    }

    if (snapshot.stage === 'account-picker' || snapshot.stage === 'email') {
      await ensureEmailStep(page, effectiveUsername);
      snapshot = await waitForNextMicrosoftStage(page, snapshot.stage, effectiveUsername, remainingTime(deadline));
      continue;
    }

    if (snapshot.stage === 'password') {
      await ensurePasswordStep(page, secretsState, manualPromptState);
      snapshot = await waitForNextMicrosoftStage(page, snapshot.stage, effectiveUsername, remainingTime(deadline));
      continue;
    }

    if (snapshot.stage === 'otp-switch') {
      await maybeSwitchToOtp(page);
      snapshot = await waitForNextMicrosoftStage(page, snapshot.stage, effectiveUsername, remainingTime(deadline));
      continue;
    }

    if (snapshot.stage === 'otp') {
      await ensureOtpStep(page, secretsState, manualPromptState);
      snapshot = await waitForNextMicrosoftStage(page, snapshot.stage, effectiveUsername, remainingTime(deadline));
      continue;
    }

    if (snapshot.stage === 'stay-signed-in') {
      await handleStaySignedIn(page);
      snapshot = await waitForNextMicrosoftStage(page, snapshot.stage, effectiveUsername, remainingTime(deadline));
      continue;
    }

    snapshot = await waitForNextMicrosoftStage(page, snapshot.stage, effectiveUsername, remainingTime(deadline));
  }

  throw new Error(`Timed out waiting for Microsoft sign-in after ${loginWaitTimeoutMs}ms.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workspace = resolveWorkspaceSelection({
    profileName: options.profileName,
    workspaceUrl: options.workspaceUrl,
  });

  fs.mkdirSync(path.dirname(authPath), { recursive: true });

  if (!fs.existsSync(authPath) && fs.existsSync(workspace.stateFile)) {
    fs.copyFileSync(workspace.stateFile, authPath);
  }

  const browser = await chromium.launch({ headless: options.headless });
  let context;
  let page;

  try {
    if (useExistingAuthState && !options.forceRelogin && fs.existsSync(authPath)) {
      context = await browser.newContext({ storageState: authPath });
      console.log(`Loaded Microsoft auth state from ${authPath}`);
    } else {
      context = await browser.newContext();
    }

    page = await context.newPage();
    await page.goto(workspace.workspaceUrl, { waitUntil: 'domcontentloaded', timeout: loginWaitTimeoutMs });

    const start = Date.now();
    const loadedSecrets = { loaded: false, value: null };
    let promptedForManual = false;

    while (Date.now() - start < loginWaitTimeoutMs) {
      const validated = await validateDatabricksContext(context, workspace.workspaceUrl);
      if (validated.ok) {
        await context.storageState({ path: authPath });
        console.log(`Saved Microsoft auth state to ${authPath}`);
        console.log(`workspace: ${workspace.profileName}`);
        console.log(`workspace url: ${workspace.workspaceUrl}`);
        return;
      }

      if (isMicrosoftHost(page.url())) {
        if (!options.headless && !promptedForManual) {
          console.log(`Microsoft auth page: ${page.url()}`);
          console.log('Debug mode: browser is headed, watching for email/password/verification transitions.');
          console.log('Secrets are loaded from agent-browser auth vault (or env vars if configured).');
          promptedForManual = true;
        }
        await runMicrosoftLogin(page, loadedSecrets);
      } else {
        const advanced = await maybeAdvanceDatabricksLogin(page);
        if (!advanced && !options.headless && !promptedForManual) {
          console.log('Complete the Microsoft sign-in in the opened browser window to refresh standalone Genie auth.');
          promptedForManual = true;
        }
      }

      await page.waitForTimeout(1000);
    }

    throw new Error(`Timed out waiting for Databricks authentication after ${loginWaitTimeoutMs}ms.`);
  } catch (error) {
    if (page) {
      await page.screenshot({ path: failureScreenshotPath, fullPage: true }).catch(() => {});
      console.error(`Saved failure screenshot to ${failureScreenshotPath}`);
    }
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
