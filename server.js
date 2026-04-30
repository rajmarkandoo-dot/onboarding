const express = require('express');
const cors = require('cors');
const path = require('path');
const cookie = require('cookie');
const { Pool } = require('pg');
const { Resend } = require('resend');
const { randomInt, randomBytes, createHash, timingSafeEqual } = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use(loadSession);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const TEAM_BOARD_ID = 18408762899;
const ONBOARDING_BOARD_ID = 18408847153;
const SESSION_COOKIE_NAME = 'onboarding_session';
const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 10);
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 8);
const ENFORCE_AUTH = process.env.ENFORCE_AUTH === 'true';

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false'
        ? false
        : (process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false })
    })
  : null;

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const LOCAL_PROFILE_IMAGES = {
  raj: '/images/Raj.jpeg'
};

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function findColumn(columns, aliases) {
  const normalizedAliases = aliases.map(normalize);
  return columns.find((col) => normalizedAliases.includes(normalize(col.title)));
}

function findColumnByContains(columns, fragments) {
  const normalizedFragments = fragments.map(normalize).filter(Boolean);
  return columns.find((col) => {
    const title = normalize(col.title);
    return normalizedFragments.every((fragment) => title.includes(fragment));
  });
}

function resolveStep2Columns(columns) {
  return {
    launchDateColumn:
      findColumn(columns, ['Launch date', 'Launch Date']) ||
      findColumnByContains(columns, ['launch', 'date']),
    spendPerHeadColumn:
      findColumn(columns, ['Spend per head', 'Spend Per Head']) ||
      findColumnByContains(columns, ['spend', 'head']) ||
      findColumnByContains(columns, ['spend']),
    posColumn:
      findColumn(columns, ['POS', 'POS system']) ||
      findColumnByContains(columns, ['pos']) ||
      findColumnByContains(columns, ['point', 'sale']),
    reservationColumn:
      findColumn(columns, ['Reservation System', 'Reservation syst']) ||
      findColumnByContains(columns, ['reservation', 'system']) ||
      findColumnByContains(columns, ['reservation']),
    prepaymentsColumn:
      findColumn(columns, ['PrePayments', 'PrePayments / Card Holds']) ||
      findColumnByContains(columns, ['prepayment']) ||
      findColumnByContains(columns, ['card', 'hold']) ||
      findColumnByContains(columns, ['payment']),
    ipadColumn:
      findColumn(columns, ['iPad', 'iPads available', 'iPads']) ||
      findColumnByContains(columns, ['ipad']) ||
      findColumnByContains(columns, ['apple', 'device']),
    smsColumn:
      findColumn(columns, ['SMS', 'SMS required', 'Sms']) ||
      findColumnByContains(columns, ['sms']) ||
      findColumnByContains(columns, ['text', 'message']),
    textColumn:
      findColumn(columns, ['Text']) ||
      findColumnByContains(columns, ['notes']) ||
      findColumnByContains(columns, ['details']),
    otherIntegrationsColumn:
      findColumn(columns, ['Other Integrations', 'Other integrations / book channels required']) ||
      findColumnByContains(columns, ['other', 'integration']) ||
      findColumnByContains(columns, ['book', 'channel']) ||
      findColumnByContains(columns, ['integration'])
  };
}


function getStep3SectionColumnAliases() {
  return {
    'Venue Configuration': ['Venue Configuration', 'Venue Config', 'Venue Configura...'],
    'Marketing Configuration': ['Marketing Configuration', 'Marketing'],
    'IT Setup': ['IT Setup', 'IT'],
    'Data Imports': ['Data Imports', 'Data'],
    'Go Live': ['Go Live'],
    'Add-ons': ['Add-ons', 'Add ons', 'Addons']
  };
}

function escapeColumnValues(valueObj) {
  return JSON.stringify(valueObj)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}


function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractNotesBlock(notes, label, nextLabels = []) {
  if (!notes) return '';

  const lookahead = nextLabels.length
    ? `(?=\n\n(?:${nextLabels.map((next) => escapeRegex(next)).join('|')}):|$)`
    : '$';

  const pattern = new RegExp(`${escapeRegex(label)}:\n([\s\S]*?)${lookahead}`, 'i');
  const match = notes.match(pattern);
  return match?.[1]?.trim() || '';
}

function extractInlineValue(text, label) {
  if (!text) return '';
  const pattern = new RegExp(`${escapeRegex(label)}:\s*([^\n|]+)`, 'i');
  return text.match(pattern)?.[1]?.trim() || '';
}

function extractLineValue(text, label) {
  if (!text) return '';
  const pattern = new RegExp(`${escapeRegex(label)}:\s*([^\n]+)`, 'i');
  return text.match(pattern)?.[1]?.trim() || '';
}

function parseMondayLink(columnValue) {
  if (!columnValue) return '';

  try {
    const parsed = columnValue.value ? JSON.parse(columnValue.value) : null;
    return parsed?.url || '';
  } catch (error) {
    return '';
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function getSessionSecret() {
  return process.env.SESSION_SECRET || 'local-dev-session-secret';
}

function hashOpaqueToken(token) {
  return sha256(`${token}:${getSessionSecret()}`);
}

function generateOtpCode() {
  return String(randomInt(0, 1000000)).padStart(6, '0');
}

function generateSessionToken() {
  return randomBytes(24).toString('hex');
}

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_HOURS * 60 * 60
  };
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE_NAME, token, getCookieOptions()));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE_NAME, '', {
    ...getCookieOptions(),
    maxAge: 0
  }));
}

function getRequestCookies(req) {
  return cookie.parse(req.headers.cookie || '');
}

async function ensureAuthStorage() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      item_id TEXT,
      mode TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      item_id TEXT,
      role TEXT NOT NULL,
      session_token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    )
  `);
}

async function sendOtpEmail(email, otpCode, mode) {
  if (!resend) {
    throw new Error('Missing Resend configuration');
  }

  const from = process.env.OTP_FROM_EMAIL;
  if (!from) {
    throw new Error('Missing OTP_FROM_EMAIL');
  }

  const subject = mode === 'client'
    ? 'Your SevenRooms onboarding verification code'
    : 'Your SevenRooms OB verification code';
  const body = `Your verification code is ${otpCode}. It expires in ${OTP_TTL_MINUTES} minutes.`;

  await resend.emails.send({
    from,
    to: email,
    subject,
    text: body
  });
}

async function fetchOnboardingItemContext(itemId) {
  const query = `
    query {
      boards(ids: ${ONBOARDING_BOARD_ID}) {
        columns {
          id
          title
          type
        }
      }
      items(ids: [${itemId}]) {
        id
        name
        column_values {
          id
          text
          type
          value
        }
      }
    }
  `;

  const result = await mondayRequest(query);
  const board = result.data?.boards?.[0];
  const item = result.data?.items?.[0];

  if (!board || !item) {
    throw new Error('Onboarding item not found');
  }

  const getText = (aliases, containsFragments = []) => {
    const column =
      findColumn(board.columns, aliases) ||
      (containsFragments.length ? findColumnByContains(board.columns, containsFragments) : null);
    if (!column) return '';
    return item.column_values.find((value) => value.id === column.id)?.text?.trim() || '';
  };

  return {
    itemId: item.id,
    venueName: item.name || '',
    region: getText(['Region']),
    onboarder: getText(['Onboarder']),
    clientName: getText(['Client name']),
    clientEmail: getText(['Client email']),
    salesforceCaseNumber: getText(['Salesforce Case Number', 'Salesforce Case ID', 'SF Case Number', 'Case Number', 'Case ID'], ['case'])
  };
}

async function createOtpRecord(email, itemId, mode) {
  if (!pool) {
    throw new Error('Missing DATABASE_URL');
  }

  const otpCode = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await pool.query(
    `INSERT INTO otp_codes (email, item_id, mode, otp_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [normalize(email), itemId || null, mode, sha256(otpCode), expiresAt]
  );

  return otpCode;
}

async function verifyOtpRecord(email, itemId, mode, otpCode) {
  if (!pool) {
    throw new Error('Missing DATABASE_URL');
  }

  const result = await pool.query(
    `SELECT * FROM otp_codes
     WHERE email = $1
       AND mode = $2
       AND COALESCE(item_id, '') = COALESCE($3, '')
       AND used_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [normalize(email), mode, itemId || '']
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('No OTP request found');
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new Error('OTP has expired');
  }

  if (Number(row.attempt_count || 0) >= 5) {
    throw new Error('Too many OTP attempts');
  }

  const expected = Buffer.from(row.otp_hash, 'hex');
  const actual = Buffer.from(sha256(otpCode), 'hex');
  const valid = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!valid) {
    await pool.query('UPDATE otp_codes SET attempt_count = attempt_count + 1 WHERE id = $1', [row.id]);
    throw new Error('Invalid OTP');
  }

  await pool.query('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [row.id]);
}

async function createSession({ email, role, itemId }) {
  if (!pool) {
    throw new Error('Missing DATABASE_URL');
  }

  const token = generateSessionToken();
  const tokenHash = hashOpaqueToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO app_sessions (email, item_id, role, session_token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [normalize(email), itemId || null, role, tokenHash, expiresAt]
  );

  return token;
}

async function getSessionFromRequest(req) {
  if (!pool) return null;

  const cookies = getRequestCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  const result = await pool.query(
    `SELECT * FROM app_sessions
     WHERE session_token_hash = $1
       AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [hashOpaqueToken(token)]
  );

  const session = result.rows[0];
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;

  return session;
}

async function loadSession(req, res, next) {
  try {
    req.authSession = await getSessionFromRequest(req);
    next();
  } catch (error) {
    next(error);
  }
}

function requireSession(req, res, next) {
  if (!ENFORCE_AUTH) return next();
  if (!req.authSession) {
    return res.status(401).json({ error: 'Verification required' });
  }
  next();
}

function requireObSession(req, res, next) {
  if (!ENFORCE_AUTH) return next();
  if (!req.authSession || req.authSession.role !== 'ob') {
    return res.status(403).json({ error: 'OB verification required' });
  }
  next();
}

function requireScopedItemAccess(req, res, next) {
  if (!ENFORCE_AUTH) return next();
  const session = req.authSession;
  if (!session) {
    return res.status(401).json({ error: 'Verification required' });
  }

  if (session.role === 'ob') {
    return next();
  }

  const targetItemId = String(req.body?.itemId || req.query?.itemId || '').trim();
  if (!targetItemId || String(session.item_id || '') !== targetItemId) {
    return res.status(403).json({ error: 'You do not have access to this onboarding record' });
  }

  next();
}
async function mondayRequest(query) {
  const token = process.env.MONDAY_API_TOKEN;

  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN');
  }

  const response = await globalThis.fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token
    },
    body: JSON.stringify({ query })
  });

  const result = await response.json();

  if (!response.ok || result.errors) {
    throw new Error(JSON.stringify(result.errors || result, null, 2));
  }

  return result;
}

function buildSalesforceObNotes(payload = {}) {
  const lines = [
    'SevenRooms Onboarding',
    '',
    payload.venueName ? `Venue: ${payload.venueName}` : null,
    payload.clientName ? `Client: ${payload.clientName}` : null,
    payload.clientEmail ? `Client Email: ${payload.clientEmail}` : null,
    payload.region ? `Region: ${payload.region}` : null,
    payload.onboarder ? `Onboarder: ${payload.onboarder}` : null,
    payload.launchDate ? `Launch Date: ${payload.launchDate}` : null,
    payload.spendPerHead ? `Spend Per Head: ${payload.spendPerHead}` : null,
    payload.posSystem ? `POS System: ${payload.posSystem}` : null,
    payload.reservationSystem ? `Reservation System: ${payload.reservationSystem}` : null,
    payload.prepayments ? `PrePayments / Card Holds: ${payload.prepayments}` : null,
    payload.prepaymentType ? `Payment Processor: ${payload.prepaymentType}` : null,
    payload.cancellationPeriod ? `Cancellation Period: ${payload.cancellationPeriod}` : null,
    payload.chargeModel ? `Charge Basis: ${payload.chargeModel}` : null,
    payload.localCurrencyAmount ? `Amount: ${payload.localCurrencyAmount}` : null,
    payload.iPads ? `iPads Available: ${payload.iPads}` : null,
    payload.smsRequired ? `SMS Required: ${payload.smsRequired}` : null,
    payload.otherIntegrations ? `Other Integrations: ${payload.otherIntegrations}` : null
  ];

  if (payload.smsRequired === 'Yes') {
    lines.push('');
    lines.push('SMS Details');
    if (payload.companyName) lines.push(`Company Name: ${payload.companyName}`);
    if (payload.businessName) lines.push(`Business Name: ${payload.businessName}`);
    if (payload.businessRegistrationNumber) lines.push(`Business Registration Number: ${payload.businessRegistrationNumber}`);
    if (payload.businessWebsite) lines.push(`Business Website: ${payload.businessWebsite}`);
    if (payload.businessAddress) lines.push(`Business Address: ${payload.businessAddress}`);
    const repName = [payload.repFirstName, payload.repLastName].filter(Boolean).join(' ');
    if (repName) lines.push(`Authorised Representative: ${repName}`);
    if (payload.repPhone) lines.push(`Representative Phone: ${payload.repPhone}`);
    if (payload.repEmail) lines.push(`Representative Email: ${payload.repEmail}`);
  }

  return lines.filter(Boolean).join('\n');
}

async function salesforceRequest(endpoint, options = {}) {
  const baseUrl = process.env.SALESFORCE_BASE_URL;
  const accessToken = process.env.SALESFORCE_ACCESS_TOKEN;

  if (!baseUrl || !accessToken) {
    throw new Error('Missing Salesforce configuration');
  }

  const response = await globalThis.fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(JSON.stringify(data || { status: response.status }, null, 2));
  }

  return data;
}

app.get('/session', (req, res) => {
  const session = req.authSession;
  res.json({
    ok: true,
    authenticated: Boolean(session),
    role: session?.role || null,
    email: session?.email || null,
    itemId: session?.item_id || null
  });
});

app.post('/request-otp', async (req, res) => {
  const { email, itemId, mode } = req.body || {};
  const normalizedEmail = normalize(email);
  const requestedMode = mode === 'client' ? 'client' : 'ob';

  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Missing email' });
  }

  try {
    let resolvedItemId = itemId ? String(itemId).trim() : '';

    if (requestedMode === 'ob') {
      if (!normalizedEmail.endsWith('@sevenrooms.com')) {
        return res.status(403).json({ error: 'Only SevenRooms emails can access the internal flow' });
      }
      resolvedItemId = resolvedItemId || null;
    } else {
      if (!resolvedItemId) {
        return res.status(400).json({ error: 'Missing itemId' });
      }
      const itemContext = await fetchOnboardingItemContext(resolvedItemId);
      if (normalize(itemContext.clientEmail) !== normalizedEmail) {
        return res.status(403).json({ error: 'Email does not match the invited client email' });
      }
    }

    const otpCode = await createOtpRecord(normalizedEmail, resolvedItemId, requestedMode);
    await sendOtpEmail(normalizedEmail, otpCode, requestedMode);

    res.json({ ok: true, message: 'OTP sent' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to send OTP' });
  }
});

app.post('/verify-otp', async (req, res) => {
  const { email, itemId, mode, otp } = req.body || {};
  const normalizedEmail = normalize(email);
  const requestedMode = mode === 'client' ? 'client' : 'ob';
  const resolvedItemId = itemId ? String(itemId).trim() : '';

  if (!normalizedEmail || !otp) {
    return res.status(400).json({ error: 'Missing email or OTP' });
  }

  try {
    if (requestedMode === 'client' && !resolvedItemId) {
      return res.status(400).json({ error: 'Missing itemId' });
    }

    await verifyOtpRecord(normalizedEmail, resolvedItemId, requestedMode, String(otp).trim());
    const sessionToken = await createSession({
      email: normalizedEmail,
      role: requestedMode,
      itemId: requestedMode === 'client' ? resolvedItemId : null
    });

    setSessionCookie(res, sessionToken);
    res.json({ ok: true, role: requestedMode, itemId: requestedMode === 'client' ? resolvedItemId : null });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || 'Failed to verify OTP' });
  }
});

app.post('/logout', async (req, res) => {
  try {
    const cookies = getRequestCookies(req);
    const token = cookies[SESSION_COOKIE_NAME];
    if (pool && token) {
      await pool.query(
        'UPDATE app_sessions SET revoked_at = NOW() WHERE session_token_hash = $1',
        [hashOpaqueToken(token)]
      );
    }
  } catch (error) {
    console.error(error);
  }

  clearSessionCookie(res);
  res.json({ ok: true });
});

async function syncSalesforceCaseNotes(caseNumber, noteBody) {
  if (!caseNumber) {
    return { skipped: true, reason: 'Missing Salesforce case number' };
  }

  const baseUrl = process.env.SALESFORCE_BASE_URL;
  const accessToken = process.env.SALESFORCE_ACCESS_TOKEN;
  const fieldApiName = process.env.SALESFORCE_OB_NOTES_FIELD || 'OB_Notes__c';
  const apiVersion = process.env.SALESFORCE_API_VERSION || 'v60.0';
  const lookupField = process.env.SALESFORCE_CASE_LOOKUP_FIELD || 'CaseNumber';

  if (!baseUrl || !accessToken) {
    return { skipped: true, reason: 'Salesforce not configured' };
  }

  const escapedCaseNumber = String(caseNumber).replace(/'/g, "\\'");
  const soql = `SELECT Id FROM Case WHERE ${lookupField} = '${escapedCaseNumber}' LIMIT 1`;
  const queryResult = await salesforceRequest(`/services/data/${apiVersion}/query/?q=${encodeURIComponent(soql)}`);
  const caseId = queryResult?.records?.[0]?.Id;

  if (!caseId) {
    throw new Error(`Salesforce case not found for ${lookupField} ${caseNumber}`);
  }

  await salesforceRequest(`/services/data/${apiVersion}/sobjects/Case/${caseId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      [fieldApiName]: noteBody
    })
  });

  return { ok: true, caseId, fieldApiName, lookupField };
}

app.get('/onboarders', requireObSession, async (req, res) => {
  const region = String(req.query.region || '').trim();

  if (!region) {
    return res.status(400).json({ error: 'Missing region' });
  }

  const query = `
    query {
      boards(ids: ${TEAM_BOARD_ID}) {
        columns {
          id
          title
        }
        items_page(limit: 500) {
          items {
            name
            column_values {
              id
              text
            }
          }
        }
      }
    }
  `;

  try {
    const result = await mondayRequest(query);
    const board = result.data?.boards?.[0];

    if (!board) {
      return res.status(500).json({ error: 'Team board not found' });
    }

    const regionColumn = findColumn(board.columns, ['Region']);

    if (!regionColumn) {
      return res.status(500).json({
        error: 'Region column not found on Team board',
        columns: board.columns.map((col) => ({ id: col.id, title: col.title }))
      });
    }

    const onboarders = (board.items_page?.items || [])
      .filter((item) =>
        item.column_values.some(
          (col) => col.id === regionColumn.id && normalize(col.text) === normalize(region)
        )
      )
      .map((item) => item.name)
      .filter(Boolean);

    res.json({ onboarders });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to load onboarders' });
  }
});

app.post('/save-intake', requireObSession, async (req, res) => {
  const {
    region,
    onboarder,
    venueName,
    clientName,
    clientEmail,
    salesforceCaseNumber
  } = req.body || {};

  if (!region || !onboarder || !venueName || !clientName || !clientEmail) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const boardQuery = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          groups {
            id
            title
          }
          columns {
            id
            title
            type
          }
        }
      }
    `;

    const boardResult = await mondayRequest(boardQuery);
    const board = boardResult.data?.boards?.[0];

    if (!board) {
      return res.status(500).json({ error: 'Onboarding board not found' });
    }

    const groupId = board.groups?.[0]?.id;
    if (!groupId) {
      return res.status(500).json({ error: 'No group found on onboarding board' });
    }

    const createQuery = `
      mutation {
        create_item(
          board_id: ${ONBOARDING_BOARD_ID},
          group_id: "${groupId}",
          item_name: ${JSON.stringify(venueName)}
        ) {
          id
        }
      }
    `;

    const createResult = await mondayRequest(createQuery);
    const itemId = createResult.data?.create_item?.id;

    if (!itemId) {
      return res.status(500).json({ error: 'Failed to create item' });
    }

    const venueColumn = findColumn(board.columns, ['Venue name']);
    const regionColumn = findColumn(board.columns, ['Region']);
    const onboarderColumn = findColumn(board.columns, ['Onboarder']);
    const clientNameColumn = findColumn(board.columns, ['Client name']);
    const clientEmailColumn = findColumn(board.columns, ['Client email']);
    const salesforceCaseColumn =
      findColumn(board.columns, ['Salesforce Case Number', 'Salesforce Case ID', 'SF Case Number', 'Case Number', 'Case ID']) ||
      findColumnByContains(board.columns, ['salesforce', 'case']) ||
      findColumnByContains(board.columns, ['case', 'number']) ||
      findColumnByContains(board.columns, ['case', 'id']);

    const columnValues = {};
    if (venueColumn) columnValues[venueColumn.id] = venueName;
    if (regionColumn) columnValues[regionColumn.id] = region;
    if (onboarderColumn) columnValues[onboarderColumn.id] = onboarder;
    if (clientNameColumn) columnValues[clientNameColumn.id] = clientName;
    if (clientEmailColumn) columnValues[clientEmailColumn.id] = clientEmail;
    if (salesforceCaseColumn && salesforceCaseNumber) columnValues[salesforceCaseColumn.id] = salesforceCaseNumber;

    const updateQuery = `
      mutation {
        change_multiple_column_values(
          board_id: ${ONBOARDING_BOARD_ID},
          item_id: ${itemId},
          column_values: "${escapeColumnValues(columnValues)}"
        ) {
          id
        }
      }
    `;

    const updateResult = await mondayRequest(updateQuery);
    const salesforce = await syncSalesforceCaseNotes(
      salesforceCaseNumber,
      buildSalesforceObNotes({
        venueName,
        clientName,
        clientEmail,
        region,
        onboarder
      })
    ).catch((error) => ({ ok: false, error: error.message }));

    res.json({
      ok: true,
      itemId,
      created: createResult.data,
      updated: updateResult.data,
      salesforce
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save intake to Monday' });
  }
});

function findAccessLinkColumn(columns, mode) {
  if (mode === 'internal') {
    return (
      findColumn(columns, [
        'Internal link',
        'Internal Link',
        'OB Link',
        'OB link',
        'Edit Link',
        'Edit URL',
        'Internal URL'
      ]) ||
      findColumnByContains(columns, ['internal', 'link']) ||
      findColumnByContains(columns, ['ob', 'link']) ||
      findColumnByContains(columns, ['edit', 'link']) ||
      findColumnByContains(columns, ['internal', 'url'])
    );
  }

  return (
    findColumn(columns, [
      'Invite link',
      'Invite Link',
      'Client Invite Link',
      'Client link',
      'Invite URL',
      'Client URL'
    ]) ||
    findColumnByContains(columns, ['invite']) ||
    findColumnByContains(columns, ['client', 'link']) ||
    findColumnByContains(columns, ['invite', 'url']) ||
    findColumnByContains(columns, ['client', 'url'])
  );
}

app.post('/save-invite-link', requireObSession, async (req, res) => {
  const { itemId, inviteUrl } = req.body || {};

  if (!itemId || !inviteUrl) {
    return res.status(400).json({ error: 'Missing itemId or inviteUrl' });
  }

  try {
    const boardQuery = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          columns {
            id
            title
            type
          }
        }
      }
    `;

    const boardResult = await mondayRequest(boardQuery);
    const board = boardResult.data?.boards?.[0];

    if (!board) {
      return res.status(500).json({ error: 'Onboarding board not found' });
    }

    const inviteColumn = findAccessLinkColumn(board.columns, 'invite');

    if (!inviteColumn) {
      return res.status(404).json({
        error: 'Invite link column not found',
        columns: board.columns.map((col) => ({ id: col.id, title: col.title, type: col.type }))
      });
    }

    const columnValues = {
      [inviteColumn.id]: inviteColumn.type === 'link'
        ? { url: inviteUrl, text: 'Open invite' }
        : inviteUrl
    };

    const mutation = `
      mutation {
        change_multiple_column_values(
          board_id: ${ONBOARDING_BOARD_ID},
          item_id: ${itemId},
          column_values: "${escapeColumnValues(columnValues)}"
        ) {
          id
        }
      }
    `;

    const result = await mondayRequest(mutation);

    res.json({
      ok: true,
      itemId,
      inviteUrl,
      columnId: inviteColumn.id,
      columnTitle: inviteColumn.title,
      updated: result.data
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to save invite link' });
  }
});

app.post('/save-internal-link', requireObSession, async (req, res) => {
  const { itemId, internalUrl } = req.body || {};

  if (!itemId || !internalUrl) {
    return res.status(400).json({ error: 'Missing itemId or internalUrl' });
  }

  try {
    const boardQuery = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          columns {
            id
            title
            type
          }
        }
      }
    `;

    const boardResult = await mondayRequest(boardQuery);
    const board = boardResult.data?.boards?.[0];

    if (!board) {
      return res.status(500).json({ error: 'Onboarding board not found' });
    }

    const internalColumn = findAccessLinkColumn(board.columns, 'internal');

    if (!internalColumn) {
      return res.status(404).json({
        error: 'Internal link column not found',
        columns: board.columns.map((col) => ({ id: col.id, title: col.title, type: col.type }))
      });
    }

    const columnValues = {
      [internalColumn.id]: internalColumn.type === 'link'
        ? { url: internalUrl, text: 'Open internal edit' }
        : internalUrl
    };

    const mutation = `
      mutation {
        change_multiple_column_values(
          board_id: ${ONBOARDING_BOARD_ID},
          item_id: ${itemId},
          column_values: "${escapeColumnValues(columnValues)}"
        ) {
          id
        }
      }
    `;

    const result = await mondayRequest(mutation);

    res.json({
      ok: true,
      itemId,
      internalUrl,
      columnId: internalColumn.id,
      columnTitle: internalColumn.title,
      updated: result.data
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to save internal link' });
  }
});

app.post('/update-step2', requireScopedItemAccess, async (req, res) => {
  const {
    itemId,
    venueName,
    clientName,
    clientEmail,
    region,
    onboarder,
    salesforceCaseNumber,
    launchDate,
    spendPerHead,
    posSystem,
    reservationSystem,
    prepayments,
    prepaymentType,
    cancellationPeriod,
    chargeModel,
    localCurrencyAmount,
    iPads,
    smsRequired,
    companyName,
    businessName,
    businessRegistrationNumber,
    businessWebsite,
    businessAddress,
    repFirstName,
    repLastName,
    repPhone,
    repEmail,
    otherIntegrations
  } = req.body || {};

  if (!itemId) {
    return res.status(400).json({ error: 'Missing itemId' });
  }

  try {
    const boardQuery = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          columns {
            id
            title
            type
          }
        }
      }
    `;

    const boardResult = await mondayRequest(boardQuery);
    const board = boardResult.data?.boards?.[0];

    if (!board) {
      return res.status(500).json({ error: 'Onboarding board not found' });
    }

    const {
      launchDateColumn,
      spendPerHeadColumn,
      posColumn,
      reservationColumn,
      prepaymentsColumn,
      ipadColumn,
      smsColumn,
      textColumn,
      otherIntegrationsColumn
    } = resolveStep2Columns(board.columns);

    const prepaymentsSummary = prepayments === 'Yes'
      ? [
          'Yes',
          prepaymentType ? `Type: ${prepaymentType}` : null,
          cancellationPeriod ? `Cancellation period: ${cancellationPeriod}` : null,
          chargeModel ? `Charge model: ${chargeModel}` : null,
          localCurrencyAmount ? `Amount: ${localCurrencyAmount}` : null
        ].filter(Boolean).join(' | ')
      : 'No';

    const smsSummary = smsRequired === 'Yes'
      ? [
          'SMS required: Yes',
          companyName ? `Company name: ${companyName}` : null,
          businessName ? `Business Name: ${businessName}` : null,
          businessRegistrationNumber ? `Business Registration Number: ${businessRegistrationNumber}` : null,
          businessWebsite ? `Business Website: ${businessWebsite}` : null,
          businessAddress ? `Business Address: ${businessAddress}` : null,
          repFirstName ? `Authorized Representative First Name: ${repFirstName}` : null,
          repLastName ? `Authorized Representative Last Name: ${repLastName}` : null,
          repPhone ? `Authorized Representative Phone Number: ${repPhone}` : null,
          repEmail ? `Authorized Representative Email Address: ${repEmail}` : null
        ].filter(Boolean).join('\n')
      : 'No';

    const notes = [
      launchDate ? `Launch date: ${launchDate}` : null,
      prepayments === 'Yes' ? `PrePayments details:\n${prepaymentsSummary}` : null,
      smsRequired === 'Yes' ? `SMS details:\n${smsSummary}` : null
    ].filter(Boolean).join('\n\n');

    const columnValues = {};
    if (launchDateColumn && launchDate) {
      columnValues[launchDateColumn.id] = launchDateColumn.type === 'date' ? { date: launchDate } : launchDate;
    }
    if (spendPerHeadColumn && spendPerHead) columnValues[spendPerHeadColumn.id] = spendPerHead;
    if (posColumn && posSystem) columnValues[posColumn.id] = posSystem;
    if (reservationColumn && reservationSystem) columnValues[reservationColumn.id] = reservationSystem;
    if (prepaymentsColumn && prepaymentsSummary) columnValues[prepaymentsColumn.id] = prepaymentsSummary;
    if (ipadColumn && iPads) columnValues[ipadColumn.id] = iPads;
    if (smsColumn && smsRequired) columnValues[smsColumn.id] = smsRequired;
    if (textColumn && notes) columnValues[textColumn.id] = notes;
    if (otherIntegrationsColumn && otherIntegrations) columnValues[otherIntegrationsColumn.id] = otherIntegrations;

    const updateQuery = `
      mutation {
        change_multiple_column_values(
          board_id: ${ONBOARDING_BOARD_ID},
          item_id: ${itemId},
          column_values: "${escapeColumnValues(columnValues)}"
        ) {
          id
        }
      }
    `;

    const result = await mondayRequest(updateQuery);
    const salesforce = await syncSalesforceCaseNotes(
      salesforceCaseNumber,
      buildSalesforceObNotes({
        venueName,
        clientName,
        clientEmail,
        region,
        onboarder,
        launchDate,
        spendPerHead,
        posSystem,
        reservationSystem,
        prepayments,
        prepaymentType,
        cancellationPeriod,
        chargeModel,
        localCurrencyAmount,
        iPads,
        smsRequired,
        companyName,
        businessName,
        businessRegistrationNumber,
        businessWebsite,
        businessAddress,
        repFirstName,
        repLastName,
        repPhone,
        repEmail,
        otherIntegrations
      })
    ).catch((error) => ({ ok: false, error: error.message }));

    res.json({
      ok: true,
      updated: result.data,
      salesforce
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to update step 2' });
  }
});


app.get('/onboarding-item', requireScopedItemAccess, async (req, res) => {
  const itemId = String(req.query.itemId || '').trim();

  if (!itemId) {
    return res.status(400).json({ error: 'Missing itemId' });
  }

  try {
    const query = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          columns {
            id
            title
            type
          }
        }
        items(ids: [${itemId}]) {
          id
          name
          column_values {
            id
            text
            type
            value
          }
        }
      }
    `;

    const result = await mondayRequest(query);
    const board = result.data?.boards?.[0];
    const item = result.data?.items?.[0];

    if (!board || !item) {
      return res.status(404).json({ error: 'Onboarding item not found' });
    }

    const getText = (aliases, containsFragments = []) => {
      const column =
        findColumn(board.columns, aliases) ||
        (containsFragments.length ? findColumnByContains(board.columns, containsFragments) : null);
      if (!column) return '';
      return item.column_values.find((value) => value.id === column.id)?.text?.trim() || '';
    };

    const getValue = (aliases, containsFragments = []) => {
      const column =
        findColumn(board.columns, aliases) ||
        (containsFragments.length ? findColumnByContains(board.columns, containsFragments) : null);
      if (!column) return null;
      const raw = item.column_values.find((value) => value.id === column.id)?.value;
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (error) {
        return null;
      }
    };

    const step2Columns = resolveStep2Columns(board.columns);
    const getTextByColumn = (column) => {
      if (!column) return '';
      return item.column_values.find((value) => value.id === column.id)?.text?.trim() || '';
    };

    const notes = getTextByColumn(step2Columns.textColumn);
    const prepaymentsText = getTextByColumn(step2Columns.prepaymentsColumn);
    const smsText = getTextByColumn(step2Columns.smsColumn);
    const prepaymentsBlock = extractNotesBlock(notes, 'PrePayments details', ['SMS details']);
    const smsBlock = extractNotesBlock(notes, 'SMS details');
    const launchDateValue = getValue(['Launch date', 'Launch Date'], ['launch', 'date']);
    const launchDateText = getText(['Launch date', 'Launch Date'], ['launch', 'date']) || extractLineValue(notes, 'Launch date');

    const step3Statuses = Object.entries(getStep3SectionColumnAliases()).reduce((acc, [sectionName, aliases]) => {
      acc[sectionName] = getText(aliases);
      return acc;
    }, {});

    const payload = {
      itemId: item.id,
      venueName: item.name || '',
      region: getText(['Region']),
      onboarder: getText(['Onboarder']),
      clientName: getText(['Client name']),
      clientEmail: getText(['Client email']),
      salesforceCaseNumber: getText(['Salesforce Case Number', 'Salesforce Case ID', 'SF Case Number', 'Case Number', 'Case ID'], ['case']),
      launchDate: launchDateValue?.date || launchDateText || '',
      spendPerHead: getText(['Spend per head', 'Spend Per Head'], ['spend']),
      additionalUsersText: extractNotesBlock(notes, 'Additional users', ['PrePayments details', 'SMS details']),
      posSystem: getText(['POS', 'POS system'], ['pos']),
      reservationSystem: getText(['Reservation System', 'Reservation syst'], ['reservation']),
      prepayments: /^yes/i.test(prepaymentsText || prepaymentsBlock) ? 'Yes' : (/^no/i.test(prepaymentsText || prepaymentsBlock) ? 'No' : ''),
      prepaymentType: extractInlineValue(prepaymentsBlock || prepaymentsText, 'Type'),
      cancellationPeriod: extractInlineValue(prepaymentsBlock || prepaymentsText, 'Cancellation period'),
      chargeModel: extractInlineValue(prepaymentsBlock || prepaymentsText, 'Charge model'),
      localCurrencyAmount: extractInlineValue(prepaymentsBlock || prepaymentsText, 'Amount'),
      iPads: getText(['iPad', 'iPads available', 'iPads'], ['ipad']),
      smsRequired: /^yes/i.test(smsText) ? 'Yes' : (/^no/i.test(smsText) ? 'No' : ''),
      companyName: extractLineValue(smsBlock, 'Company name'),
      businessName: extractLineValue(smsBlock, 'Business Name'),
      businessRegistrationNumber: extractLineValue(smsBlock, 'Business Registration Number'),
      businessWebsite: extractLineValue(smsBlock, 'Business Website'),
      businessAddress: extractLineValue(smsBlock, 'Business Address'),
      repFirstName: extractLineValue(smsBlock, 'Authorized Representative First Name'),
      repLastName: extractLineValue(smsBlock, 'Authorized Representative Last Name'),
      repPhone: extractLineValue(smsBlock, 'Authorized Representative Phone Number'),
      repEmail: extractLineValue(smsBlock, 'Authorized Representative Email Address'),
      otherIntegrations: getText(['Other Integrations', 'Other integrations / book channels required'], ['integration']),
      step3Statuses
    };

    res.json({ ok: true, item: payload });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to load onboarding item' });
  }
});

app.get('/dashboard-items', requireObSession, async (req, res) => {
  try {
    const query = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          columns {
            id
            title
            type
          }
          items_page(limit: 500) {
            items {
              id
              name
              column_values {
                id
                text
                type
                value
              }
            }
          }
        }
      }
    `;

    const result = await mondayRequest(query);
    const board = result.data?.boards?.[0];

    if (!board) {
      return res.status(404).json({ error: 'Onboarding board not found' });
    }

    const step2Columns = resolveStep2Columns(board.columns);
    const step3Aliases = getStep3SectionColumnAliases();
    const internalLinkColumn = findAccessLinkColumn(board.columns, 'internal');
    const inviteLinkColumn = findAccessLinkColumn(board.columns, 'invite');
    const regionColumn = findColumn(board.columns, ['Region']);
    const onboarderColumn = findColumn(board.columns, ['Onboarder']);
    const clientNameColumn = findColumn(board.columns, ['Client name']);
    const clientEmailColumn = findColumn(board.columns, ['Client email']);
    const salesforceCaseColumn =
      findColumn(board.columns, ['Salesforce Case Number', 'Salesforce Case ID', 'SF Case Number', 'Case Number', 'Case ID']) ||
      findColumnByContains(board.columns, ['salesforce', 'case']) ||
      findColumnByContains(board.columns, ['case', 'number']) ||
      findColumnByContains(board.columns, ['case', 'id']);

    const items = (board.items_page?.items || []).map((item) => {
      const getByColumn = (column) =>
        column ? item.column_values.find((value) => value.id === column.id) : null;
      const getTextByColumn = (column) => getByColumn(column)?.text?.trim() || '';

      const step3Statuses = Object.entries(step3Aliases).reduce((acc, [sectionName, aliases]) => {
        const column = findColumn(board.columns, aliases);
        acc[sectionName] = getTextByColumn(column) || 'Not Started';
        return acc;
      }, {});

      const completeCount = Object.values(step3Statuses).filter((status) => normalize(status) === 'complete').length;
      const percentComplete = Math.round((completeCount / Object.keys(step3Statuses).length) * 100);
      let overallStatus = 'Not started';
      if (percentComplete === 100) {
        overallStatus = 'Complete';
      } else if (percentComplete > 0) {
        overallStatus = 'In progress';
      }

      return {
        itemId: item.id,
        venueName: item.name || '',
        region: getTextByColumn(regionColumn),
        onboarder: getTextByColumn(onboarderColumn),
        clientName: getTextByColumn(clientNameColumn),
        clientEmail: getTextByColumn(clientEmailColumn),
        salesforceCaseNumber: getTextByColumn(salesforceCaseColumn),
        launchDate: getTextByColumn(step2Columns.launchDateColumn),
        posSystem: getTextByColumn(step2Columns.posColumn),
        reservationSystem: getTextByColumn(step2Columns.reservationColumn),
        otherIntegrations: getTextByColumn(step2Columns.otherIntegrationsColumn),
        internalUrl: parseMondayLink(getByColumn(internalLinkColumn)) || getTextByColumn(internalLinkColumn),
        inviteUrl: parseMondayLink(getByColumn(inviteLinkColumn)) || getTextByColumn(inviteLinkColumn),
        step3Statuses,
        percentComplete,
        overallStatus
      };
    });

    res.json({ ok: true, items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to load dashboard items' });
  }
});


app.post('/update-step3', requireObSession, async (req, res) => {
  const {
    itemId,
    section,
    completed
  } = req.body || {};

  if (!itemId || !section) {
    return res.status(400).json({ error: 'Missing itemId or section' });
  }

  try {
    const boardQuery = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          columns {
            id
            title
            type
          }
        }
      }
    `;

    const boardResult = await mondayRequest(boardQuery);
    const board = boardResult.data?.boards?.[0];

    if (!board) {
      return res.status(500).json({ error: 'Onboarding board not found' });
    }

    const sectionColumnAliases = getStep3SectionColumnAliases();

    const aliases = sectionColumnAliases[section];

    if (!aliases) {
      return res.status(400).json({ error: 'Unknown Step 3 section' });
    }

    const statusColumn = findColumn(board.columns, aliases);

    if (!statusColumn) {
      return res.status(404).json({
        error: 'Matching Step 3 status column not found',
        section,
        lookedFor: aliases,
        columns: board.columns.map((col) => ({ id: col.id, title: col.title, type: col.type }))
      });
    }

    const statusLabel = completed ? 'Complete' : 'Not Started';
    const mutation = `
      mutation {
        change_simple_column_value(
          board_id: ${ONBOARDING_BOARD_ID},
          item_id: ${itemId},
          column_id: "${statusColumn.id}",
          value: ${JSON.stringify(statusLabel)}
        ) {
          id
        }
      }
    `;

    const result = await mondayRequest(mutation);

    res.json({
      ok: true,
      itemId,
      section,
      statusLabel,
      columnId: statusColumn.id,
      columnTitle: statusColumn.title,
      updated: result.data
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to update step 3 status' });
  }
});

app.get('/monday-team-profile', requireSession, async (req, res) => {
  const boardId = Number(req.query.boardId || TEAM_BOARD_ID);
  const name = String(req.query.name || '').trim();

  if (!name) {
    return res.status(400).json({ error: 'Missing name' });
  }

  const query = `
    query {
      boards(ids: ${boardId}) {
        columns {
          id
          title
          type
        }
        items_page(limit: 500) {
          items {
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;

  try {
    const result = await mondayRequest(query);
    const board = result.data?.boards?.[0];

    if (!board) {
      return res.status(404).json({ error: 'Board not found' });
    }

    const item = (board.items_page?.items || []).find(
      (entry) => normalize(entry.name) === normalize(name)
    );

    if (!item) {
      return res.status(404).json({ error: 'Onboarder not found' });
    }

    const emailColumn = findColumn(board.columns, ['Email', 'E-mail']);

    const getColumnValue = (columnId) =>
      item.column_values.find((col) => col.id === columnId);

    const email = emailColumn ? getColumnValue(emailColumn.id)?.text || '' : '';
    const photoUrl = LOCAL_PROFILE_IMAGES[normalize(item.name)] || '';

    res.json({
      name: item.name || '',
      email,
      photoUrl
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to load team profile' });
  }
});

app.get('/monday-resource-link', requireSession, async (req, res) => {
  const boardId = Number(req.query.boardId || TEAM_BOARD_ID);
  const value = String(req.query.value || '').trim();
  const type = String(req.query.type || '').trim().toLowerCase();

  if (!value) {
    return res.status(400).json({ error: 'Missing value' });
  }

  const query = `
    query {
      boards(ids: ${boardId}) {
        columns {
          id
          title
        }
        items_page(limit: 500) {
          items {
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;

  try {
    const result = await mondayRequest(query);
    const board = result.data?.boards?.[0];
    const items = board?.items_page?.items || [];

    const match = items.find((item) => normalize(item.name) === normalize(value));

    if (!match) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    const linkColumn = findColumn(board.columns || [], ['Link']);
    const linkValue = linkColumn
      ? match.column_values.find((col) => col.id === linkColumn.id)
      : null;

    let url = '';

    try {
      const parsed = linkValue?.value ? JSON.parse(linkValue.value) : null;
      url = parsed?.url || '';
    } catch {
      url = '';
    }

    if (!url && linkValue?.text && /^https?:\/\//i.test(linkValue.text)) {
      url = linkValue.text;
    }

    if (!url) {
      return res.status(404).json({ error: 'Link not found for resource' });
    }

    const labelPrefixes = {
      reservation: 'Reservation',
      payment: 'Payment',
      integration: 'Integration',
      pos: 'POS'
    };
    const labelPrefix = labelPrefixes[type] || 'Resource';

    res.json({
      url,
      label: `${labelPrefix} resource: ${match.name}`
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to load resource link' });
  }
});

const PORT = Number(process.env.PORT || 3000);

(async () => {
  try {
    await ensureAuthStorage();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})();
