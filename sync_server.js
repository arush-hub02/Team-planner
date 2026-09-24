const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3100;
const SPREADSHEET_ID = '1mMe1z7_fZRKjAcd_uMGUsY15SFfRcBPUKfttcYDa9FY';
const COMPOSIO_KEY = process.env.COMPOSIO_API_KEY || '';

// Stateless Server-Sealed Encryption for Device Tokens (AES-256-GCM)
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'task-sync-v2-device-seal-key-default-2026';
const CIPHER_KEY = crypto.createHash('sha256').update(ENCRYPTION_SECRET).digest();

function sealApiKey(plainApiKey) {
  if (!plainApiKey || typeof plainApiKey !== 'string') return null;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', CIPHER_KEY, iv);
    let encrypted = cipher.update(plainApiKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `sealed_v1:${iv.toString('hex')}:${tag}:${encrypted}`;
  } catch (e) {
    return null;
  }
}

function unsealApiKey(sealedToken) {
  if (!sealedToken || typeof sealedToken !== 'string') return null;
  if (!sealedToken.startsWith('sealed_v1:')) return null;
  try {
    const parts = sealedToken.split(':');
    if (parts.length !== 4) return null;
    const iv = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const encryptedText = parts[3];
    const decipher = crypto.createDecipheriv('aes-256-gcm', CIPHER_KEY, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return null;
  }
}

function resolveApiKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return '';
  const trimmed = rawKey.trim();
  if (trimmed.startsWith('ck_')) return trimmed;
  if (trimmed.startsWith('sealed_v1:')) {
    const unsealed = unsealApiKey(trimmed);
    return unsealed || '';
  }
  return '';
}

// Hardcoded preset user accounts with strict role-based access
const USER_ACCOUNTS = {
  'admin': {
    username: 'admin',
    password: 'admin@enveu2026',
    name: 'Admin',
    role: 'ADMIN',
    allowedSheets: ['ALL']
  },
  'arush': {
    username: 'arush',
    password: 'arush@enveu2026',
    name: 'Arush',
    role: 'MEMBER',
    allowedSheets: ['ARUSH']
  },
  'chetna': {
    username: 'chetna',
    password: 'chetna@enveu2026',
    name: 'Chetna',
    role: 'MEMBER',
    allowedSheets: ['CHETNA', 'PULSE']
  },
  'krishna': {
    username: 'krishna',
    password: 'krishna@enveu2026',
    name: 'Krishna',
    role: 'MEMBER',
    allowedSheets: ['KRISHNA']
  },
  'manish': {
    username: 'manish',
    password: 'manish@enveu2026',
    name: 'Manish',
    role: 'MEMBER',
    allowedSheets: ['MANISH']
  },
  'rahul': {
    username: 'rahul',
    password: 'rahul@enveu2026',
    name: 'Rahul',
    role: 'MEMBER',
    allowedSheets: ['RAHUL']
  },
  'sonu': {
    username: 'sonu',
    password: 'sonu@enveu2026',
    name: 'Sonu',
    role: 'MEMBER',
    allowedSheets: ['SONU']
  }
};

let currentRequestApiKey = null;
let currentRequestUser = 'workspace';

// Monthly Composio Free Allowance Tracker (100,000 free calls / month)
const USAGE_FILE = process.env.VERCEL ? path.join('/tmp', 'composio_usage.json') : path.join(__dirname, 'composio_usage.json');
const COMPOSIO_MONTHLY_FREE_ALLOWANCE = 100000;

function getCurrentMonthKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function loadComposioUsage() {
  const currentMonth = getCurrentMonthKey();
  let usage = {
    month: currentMonth,
    totalCalls: 0,
    userCalls: {},
    lastUpdated: new Date().toISOString()
  };
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
      if (data && data.month === currentMonth) {
        usage = data;
      }
    }
  } catch (e) {
    console.warn('Error reading usage file:', e.message);
  }
  return usage;
}

function saveComposioUsage(usage) {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), 'utf8');
  } catch (e) {
    console.warn('Error saving usage file:', e.message);
  }
}

let composioUsageStore = loadComposioUsage();

function recordComposioCall(username, count = 1) {
  const currentMonth = getCurrentMonthKey();
  if (composioUsageStore.month !== currentMonth) {
    composioUsageStore = {
      month: currentMonth,
      totalCalls: 0,
      userCalls: {},
      lastUpdated: new Date().toISOString()
    };
  }
  composioUsageStore.totalCalls = (composioUsageStore.totalCalls || 0) + count;
  const user = (username || currentRequestUser || 'workspace').toLowerCase();
  composioUsageStore.userCalls[user] = (composioUsageStore.userCalls[user] || 0) + count;
  composioUsageStore.lastUpdated = new Date().toISOString();
  saveComposioUsage(composioUsageStore);
}

// In-memory cache with 3-minute TTL (Prevents redundant Google Sheets calls on page reloads)
let cache = {
  data: null,
  sheetNames: null,
  timestamp: 0
};
const CACHE_TTL_MS = 180000; // 3 minutes (180,000 ms)

const STATUS_SHEETS = ['CLOSED'];
const PROJECT_SHEETS = ['PULSE'];
function isStatusSheet(name) {
  return STATUS_SHEETS.includes((name || '').trim().toUpperCase());
}
function isProjectSheet(name) {
  return PROJECT_SHEETS.includes((name || '').trim().toUpperCase());
}
function isNonPersonSheet(name) {
  return isStatusSheet(name) || isProjectSheet(name);
}

// Color map for status formatting in Google Sheets
const STATUS_COLORS = {
  'In Progress': { bg: '#d1fae5', text: '#065f46' },
  'In Progress (L2)': { bg: '#d1fae5', text: '#065f46' },
  'Dev Done': { bg: '#d1fae5', text: '#065f46' },
  'BE Done': { bg: '#d1fae5', text: '#065f46' },
  'BE Done / FE ToDo': { bg: '#d1fae5', text: '#065f46' },
  'BE Done (Verify)': { bg: '#d1fae5', text: '#065f46' },
  'In Progress (CMS)': { bg: '#d1fae5', text: '#065f46' },
  'In Review': { bg: '#fef3c7', text: '#92400e' },
  'BE InReview': { bg: '#fef3c7', text: '#92400e' },
  'To Pick Up': { bg: '#dbeafe', text: '#1e40af' },
  'To Do': { bg: '#dbeafe', text: '#1e40af' },
  'To Do (Analyzing)': { bg: '#dbeafe', text: '#1e40af' },
  'Open': { bg: '#dbeafe', text: '#1e40af' },
  'Selected for Development': { bg: '#dbeafe', text: '#1e40af' },
  'Closed': { bg: '#d1fae5', text: '#065f46' },
  'Done': { bg: '#d1fae5', text: '#065f46' },
  'POC': { bg: '#f3e8ff', text: '#6b21a8' },
  'Escalated to L2': { bg: '#f3e8ff', text: '#6b21a8' },
  'Escalated to L3': { bg: '#fee2e2', text: '#991b1b' },
  'Discuss First': { bg: '#fee2e2', text: '#991b1b' },
  'Backlog': { bg: '#f1f5f9', text: '#475569' }
};

const INDIVIDUAL_SHEETS = {
  "ARUSH": "1Rp5yw78lqoPAe4TSV5ANf3FMFiemlslcDh1D9ksSU8U",
  "CHETNA": "1e0WUUZPl11CeXP2V3K5uD6LWH1oHRrTzqEJ1f5SaSZ0",
  "KRISHNA": "1_sZ3DJxjORvnLRsT2IpYhA0ua4PbHOfg9c6yKuw1hW8",
  "MANISH": "1GccfNZV3De0fINvqKEgTHr6yOrm1L8AI1MiyU8AJjwc",
  "RAHUL": "1GuT87vd_KT5KKq3To6AzDjC0zqpCohU7oceRq73SAPI",
  "SONU": "1d6sG7s-U1o3hSabm1NzqNA7VFHsbk6-1Ub93tw50YAQ"
};

let KNOWN_STATUSES = new Set([
  'To Pick Up',
  'To Do',
  'To Do (Analyzing)',
  'In Progress',
  'Dev Done',
  'BE Done',
  'BE Done / FE ToDo',
  'BE Done (Verify)',
  'In Review',
  'BE InReview',
  'POC',
  'Discuss First',
  'Backlog',
  'Closed'
]);

function registerCustomStatus(status) {
  if (!status) return false;
  const s = status.trim();
  if (!s || KNOWN_STATUSES.has(s)) return false;
  console.log(`✨ [New Status Discovered] "${s}" added to dynamic dropdowns!`);
  KNOWN_STATUSES.add(s);
  if (!STATUS_COLORS[s]) {
    STATUS_COLORS[s] = { bg: '#e0e7ff', text: '#3730a3' };
  }
  updateDataValidationAcrossSheets().catch(err => console.error('Error updating validation rules:', err.message));
  return true;
}

function parseJiraDueDate(rawDate) {
  if (!rawDate || rawDate === 'null' || rawDate === 'None') return 'Not set';
  const match = String(rawDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = parseInt(match[3], 10);
    const month = months[parseInt(match[2], 10) - 1];
    return `${day} ${month}`;
  }
  const str = String(rawDate).trim();
  return str && str.toLowerCase() !== 'tbd' ? str : 'Not set';
}

function formatToday() {
  const d = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

// MCP Session Cache: reuse session IDs across tool calls instead of re-handshaking every time
const mcpSessionCache = {}; // { [apiKey]: { sid: string, expires: number } }

async function getOrInitSession(apiKey) {
  const activeKey = (apiKey && apiKey.startsWith('ck_')) ? apiKey : (currentRequestApiKey || COMPOSIO_KEY);
  const now = Date.now();
  if (mcpSessionCache[activeKey] && mcpSessionCache[activeKey].expires > now) {
    return mcpSessionCache[activeKey].sid;
  }
  const init = await sendComposioMcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sync-server', version: '1.0.0' }
  }, null, activeKey);
  const sid = init.headers['mcp-session-id'];
  if (sid) {
    mcpSessionCache[activeKey] = { sid, expires: now + (15 * 60 * 1000) }; // 15 min cache
  }
  return sid;
}

function sendComposioMcp(method, params, sessionId, customApiKey) {
  // Only record actual billable tool calls (not protocol initialization handshakes)
  if (method === 'tools/call') {
    const toolCount = (params && params.arguments && Array.isArray(params.arguments.tools))
      ? params.arguments.tools.length
      : 1;
    recordComposioCall(currentRequestUser, toolCount);
  }

  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params: params || {}
    });

    let activeKey = customApiKey || currentRequestApiKey;
    if (!activeKey || !activeKey.startsWith('ck_')) {
      activeKey = COMPOSIO_KEY;
    }

    if (!activeKey || !activeKey.startsWith('ck_')) {
      return reject(new Error('Composio API Key is required. Please sign in and configure your personal Composio key in the dashboard.'));
    }

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'x-consumer-api-key': activeKey
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const req = https.request('https://connect.composio.dev/mcp', {
      method: 'POST',
      headers
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function verifyComposioApiKey(apiKey) {
  const actualKey = resolveApiKey(apiKey);
  if (!actualKey || !actualKey.startsWith('ck_')) {
    return { valid: false, error: 'Invalid format: Composio API Key must start with "ck_"' };
  }
  try {
    const res = await sendComposioMcp('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'composio-auth-verifier', version: '1.0.0' }
    }, null, actualKey);

    if (res.status === 200 || res.status === 204) {
      return { valid: true, resolvedKey: actualKey };
    } else {
      return { valid: false, error: `Authentication failed (Status ${res.status}). Please check your Composio API key.` };
    }
  } catch (err) {
    return { valid: false, error: `Connection failed: ${err.message}` };
  }
}

async function manageComposioConnections(apiKey, toolkitsWithActions) {
  const resolved = resolveApiKey(apiKey);
  const activeKey = (resolved && resolved.startsWith('ck_')) ? resolved : (currentRequestApiKey || COMPOSIO_KEY);
  const sid = await getOrInitSession(activeKey);

  const callRes = await sendComposioMcp('tools/call', {
    name: 'COMPOSIO_MANAGE_CONNECTIONS',
    arguments: {
      toolkits: toolkitsWithActions
    }
  }, sid, activeKey);

  const lines = callRes.body.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const parsed = JSON.parse(line.slice(6));
      return parsed.result?.content?.[0]?.text ? JSON.parse(parsed.result.content[0].text) : parsed;
    }
  }
  return null;
}

async function executeComposioTool(toolSlug, args, customApiKey) {
  const activeKey = customApiKey || currentRequestApiKey || COMPOSIO_KEY;
  let sid = await getOrInitSession(activeKey);

  let callRes = await sendComposioMcp('tools/call', {
    name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
    arguments: {
      sync_response_to_workbench: false,
      tools: [{ tool_slug: toolSlug, arguments: args }]
    }
  }, sid, activeKey);

  if (callRes.status === 400 || callRes.status === 404 || (callRes.body && callRes.body.includes('Session'))) {
    delete mcpSessionCache[activeKey];
    sid = await getOrInitSession(activeKey);
    callRes = await sendComposioMcp('tools/call', {
      name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      arguments: {
        sync_response_to_workbench: false,
        tools: [{ tool_slug: toolSlug, arguments: args }]
      }
    }, sid, activeKey);
  }

  const lines = callRes.body.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const parsed = JSON.parse(line.slice(6));
      return parsed.result?.content?.[0]?.text ? JSON.parse(parsed.result.content[0].text) : parsed;
    }
  }
  return null;
}

async function executeComposioBatch(toolsList, customApiKey) {
  if (!toolsList || toolsList.length === 0) return null;
  const activeKey = customApiKey || currentRequestApiKey || COMPOSIO_KEY;
  let sid = await getOrInitSession(activeKey);

  let callRes = await sendComposioMcp('tools/call', {
    name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
    arguments: {
      sync_response_to_workbench: false,
      tools: toolsList
    }
  }, sid, activeKey);

  if (callRes.status === 400 || callRes.status === 404 || (callRes.body && callRes.body.includes('Session'))) {
    delete mcpSessionCache[activeKey];
    sid = await getOrInitSession(activeKey);
    callRes = await sendComposioMcp('tools/call', {
      name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      arguments: {
        sync_response_to_workbench: false,
        tools: toolsList
      }
    }, sid, activeKey);
  }

  const lines = callRes.body.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const parsed = JSON.parse(line.slice(6));
      return parsed.result?.content?.[0]?.text ? JSON.parse(parsed.result.content[0].text) : parsed;
    }
  }
  return null;
}

// Fetch all sheets from Google Sheets (Consolidated in 1 single batch request with zero redundant calls)
async function fetchAllSheetsFromGoogle() {
  const sheetNames = [
    'ARUSH', 'MANISH', 'KRISHNA', 'CHETNA', 'SONU', 'RAHUL', 'UPCOMING', 'CLOSED', 'PULSE'
  ];

  const tools = sheetNames.map(tab => ({
    tool_slug: 'GOOGLESHEETS_VALUES_GET',
    arguments: {
      spreadsheet_id: SPREADSHEET_ID,
      range: `${tab}!A1:H100`
    }
  }));

  const batchResult = await executeComposioBatch(tools);
  const sheetData = {};

  if (batchResult?.data?.results) {
    batchResult.data.results.forEach((r, idx) => {
      const tab = sheetNames[idx];
      sheetData[tab] = r.response?.data?.values || [];
    });
  }

  if (Object.keys(sheetData).length > 0) {
    cache = {
      data: sheetData,
      sheetNames,
      timestamp: Date.now()
    };
  }

  return { sheetNames, sheetData };
}

async function updateDataValidationAcrossSheets() {
  const tools = [];
  const statusList = Array.from(KNOWN_STATUSES);
  for (const [name, sheetId] of Object.entries(INDIVIDUAL_SHEETS)) {
    tools.push({
      tool_slug: 'GOOGLESHEETS_SET_DATA_VALIDATION_RULE',
      arguments: {
        spreadsheet_id: sheetId,
        sheet_id: 0,
        mode: 'SET',
        start_row_index: 1,
        end_row_index: 50,
        start_column_index: 5,
        end_column_index: 6,
        validation_type: 'ONE_OF_LIST',
        values: statusList,
        strict: false,
        show_custom_ui: true
      }
    });
  }
  if (tools.length > 0) {
    await executeComposioBatch(tools);
    console.log('✅ [Data Validation Updated] Dynamic dropdown rules updated across all individual sheets');
  }
}

async function pushMasterToIndividualSheet(memberName, masterRows) {
  if (!memberName) return;
  const memberKey = memberName.trim().toUpperCase();
  const sheetId = INDIVIDUAL_SHEETS[memberKey];
  if (!sheetId) return;

  try {
    const rowsToWrite = [...masterRows];
    while (rowsToWrite.length < 30) {
      rowsToWrite.push(['', '', '', '', '', '', '', '']);
    }
    await executeComposioTool('GOOGLESHEETS_VALUES_UPDATE', {
      spreadsheet_id: sheetId,
      range: `Sheet1!A1:H${rowsToWrite.length}`,
      value_input_option: 'USER_ENTERED',
      values: rowsToWrite
    });
    console.log(`📤 [1-Way Push] Synced ${masterRows.length} rows to ${memberKey}'s individual sheet`);
  } catch (err) {
    console.error(`Error pushing to ${memberKey} individual sheet:`, err.message);
  }
}

async function syncPulseSheet() {
  try {
    const chetnaRes = await executeComposioTool('GOOGLESHEETS_VALUES_GET', {
      spreadsheet_id: INDIVIDUAL_SHEETS.CHETNA,
      range: 'PULSE!A1:G100'
    });
    const chetnaRows = chetnaRes?.data?.results?.[0]?.response?.data?.values || [];
    if (chetnaRows.length === 0) return;

    // Check Master sheet PULSE rows
    const masterRes = await executeComposioTool('GOOGLESHEETS_VALUES_GET', {
      spreadsheet_id: SPREADSHEET_ID,
      range: `PULSE!A1:G${chetnaRows.length}`
    });
    const masterRows = masterRes?.data?.results?.[0]?.response?.data?.values || [];

    const normChetna = chetnaRows.map(r => (Array.isArray(r) ? r.map(c => String(c ?? '').trim()) : []));
    const normMaster = masterRows.map(r => (Array.isArray(r) ? r.map(c => String(c ?? '').trim()) : []));

    if (JSON.stringify(normChetna) !== JSON.stringify(normMaster)) {
      console.log(`🔄 [PULSE Sync] Detected real updates in Chetna's PULSE sheet (${chetnaRows.length} rows). Syncing to Master Sheet...`);
      await executeComposioTool('GOOGLESHEETS_VALUES_UPDATE', {
        spreadsheet_id: SPREADSHEET_ID,
        range: `PULSE!A1:G${chetnaRows.length}`,
        value_input_option: 'USER_ENTERED',
        values: chetnaRows
      });

      if (cache.data) {
        cache.data['PULSE'] = chetnaRows;
        cache.timestamp = Date.now();
      }
      console.log(`✅ [PULSE Synced] Updated Master Sheet PULSE tab with ${chetnaRows.length} rows`);
    }
  } catch (err) {
    console.error('Error syncing PULSE sheet:', err.message);
  }
}

let isSyncingIndividual = false;
async function syncIndividualSheetsWithMaster() {
  if (isSyncingIndividual) return;
  isSyncingIndividual = true;

  try {
    // 0. Sync PULSE project sheet
    await syncPulseSheet();
    // 1. Fetch live master sheets
    const { sheetNames, sheetData } = await fetchAllSheetsFromGoogle();

    // 2. Batch read all 6 individual sheets
    const members = Object.keys(INDIVIDUAL_SHEETS);
    const getTools = members.map(m => ({
      tool_slug: 'GOOGLESHEETS_VALUES_GET',
      arguments: {
        spreadsheet_id: INDIVIDUAL_SHEETS[m],
        range: 'Sheet1!A1:H30'
      }
    }));

    const batchRes = await executeComposioBatch(getTools);
    if (!batchRes?.data?.results) return;

    const masterUpdatePayload = [];
    let masterUpdated = false;

    members.forEach((m, idx) => {
      const indRows = batchRes.data.results[idx]?.response?.data?.values || [];
      const masterRows = sheetData[m] || [];
      if (indRows.length <= 1 && masterRows.length <= 1) return;

      let memberNeedsPush = false;

      // Scan rows from individual sheet
      indRows.forEach((indRow, rowIdx) => {
        if (rowIdx === 0) return; // skip header
        const tKey = (indRow[1] || '').trim().toUpperCase();
        if (!tKey) return;

        const mIdx = masterRows.findIndex((mr, i) => i > 0 && mr[1] && mr[1].trim().toUpperCase() === tKey);
        if (mIdx > 0) {
          const masterRow = [...masterRows[mIdx]];
          const indInternalStatus = (indRow[5] || '').trim();
          const indNotes = (indRow[6] || '').trim();

          let rowModified = false;
          if (indInternalStatus && indInternalStatus !== (masterRow[5] || '').trim()) {
            console.log(`📥 [2-Way Sync] ${m}'s sheet updated Internal Status for ${tKey}: "${masterRow[5]}" -> "${indInternalStatus}"`);
            masterRow[5] = indInternalStatus;
            registerCustomStatus(indInternalStatus);
            rowModified = true;
          }

          if (indNotes && indNotes !== (masterRow[6] || '').trim()) {
            console.log(`📥 [2-Way Sync] ${m}'s sheet updated Action/Notes for ${tKey}: "${indNotes}"`);
            masterRow[6] = indNotes;
            rowModified = true;
          }

          if (rowModified) {
            masterRows[mIdx] = masterRow;
            masterUpdated = true;
          }

          // If restricted columns (A:E, H) were modified in individual sheet, mark to overwrite with master
          if (indRow[3] !== masterRow[3] || indRow[4] !== masterRow[4] || indRow[7] !== masterRow[7]) {
            memberNeedsPush = true;
          }
        }
      });

      if (masterUpdated) {
        sheetData[m] = masterRows;
        masterUpdatePayload.push({
          range: `${m}!A1:H${masterRows.length}`,
          majorDimension: 'ROWS',
          values: masterRows
        });
      }

      // If master had different row count or restricted columns were touched, push master back to individual
      if (memberNeedsPush || (masterRows.length > 0 && indRows.length !== masterRows.length)) {
        pushMasterToIndividualSheet(m, masterRows).catch(() => {});
      }
    });

    if (masterUpdatePayload.length > 0) {
      await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
        spreadsheet_id: SPREADSHEET_ID,
        valueInputOption: 'USER_ENTERED',
        data: masterUpdatePayload
      });
      cache = {
        sheetNames,
        data: sheetData,
        timestamp: Date.now()
      };
      console.log(`✅ [2-Way Sync Complete] Master Sheet updated with changes from individual sheets`);
    }
  } catch (err) {
    console.error('Error during 2-way sync:', err.message);
  } finally {
    isSyncingIndividual = false;
  }
}

// Background 2-way sync: runs every 10 minutes (600,000 ms) to conserve Composio quota
// Real-time mutations (status updates, ticket creation, deletion, etc.) sync immediately on-demand
if (process.env.VERCEL !== '1' && require.main === module) {
  setInterval(syncIndividualSheetsWithMaster, 10 * 60 * 1000);
}

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-composio-key, x-user-name, x-user-role');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Dynamic user-provided Composio key from request headers (plain ck_ key or sealed_v1: token)
  const incomingKey = req.headers['x-composio-key'];
  const resolvedKey = resolveApiKey(incomingKey);
  currentRequestApiKey = resolvedKey || null;
  const incomingUser = req.headers['x-user-name'];
  currentRequestUser = incomingUser ? incomingUser.trim().toLowerCase() : 'workspace';

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Serve static HTML dashboard
  if (urlObj.pathname === '/' || urlObj.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }
  }

  // POST /api/auth/login -> Authenticate with hardcoded credentials and return user role
  if (urlObj.pathname === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const username = (payload.username || '').trim().toLowerCase();
        const password = payload.password || '';
        const user = USER_ACCOUNTS[username];

        if (!user || user.password !== password) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid username or password' }));
          return;
        }

        const { password: _, ...safeUser } = user;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, user: safeUser }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Malformed request body' }));
      }
    });
    return;
  }

  // POST /api/composio/verify -> Test and verify a user-provided Composio API Key + connection status
  if (urlObj.pathname === '/api/composio/verify' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const apiKey = (payload.apiKey || '').trim();
        const result = await verifyComposioApiKey(apiKey);

        if (!result.valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: result.error }));
          return;
        }

        const actualKey = result.resolvedKey;
        const sealedToken = sealApiKey(actualKey);
        const maskedKey = actualKey.length > 8
          ? actualKey.slice(0, 4) + '••••••••' + actualKey.slice(-4)
          : 'ck_••••••••';

        // Check if required toolkits (googlesheets, jira) are connected
        let connections = { googlesheets: { active: false }, jira: { active: false }, allActive: false };
        try {
          const resConn = await manageComposioConnections(actualKey, [
            { name: 'googlesheets', action: 'list' },
            { name: 'jira', action: 'list' }
          ]);
          const results = resConn?.data?.results || {};
          const sheetsActive = results.googlesheets?.status === 'active' || 
            (Array.isArray(results.googlesheets?.accounts) && results.googlesheets.accounts.some(a => a.status === 'active'));
          const jiraActive = results.jira?.status === 'active' || 
            (Array.isArray(results.jira?.accounts) && results.jira.accounts.some(a => a.status === 'active'));

          connections = {
            googlesheets: {
              active: !!sheetsActive,
              status: sheetsActive ? 'active' : (results.googlesheets?.status || 'not_connected'),
              accountEmail: results.googlesheets?.accounts?.find(a => a.status === 'active')?.user_info?.email || null
            },
            jira: {
              active: !!jiraActive,
              status: jiraActive ? 'active' : (results.jira?.status || 'not_connected'),
              siteUrl: results.jira?.accounts?.find(a => a.status === 'active')?.user_info?.sites?.[0]?.url || null
            },
            allActive: !!(sheetsActive && jiraActive)
          };
        } catch (connErr) {
          console.warn('Connection check error during verify:', connErr.message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Composio API Key connected and verified successfully!',
          sealedToken,
          maskedKey,
          connections
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/composio/check-connections -> Check live connection statuses for Google Sheets & Jira
  if (urlObj.pathname === '/api/composio/check-connections' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const apiKey = resolveApiKey(payload.apiKey || req.headers['x-composio-key']);

        const resConn = await manageComposioConnections(apiKey, [
          { name: 'googlesheets', action: 'list' },
          { name: 'jira', action: 'list' }
        ]);

        const results = resConn?.data?.results || {};
        const sheetsActive = results.googlesheets?.status === 'active' || 
          (Array.isArray(results.googlesheets?.accounts) && results.googlesheets.accounts.some(a => a.status === 'active'));
        const jiraActive = results.jira?.status === 'active' || 
          (Array.isArray(results.jira?.accounts) && results.jira.accounts.some(a => a.status === 'active'));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          googlesheets: {
            active: !!sheetsActive,
            status: sheetsActive ? 'active' : (results.googlesheets?.status || 'not_connected'),
            accountEmail: results.googlesheets?.accounts?.find(a => a.status === 'active')?.user_info?.email || null
          },
          jira: {
            active: !!jiraActive,
            status: jiraActive ? 'active' : (results.jira?.status || 'not_connected'),
            siteUrl: results.jira?.accounts?.find(a => a.status === 'active')?.user_info?.sites?.[0]?.url || null
          },
          allActive: !!(sheetsActive && jiraActive)
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/composio/connect-app -> Initiate new OAuth connection link for googlesheets or jira
  if (urlObj.pathname === '/api/composio/connect-app' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const toolkit = (payload.toolkit || '').toLowerCase();
        const apiKey = resolveApiKey(payload.apiKey || req.headers['x-composio-key']);

        if (!['googlesheets', 'jira'].includes(toolkit)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid toolkit: must be googlesheets or jira' }));
          return;
        }

        const resConn = await manageComposioConnections(apiKey, [
          { name: toolkit, action: 'add' }
        ]);

        const toolkitData = resConn?.data?.results?.[toolkit] || {};
        const redirectUrl = toolkitData.redirect_url || null;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          toolkit,
          redirectUrl,
          message: toolkitData.instruction || `Please open the authorization link to connect ${toolkit}.`
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // GET /api/composio/usage -> Return monthly usage metrics, remaining free requests, and days until reset
  if (urlObj.pathname === '/api/composio/usage' && (req.method === 'GET' || req.method === 'POST')) {
    const usage = loadComposioUsage();
    const used = usage.totalCalls || 0;
    const allowance = COMPOSIO_MONTHLY_FREE_ALLOWANCE;
    const remaining = Math.max(0, allowance - used);
    const percentRemaining = Number(((remaining / allowance) * 100).toFixed(2));
    const percentUsed = Number(((used / allowance) * 100).toFixed(2));

    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const daysUntilReset = Math.max(1, endOfMonth.getDate() - now.getDate());

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const currentMonthLabel = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      month: currentMonthLabel,
      totalAllowance: allowance,
      totalUsed: used,
      totalRemaining: remaining,
      percentRemaining,
      percentUsed,
      daysUntilReset,
      userCalls: usage.userCalls || {},
      dashboardUrl: 'https://app.composio.dev/settings'
    }));
    return;
  }

  // GET /api/sheets -> Dynamically fetch all sheet names and rows with RBAC enforcement
  if (urlObj.pathname === '/api/sheets' && req.method === 'GET') {
    try {
      const forceRefresh = urlObj.searchParams.get('force') === 'true';
      const clientRole = (req.headers['x-user-role'] || '').toUpperCase();
      const clientUser = (req.headers['x-user-name'] || '').toLowerCase();
      const userConfig = USER_ACCOUNTS[clientUser];

      const isCacheValid = !forceRefresh && cache.data && Object.keys(cache.data).length > 0 && (Date.now() - cache.timestamp < CACHE_TTL_MS);

      let sheetNames = cache.sheetNames;
      let sheetData = cache.data;
      let wasCached = true;

      if (!isCacheValid) {
        const fetched = await fetchAllSheetsFromGoogle();
        sheetNames = fetched.sheetNames;
        sheetData = fetched.sheetData;
        wasCached = false;
      }

      // Everyone can view all tasks, PULSE, CLOSED, and all member sheets
      let responseSheetNames = sheetNames;
      let responseSheetData = sheetData;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        sheetNames: responseSheetNames, 
        data: responseSheetData, 
        statusOptions: Array.from(KNOWN_STATUSES),
        cached: wasCached 
      }));
    } catch (err) {
      console.error('Error fetching sheets:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // GET /api/statuses -> Dynamic list of known internal statuses
  if (urlObj.pathname === '/api/statuses' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, statuses: Array.from(KNOWN_STATUSES) }));
    return;
  }

  // POST /api/pulse/sync -> Force sync PULSE sheet from Chetna to Master
  if (urlObj.pathname === '/api/pulse/sync' && req.method === 'POST') {
    try {
      await syncPulseSheet();
      const { sheetNames, sheetData } = await fetchAllSheetsFromGoogle();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: 'PULSE sheet synced successfully with Master!', 
        pulse: sheetData['PULSE'] || [], 
        data: sheetData 
      }));
    } catch (err) {
      console.error('Error syncing PULSE:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/jira/fetch-ticket -> Fetch ticket details from Jira
  if (urlObj.pathname === '/api/jira/fetch-ticket' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        if (!body) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Empty request body' }));
          return;
        }
        const { ticket } = JSON.parse(body);
        if (!ticket) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Ticket key is required' }));
          return;
        }

        const ticketKey = ticket.trim().toUpperCase();
        console.log(`[Jira Lookup] Querying ${ticketKey}...`);

        const jiraRes = await executeComposioTool('JIRA_GET_ISSUE', {
          issue_key: ticketKey,
          fields: ['summary', 'status', 'duedate', 'assignee', 'priority']
        });

        const issueData = jiraRes?.data?.results?.[0]?.response?.data || {};
        const fields = issueData.fields || {};

        if (!fields.summary) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Ticket not found or inaccessible in Jira' }));
          return;
        }

        const formattedDueDate = parseJiraDueDate(fields.duedate);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          ticket: ticketKey,
          title: fields.summary,
          jiraStatus: fields.status?.name || 'To Do',
          internalStatus: fields.status?.name || 'To Pick Up',
          status: fields.status?.name || 'To Pick Up',
          dueDate: formattedDueDate,
          assignee: fields.assignee?.displayName || ''
        }));
      } catch (err) {
        console.error('Jira fetch error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/update-internal-status -> Edit internal status from UI for a ticket
  if (urlObj.pathname === '/api/ticket/update-internal-status' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { assignee, ticket, internalStatus, rowNumber } = JSON.parse(body);
        if (!assignee || !internalStatus) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'assignee and internalStatus are required' }));
          return;
        }

        const tabName = assignee.trim().toUpperCase();

        // RBAC Check: Team members can only update their own assigned tasks
        const clientRole = (req.headers['x-user-role'] || '').toUpperCase();
        const clientUser = (req.headers['x-user-name'] || '').toLowerCase();
        const userConfig = USER_ACCOUNTS[clientUser];
        if (clientRole === 'MEMBER' && userConfig && !userConfig.allowedSheets.includes('ALL')) {
          const isAllowed = userConfig.allowedSheets.some(s => s.toUpperCase() === tabName);
          if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Permission denied: As a team member, you can only update your own tasks (${userConfig.allowedSheets.join(', ')}).` }));
            return;
          }
        }

        let targetRow = parseInt(rowNumber, 10);

        // If rowNumber is not supplied or invalid, find row in sheet by ticket
        if (!targetRow || isNaN(targetRow)) {
          const currentRes = await executeComposioTool('GOOGLESHEETS_VALUES_GET', {
            spreadsheet_id: SPREADSHEET_ID,
            range: `${tabName}!A1:H50`
          });
          const rows = currentRes?.data?.results?.[0]?.response?.data?.values || [];
          const foundIdx = rows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticket.trim().toUpperCase());
          if (foundIdx > 0) {
            targetRow = foundIdx + 1;
          } else {
            targetRow = 2;
          }
        }

        console.log(`[Update Internal Status] Tab: ${tabName}, Row: ${targetRow}, Status: ${internalStatus}`);

        // 1. Update Column F (Internal Status) in Google Sheets
        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: [{
            range: `${tabName}!F${targetRow}`,
            majorDimension: 'ROWS',
            values: [[internalStatus]]
          }]
        });

        // 2. Format cell F
        const colorConfig = STATUS_COLORS[internalStatus] || STATUS_COLORS['To Pick Up'];
        await executeComposioTool('GOOGLESHEETS_FORMAT_CELL', {
          spreadsheet_id: SPREADSHEET_ID,
          sheet_name: tabName,
          range: `F${targetRow}`,
          background_color: colorConfig.bg,
          text_color: colorConfig.text,
          bold: true,
          horizontal_alignment: 'CENTER'
        });

        // Register custom status if new
        registerCustomStatus(internalStatus);

        // 3. Update memory cache if present
        if (cache.data && cache.data[tabName]) {
          const rIdx = targetRow - 1;
          if (cache.data[tabName][rIdx]) {
            cache.data[tabName][rIdx][5] = internalStatus;
          }
          if (INDIVIDUAL_SHEETS[tabName]) {
            pushMasterToIndividualSheet(tabName, cache.data[tabName]).catch(() => {});
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          assignee: tabName,
          ticket,
          internalStatus,
          rowNumber: targetRow
        }));
      } catch (err) {
        console.error('Error updating internal status:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/reassign -> Internally assign / reassign ticket from one team member to another
  if (urlObj.pathname === '/api/ticket/reassign' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticket, fromAssignee, toAssignee } = JSON.parse(body);
        if (!ticket || !fromAssignee || !toAssignee) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket, fromAssignee, and toAssignee are required' }));
          return;
        }

        const fromTab = fromAssignee.trim().toUpperCase();
        const toTab = toAssignee.trim().toUpperCase();
        const ticketKey = ticket.trim().toUpperCase();

        // RBAC Check: Team members can only reassign their own tasks
        const clientRole = (req.headers['x-user-role'] || '').toUpperCase();
        const clientUser = (req.headers['x-user-name'] || '').toLowerCase();
        const userConfig = USER_ACCOUNTS[clientUser];
        if (clientRole === 'MEMBER' && userConfig && !userConfig.allowedSheets.includes('ALL')) {
          const isAllowed = userConfig.allowedSheets.some(s => s.toUpperCase() === fromTab);
          if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Permission denied: As a team member, you can only reassign tasks currently assigned to your own sheet (${userConfig.allowedSheets.join(', ')}).` }));
            return;
          }
        }

        if (fromTab === toTab) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Already assigned to this member', ticket: ticketKey, assignee: toTab }));
          return;
        }

        console.log(`[Reassign] Moving ${ticketKey} from ${fromTab} -> ${toTab}...`);

        // 1. Fetch current rows from both tabs
        const getTools = [
          {
            tool_slug: 'GOOGLESHEETS_VALUES_GET',
            arguments: { spreadsheet_id: SPREADSHEET_ID, range: `${fromTab}!A1:H50` }
          },
          {
            tool_slug: 'GOOGLESHEETS_VALUES_GET',
            arguments: { spreadsheet_id: SPREADSHEET_ID, range: `${toTab}!A1:H50` }
          }
        ];

        const getRes = await executeComposioBatch(getTools);
        const fromRows = getRes?.data?.results?.[0]?.response?.data?.values || [];
        const toRows = getRes?.data?.results?.[1]?.response?.data?.values || [];

        // 2. Find row in fromTab
        const targetIdx = fromRows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
        if (targetIdx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Ticket ${ticketKey} not found in ${fromTab}'s tab` }));
          return;
        }

        const targetRow = fromRows[targetIdx];
        const jiraStatus = targetRow[4] || 'To Do';
        const internalStatus = targetRow[5] || 'To Pick Up';

        // 3. Remove row from fromTab and re-index
        const newFromRows = fromRows.filter((_, idx) => idx !== targetIdx);
        newFromRows.forEach((r, idx) => {
          if (idx > 0) r[0] = String(idx);
        });

        // Pad fromRows with empty cells to wipe out the old last row
        const paddedFromRows = [...newFromRows];
        const emptyRow = ['', '', '', '', '', '', '', ''];
        while (paddedFromRows.length < fromRows.length) {
          paddedFromRows.push(emptyRow);
        }

        // 4. Upsert row to toTab (prevent duplicate entries if already in destination tab)
        const newToRows = [...toRows];
        if (newToRows.length === 0 || newToRows[0][0] !== '#') {
          newToRows.unshift(['#', 'Ticket ID', 'Ticket Link', 'Title', 'Jira Status', 'Internal Status', 'Action / Notes', 'Due Date']);
        }
        const existingToIdx = newToRows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
        const movedRow = [...targetRow];

        let newRowIndex;
        if (existingToIdx > 0) {
          // Update in-place to prevent duplicate
          movedRow[0] = String(existingToIdx);
          newToRows[existingToIdx] = movedRow;
          newRowIndex = existingToIdx + 1;
        } else {
          // Append as new entry
          const nextNum = String(newToRows.length);
          movedRow[0] = nextNum;
          newToRows.push(movedRow);
          newRowIndex = newToRows.length;
        }

        // 5. Batch update Google Sheets for both tabs
        const updatePayload = [
          {
            range: `${fromTab}!A1:H${paddedFromRows.length}`,
            majorDimension: 'ROWS',
            values: paddedFromRows
          },
          {
            range: `${toTab}!A1:H${newToRows.length}`,
            majorDimension: 'ROWS',
            values: newToRows
          }
        ];

        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: updatePayload
        });

        // 6. Format status cells in toTab
        const jCol = STATUS_COLORS[jiraStatus] || STATUS_COLORS['To Pick Up'];
        const iCol = STATUS_COLORS[internalStatus] || STATUS_COLORS['To Pick Up'];

        await executeComposioBatch([
          {
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              sheet_name: toTab,
              range: `E${newRowIndex}`,
              background_color: jCol.bg,
              text_color: jCol.text,
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          },
          {
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              sheet_name: toTab,
              range: `F${newRowIndex}`,
              background_color: iCol.bg,
              text_color: iCol.text,
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          }
        ]);

        // 7. Update in-memory cache
        if (cache.data) {
          cache.data[fromTab] = newFromRows;
          cache.data[toTab] = newToRows;
          cache.timestamp = Date.now();
        }

        if (INDIVIDUAL_SHEETS[fromTab]) pushMasterToIndividualSheet(fromTab, newFromRows).catch(() => {});
        if (INDIVIDUAL_SHEETS[toTab]) pushMasterToIndividualSheet(toTab, newToRows).catch(() => {});

        console.log(`✅ [Reassign Complete] ${ticketKey} moved from ${fromTab} -> ${toTab}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          ticket: ticketKey,
          fromAssignee: fromTab,
          toAssignee: toTab,
          fromRowCount: newFromRows.length - 1,
          toRowCount: newToRows.length - 1,
          data: cache.data
        }));
      } catch (err) {
        console.error('Error reassigning ticket:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/manage-shared -> Configure shared assignees with custom roles for a ticket
  if (urlObj.pathname === '/api/ticket/manage-shared' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticket, assignees, removeAssignees } = JSON.parse(body);
        if (!ticket || !Array.isArray(assignees) || assignees.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket and non-empty assignees array are required' }));
          return;
        }

        const ticketKey = ticket.trim().toUpperCase();
        console.log(`[Manage Shared] Updating shared assignment for ${ticketKey}:`, assignees);

        // Fetch all sheets from Google
        const { sheetNames, sheetData } = await fetchAllSheetsFromGoogle();
        
        // Find ticket info across existing sheets or query Jira
        let existingInfo = null;
        for (const tab of sheetNames) {
          const rows = sheetData[tab] || [];
          const found = rows.find((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
          if (found) {
            existingInfo = {
              ticketKey: found[1],
              ticketUrl: found[2] || `https://enveu.atlassian.net/browse/${ticketKey}`,
              title: found[3] || '',
              jiraStatus: found[4] || 'To Do',
              internalStatus: found[5] || 'To Pick Up',
              notes: found[6] || '',
              dueDate: found[7] || 'Not set'
            };
            break;
          }
        }

        if (!existingInfo) {
          try {
            const jRes = await executeComposioTool('JIRA_GET_ISSUE', {
              issue_key: ticketKey,
              fields: ['summary', 'status', 'duedate']
            });
            const fields = jRes?.data?.results?.[0]?.response?.data?.fields || {};
            existingInfo = {
              ticketKey,
              ticketUrl: `https://enveu.atlassian.net/browse/${ticketKey}`,
              title: fields.summary || `Ticket ${ticketKey}`,
              jiraStatus: fields.status?.name || 'To Do',
              internalStatus: 'To Pick Up',
              notes: '',
              dueDate: parseJiraDueDate(fields.duedate)
            };
          } catch (e) {
            existingInfo = {
              ticketKey,
              ticketUrl: `https://enveu.atlassian.net/browse/${ticketKey}`,
              title: `Ticket ${ticketKey}`,
              jiraStatus: 'To Do',
              internalStatus: 'To Pick Up',
              notes: '',
              dueDate: 'Not set'
            };
          }
        }

        // Build canonical shared label, e.g. [Shared: KRISHNA (BE) + CHETNA (FE)]
        const sharedLabelTag = `[Shared: ${assignees.map(a => `${a.name.toUpperCase()} (${a.role || 'Contributor'})`).join(' + ')}]`;

        const updatePayload = [];
        const formatCalls = [];

        // 1. Process assignees that SHOULD have this ticket
        for (const a of assignees) {
          const tabName = a.name.trim().toUpperCase();
          if (!sheetNames.includes(tabName)) continue;

          let rows = sheetData[tabName] || [];
          if (rows.length === 0 || rows[0][0] !== '#') {
            rows.unshift(['#', 'Ticket ID', 'Ticket Link', 'Title', 'Jira Status', 'Internal Status', 'Action / Notes', 'Due Date']);
          }

          const existingIdx = rows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
          const iStatus = a.status || (existingIdx > 0 ? rows[existingIdx][5] : existingInfo.internalStatus);
          
          let cleanNotes = (existingIdx > 0 ? rows[existingIdx][6] : existingInfo.notes) || '';
          cleanNotes = cleanNotes.replace(/\[Shared:.*?\]\s*/gi, '').trim();
          const roleNote = a.role ? `Role: ${a.role}` : '';
          const finalNotes = cleanNotes ? `${sharedLabelTag} ${roleNote} - ${cleanNotes}` : `${sharedLabelTag} ${roleNote}`;

          let targetRowIdx;
          if (existingIdx > 0) {
            targetRowIdx = existingIdx + 1;
            rows[existingIdx][5] = iStatus;
            rows[existingIdx][6] = finalNotes;
          } else {
            const nextIdx = rows.length;
            targetRowIdx = nextIdx + 1;
            const newRow = [
              String(nextIdx),
              existingInfo.ticketKey,
              existingInfo.ticketUrl,
              existingInfo.title,
              existingInfo.jiraStatus,
              iStatus,
              finalNotes,
              existingInfo.dueDate
            ];
            rows.push(newRow);
          }

          sheetData[tabName] = rows;
          updatePayload.push({
            range: `${tabName}!A1:H${rows.length}`,
            majorDimension: 'ROWS',
            values: rows
          });

          const jCol = STATUS_COLORS[existingInfo.jiraStatus] || STATUS_COLORS['To Pick Up'];
          const iCol = STATUS_COLORS[iStatus] || STATUS_COLORS['To Pick Up'];

          formatCalls.push({
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              sheet_name: tabName,
              range: `E${targetRowIdx}`,
              background_color: jCol.bg,
              text_color: jCol.text,
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          });
          formatCalls.push({
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              sheet_name: tabName,
              range: `F${targetRowIdx}`,
              background_color: iCol.bg,
              text_color: iCol.text,
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          });
        }

        // 2. Process removeAssignees (unassigned members)
        if (Array.isArray(removeAssignees)) {
          for (const rem of removeAssignees) {
            const remTab = rem.trim().toUpperCase();
            const rows = sheetData[remTab] || [];
            const rIdx = rows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
            if (rIdx > 0) {
              const oldLength = rows.length;
              const newRows = rows.filter((_, idx) => idx !== rIdx);
              newRows.forEach((r, idx) => { if (idx > 0) r[0] = String(idx); });
              while (newRows.length < oldLength) {
                newRows.push(['', '', '', '', '', '', '', '']);
              }
              sheetData[remTab] = newRows;
              updatePayload.push({
                range: `${remTab}!A1:H${newRows.length}`,
                majorDimension: 'ROWS',
                values: newRows
              });
            }
          }
        }

        // 3. Write updates to Google Sheets
        if (updatePayload.length > 0) {
          await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
            spreadsheet_id: SPREADSHEET_ID,
            valueInputOption: 'USER_ENTERED',
            data: updatePayload
          });
        }

        // 4. Apply format calls
        if (formatCalls.length > 0) {
          await executeComposioBatch(formatCalls);
        }

        // 5. Update cache
        cache = {
          sheetNames,
          data: sheetData,
          timestamp: Date.now()
        };

        console.log(`✅ [Manage Shared Complete] ${ticketKey} updated for assignees:`, assignees.map(a => a.name));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          ticket: ticketKey,
          assignees,
          data: sheetData
        }));
      } catch (err) {
        console.error('Error managing shared assignees:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/delete -> Delete a ticket row from Google Sheets
  if (urlObj.pathname === '/api/ticket/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticket, assignee, allTabs } = JSON.parse(body);
        if (!ticket) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket key is required' }));
          return;
        }

        const ticketKey = ticket.trim().toUpperCase();
        console.log(`[Delete Ticket] Removing ${ticketKey} from ${assignee ? assignee : 'all tabs'}...`);

        // RBAC Check: Team members can only delete tasks from their own sheet
        const clientRole = (req.headers['x-user-role'] || '').toUpperCase();
        const clientUser = (req.headers['x-user-name'] || '').toLowerCase();
        const userConfig = USER_ACCOUNTS[clientUser];
        if (clientRole === 'MEMBER' && userConfig && !userConfig.allowedSheets.includes('ALL')) {
          const targetTab = assignee ? assignee.trim().toUpperCase() : '';
          const isAllowed = targetTab && userConfig.allowedSheets.some(s => s.toUpperCase() === targetTab);
          if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Permission denied: As a team member, you can only delete tasks from your own sheet (${userConfig.allowedSheets.join(', ')}).` }));
            return;
          }
        }

        // 1. Fetch live sheets
        const { sheetNames, sheetData } = await fetchAllSheetsFromGoogle();
        const targetTabs = (assignee && !allTabs) ? [assignee.trim().toUpperCase()] : sheetNames;

        const updatePayload = [];
        let deletedFromCount = 0;

        for (const tab of targetTabs) {
          if (!sheetData[tab]) continue;
          const rows = sheetData[tab] || [];
          const targetIdx = rows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);

          if (targetIdx > 0) {
            deletedFromCount++;
            const oldLength = rows.length;
            const newRows = rows.filter((_, idx) => idx !== targetIdx);
            newRows.forEach((r, idx) => {
              if (idx > 0) r[0] = String(idx);
            });

            // Pad with empty row to clear out deleted row in Google Sheets
            const paddedRows = [...newRows];
            while (paddedRows.length < oldLength) {
              paddedRows.push(['', '', '', '', '', '', '', '']);
            }

            sheetData[tab] = newRows;
            updatePayload.push({
              range: `${tab}!A1:H${paddedRows.length}`,
              majorDimension: 'ROWS',
              values: paddedRows
            });
          }
        }

        if (updatePayload.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Ticket ${ticketKey} not found in target sheet tabs` }));
          return;
        }

        // 2. Write updates to Google Sheets
        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: updatePayload
        });

        // 3. Update cache
        cache = {
          sheetNames,
          data: sheetData,
          timestamp: Date.now()
        };

        console.log(`✅ [Delete Ticket Complete] ${ticketKey} deleted from ${deletedFromCount} tab(s)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          ticket: ticketKey,
          deletedFromCount,
          data: sheetData
        }));
      } catch (err) {
        console.error('Error deleting ticket:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/close -> Move a ticket to the CLOSED Google Sheet tab
  if (urlObj.pathname === '/api/ticket/close' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticket, fromAssignee, allTabs } = JSON.parse(body);
        if (!ticket) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket key is required' }));
          return;
        }

        const ticketKey = ticket.trim().toUpperCase();
        console.log(`[Close Ticket] Moving ${ticketKey} from ${fromAssignee ? fromAssignee : 'all tabs'} to CLOSED sheet...`);

        // RBAC Check: Team members can only close tasks from their own sheet
        const clientRole = (req.headers['x-user-role'] || '').toUpperCase();
        const clientUser = (req.headers['x-user-name'] || '').toLowerCase();
        const userConfig = USER_ACCOUNTS[clientUser];
        if (clientRole === 'MEMBER' && userConfig && !userConfig.allowedSheets.includes('ALL')) {
          const fromTab = fromAssignee ? fromAssignee.trim().toUpperCase() : '';
          const isAllowed = fromTab && userConfig.allowedSheets.some(s => s.toUpperCase() === fromTab);
          if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Permission denied: As a team member, you can only close tasks from your own sheet (${userConfig.allowedSheets.join(', ')}).` }));
            return;
          }
        }

        // 1. Fetch live sheets
        const { sheetNames, sheetData } = await fetchAllSheetsFromGoogle();

        let closedTab = sheetNames.find(s => s.trim().toUpperCase() === 'CLOSED') || 'CLOSED';
        let closedRows = sheetData[closedTab] || [];
        if (closedRows.length === 0 || (closedRows[0][0] !== '#' && closedRows[0][0] !== 'SNo')) {
          closedRows.unshift(['#', 'Ticket ID', 'Ticket Link', 'Title', 'Jira Status', 'Internal Status', 'Action / Notes', 'Due Date']);
        }

        // Determine target member tabs to remove from
        const memberTabs = (fromAssignee && !allTabs)
          ? [fromAssignee.trim().toUpperCase()]
          : sheetNames.filter(s => s.trim().toUpperCase() !== closedTab.toUpperCase());

        let movedTicketData = null;
        const updatePayload = [];
        let removedCount = 0;

        for (const tab of memberTabs) {
          if (!sheetData[tab]) continue;
          const rows = sheetData[tab] || [];
          const targetIdx = rows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);

          if (targetIdx > 0) {
            removedCount++;
            if (!movedTicketData) {
              movedTicketData = [...rows[targetIdx]];
            }
            const oldLength = rows.length;
            const newRows = rows.filter((_, idx) => idx !== targetIdx);
            newRows.forEach((r, idx) => {
              if (idx > 0) r[0] = String(idx);
            });

            // Pad with empty row to clear out deleted row in Google Sheets
            const paddedRows = [...newRows];
            while (paddedRows.length < oldLength) {
              paddedRows.push(['', '', '', '', '', '', '', '']);
            }

            sheetData[tab] = newRows;
            updatePayload.push({
              range: `${tab}!A1:H${paddedRows.length}`,
              majorDimension: 'ROWS',
              values: paddedRows
            });
          }
        }

        if (!movedTicketData) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Ticket ${ticketKey} not found in member sheet tabs` }));
          return;
        }

        // Prepare row in CLOSED sheet
        const existingClosedIdx = closedRows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
        const closedRow = [...movedTicketData];
        while (closedRow.length < 8) closedRow.push('');

        // Set status to Closed
        closedRow[5] = 'Closed';

        let targetClosedRowIdx;
        if (existingClosedIdx > 0) {
          closedRow[0] = String(existingClosedIdx);
          closedRows[existingClosedIdx] = closedRow;
          targetClosedRowIdx = existingClosedIdx + 1;
        } else {
          const nextNum = String(closedRows.length);
          closedRow[0] = nextNum;
          closedRows.push(closedRow);
          targetClosedRowIdx = closedRows.length;
        }

        sheetData[closedTab] = closedRows;
        updatePayload.push({
          range: `${closedTab}!A1:H${closedRows.length}`,
          majorDimension: 'ROWS',
          values: closedRows
        });

        // 2. Batch update Google Sheets
        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: updatePayload
        });

        // 3. Format status cells in CLOSED sheet
        const cCol = STATUS_COLORS['Closed'];
        await executeComposioBatch([
          {
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              sheet_name: closedTab,
              range: `F${targetClosedRowIdx}`,
              background_color: cCol.bg,
              text_color: cCol.text,
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          }
        ]);

        // 4. Update server cache
        cache = {
          sheetNames,
          data: sheetData,
          timestamp: Date.now()
        };

        console.log(`✅ [Close Ticket Complete] ${ticketKey} moved from ${removedCount} tab(s) to ${closedTab}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          ticket: ticketKey,
          data: sheetData
        }));
      } catch (err) {
        console.error('Error closing ticket:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/reopen -> Move a ticket from CLOSED back to a member sheet tab
  if (urlObj.pathname === '/api/ticket/reopen' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticket, toAssignee } = JSON.parse(body);
        if (!ticket || !toAssignee) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket and toAssignee are required' }));
          return;
        }

        const ticketKey = ticket.trim().toUpperCase();
        const destTab = toAssignee.trim().toUpperCase();
        console.log(`[Reopen Ticket] Moving ${ticketKey} from CLOSED to ${destTab}...`);

        const { sheetNames, sheetData } = await fetchAllSheetsFromGoogle();
        let closedTab = sheetNames.find(s => s.trim().toUpperCase() === 'CLOSED') || 'CLOSED';

        const closedRows = sheetData[closedTab] || [];
        const targetIdx = closedRows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);

        if (targetIdx <= 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Ticket ${ticketKey} not found in ${closedTab} tab` }));
          return;
        }

        const targetRow = [...closedRows[targetIdx]];
        while (targetRow.length < 8) targetRow.push('');

        // Remove from CLOSED
        const oldLength = closedRows.length;
        const newClosedRows = closedRows.filter((_, idx) => idx !== targetIdx);
        newClosedRows.forEach((r, idx) => {
          if (idx > 0) r[0] = String(idx);
        });
        const paddedClosedRows = [...newClosedRows];
        while (paddedClosedRows.length < oldLength) {
          paddedClosedRows.push(['', '', '', '', '', '', '', '']);
        }
        sheetData[closedTab] = newClosedRows;

        // Upsert into destTab
        const toRows = sheetData[destTab] || [];
        const newToRows = [...toRows];
        if (newToRows.length === 0 || (newToRows[0][0] !== '#' && newToRows[0][0] !== 'SNo')) {
          newToRows.unshift(['#', 'Ticket ID', 'Ticket Link', 'Title', 'Jira Status', 'Internal Status', 'Action / Notes', 'Due Date']);
        }

        // Set status back to 'To Pick Up' (or Jira status)
        targetRow[5] = targetRow[4] || 'To Pick Up';
        const existingToIdx = newToRows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);

        let newRowIndex;
        if (existingToIdx > 0) {
          targetRow[0] = String(existingToIdx);
          newToRows[existingToIdx] = targetRow;
          newRowIndex = existingToIdx + 1;
        } else {
          targetRow[0] = String(newToRows.length);
          newToRows.push(targetRow);
          newRowIndex = newToRows.length;
        }
        sheetData[destTab] = newToRows;

        const updatePayload = [
          {
            range: `${closedTab}!A1:H${paddedClosedRows.length}`,
            majorDimension: 'ROWS',
            values: paddedClosedRows
          },
          {
            range: `${destTab}!A1:H${newToRows.length}`,
            majorDimension: 'ROWS',
            values: newToRows
          }
        ];

        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: updatePayload
        });

        // Format status cell in destTab
        const iCol = STATUS_COLORS[targetRow[5]] || STATUS_COLORS['To Pick Up'];
        await executeComposioBatch([
          {
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              sheet_name: destTab,
              range: `F${newRowIndex}`,
              background_color: iCol.bg,
              text_color: iCol.text,
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          }
        ]);

        cache = {
          sheetNames,
          data: sheetData,
          timestamp: Date.now()
        };

        console.log(`✅ [Reopen Complete] ${ticketKey} reopened to ${destTab}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          ticket: ticketKey,
          toAssignee: destTab,
          data: sheetData
        }));
      } catch (err) {
        console.error('Error reopening ticket:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/jira/sync-all -> Batch sync all Jira tickets across all sheets
  if (urlObj.pathname === '/api/jira/sync-all' && req.method === 'POST') {
    try {
      console.log('⚡ Starting Bulk Jira Sync for All Sheets...');
      
      // 1. Fetch live sheets
      const { sheetNames, sheetData } = await fetchAllSheetsFromGoogle();
      
      // 2. Collect unique Jira tickets
      const allTicketKeys = new Set();
      sheetNames.forEach(tab => {
        const rows = sheetData[tab] || [];
        rows.forEach((row, idx) => {
          if (idx === 0 && row[0] === '#') return;
          const ticket = (row[1] || '').trim().toUpperCase();
          if (ticket && ticket.includes('-')) {
            allTicketKeys.add(ticket);
          }
        });
      });

      const keyList = Array.from(allTicketKeys);
      console.log(`Found ${keyList.length} Jira tickets across all sheets:`, keyList);

      if (keyList.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, count: 0, message: 'No tickets to sync', data: sheetData }));
        return;
      }

      // 3. Batch query Jira for all tickets
      const jiraTools = keyList.map(k => ({
        tool_slug: 'JIRA_GET_ISSUE',
        arguments: {
          issue_key: k,
          fields: ['summary', 'status', 'duedate']
        }
      }));

      const jiraRes = await executeComposioBatch(jiraTools);
      const jiraMap = {};

      if (jiraRes?.data?.results) {
        jiraRes.data.results.forEach((r, i) => {
          const k = keyList[i];
          const fields = r.response?.data?.fields || {};
          if (fields.summary || fields.status) {
            jiraMap[k] = {
              title: fields.summary || '',
              jiraStatus: fields.status?.name || 'To Do',
              dueDate: parseJiraDueDate(fields.duedate)
            };
          }
        });
      }

      console.log(`Successfully fetched details for ${Object.keys(jiraMap).length} tickets from Jira.`);

      // 4. Update rows for each sheet tab and prepare batch writes (8 columns)
      const updateData = [];
      const formatCalls = [];
      let updatedCount = 0;

      sheetNames.forEach(tab => {
        const rows = sheetData[tab] || [];
        if (rows.length <= 1) return;

        let hasTabChanges = false;
        rows.forEach((row, rIdx) => {
          if (rIdx === 0 && row[0] === '#') return;
          const k = (row[1] || '').trim().toUpperCase();
          if (jiraMap[k]) {
            const j = jiraMap[k];
            
            // row: [#, Ticket ID, Ticket Link, Title, Jira Status, Internal Status, Action/Notes, Due Date]
            if (j.title) row[3] = j.title;
            if (j.jiraStatus) row[4] = j.jiraStatus;
            // row[5] is Internal Status (keep as-is or set if empty)
            if (!row[5]) row[5] = j.jiraStatus || 'To Pick Up';
            
            // row[7] is Due Date from Jira
            if (j.dueDate) row[7] = j.dueDate;

            // Ensure ticket URL is properly set in row[2]
            row[2] = `https://enveu.atlassian.net/browse/${k}`;

            hasTabChanges = true;
            updatedCount++;

            // Color formatting for Jira Status (Col E) and Internal Status (Col F)
            const cellRow = rIdx + 1; // 1-based index in Google Sheets
            
            const jCol = STATUS_COLORS[row[4]] || STATUS_COLORS['To Pick Up'];
            formatCalls.push({
              tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
              arguments: {
                spreadsheet_id: SPREADSHEET_ID,
                sheet_name: tab,
                range: `E${cellRow}`,
                background_color: jCol.bg,
                text_color: jCol.text,
                bold: true,
                horizontal_alignment: 'CENTER'
              }
            });

            const iCol = STATUS_COLORS[row[5]] || STATUS_COLORS['To Pick Up'];
            formatCalls.push({
              tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
              arguments: {
                spreadsheet_id: SPREADSHEET_ID,
                sheet_name: tab,
                range: `F${cellRow}`,
                background_color: iCol.bg,
                text_color: iCol.text,
                bold: true,
                horizontal_alignment: 'CENTER'
              }
            });
          }
        });

        if (hasTabChanges) {
          updateData.push({
            range: `${tab}!A1:H${rows.length}`,
            majorDimension: 'ROWS',
            values: rows
          });
        }
      });

      // 5. Execute batch write to Google Sheets
      if (updateData.length > 0) {
        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: updateData
        });
      }

      // 6. Apply format colors in batches of 20
      if (formatCalls.length > 0) {
        const CHUNK_SIZE = 20;
        for (let i = 0; i < formatCalls.length; i += CHUNK_SIZE) {
          const chunk = formatCalls.slice(i, i + CHUNK_SIZE);
          await executeComposioBatch(chunk);
        }
      }

      // 7. Update cache
      cache = {
        data: sheetData,
        sheetNames,
        timestamp: Date.now()
      };

      console.log(`✅ Bulk Sync Complete. Synchronized ${updatedCount} ticket rows with Jira & Google Sheets.`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        count: updatedCount,
        sheetNames,
        data: sheetData
      }));
    } catch (err) {
      console.error('Error in sync-all:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/add-ticket -> Add ticket to sheet & dashboard (8 columns)
  if (urlObj.pathname === '/api/add-ticket' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        let {
          ticket,
          assignee,
          title,
          jiraStatus,
          internalStatus,
          status,
          notes,
          dueDate
        } = payload;

        if (!ticket || !assignee) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket and assignee are required' }));
          return;
        }

        const tabName = assignee.trim().toUpperCase();

        // RBAC Check: Team members can only add tickets assigned to their own sheet
        const clientRole = (req.headers['x-user-role'] || '').toUpperCase();
        const clientUser = (req.headers['x-user-name'] || '').toLowerCase();
        const userConfig = USER_ACCOUNTS[clientUser];
        if (clientRole === 'MEMBER' && userConfig && !userConfig.allowedSheets.includes('ALL')) {
          const isAllowed = userConfig.allowedSheets.some(s => s.toUpperCase() === tabName);
          if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Permission denied: As a team member, you can only add tasks to your own sheet (${userConfig.allowedSheets.join(', ')}).` }));
            return;
          }
        }

        const ticketKey = ticket.trim().toUpperCase();
        const ticketUrl = `https://enveu.atlassian.net/browse/${ticketKey}`;

        // Query Jira to verify / fill missing fields
        try {
          const jiraRes = await executeComposioTool('JIRA_GET_ISSUE', {
            issue_key: ticketKey,
            fields: ['summary', 'status', 'duedate', 'assignee']
          });
          const fields = jiraRes?.data?.results?.[0]?.response?.data?.fields || {};
          if (fields.summary && !title) title = fields.summary;
          if (fields.status?.name) jiraStatus = fields.status.name;
          if (!dueDate || dueDate === 'Not set' || dueDate.toLowerCase() === 'tbd') {
            dueDate = parseJiraDueDate(fields.duedate);
          }
        } catch (e) {
          console.warn('Jira lookup exception:', e.message);
        }

        const finalTitle = title || `Ticket ${ticketKey}`;
        const finalJiraStatus = jiraStatus || 'To Do';
        const finalInternalStatus = internalStatus || status || finalJiraStatus || 'To Pick Up';
        const finalDueDate = parseJiraDueDate(dueDate);
        const finalNotes = notes || `Added on ${formatToday()}`;

        // Support for Shared / Multi-Member Task Creation
        if (payload.isShared && Array.isArray(payload.sharedAssignees) && payload.sharedAssignees.length > 0) {
          const sharedAssignees = payload.sharedAssignees;
          const sharedLabelTag = `[Shared: ${sharedAssignees.map(a => `${a.name.toUpperCase()} (${a.role || 'Contributor'})`).join(' + ')}]`;

          for (const a of sharedAssignees) {
            const memberTab = a.name.trim().toUpperCase();
            const memberRole = a.role ? `Role: ${a.role}` : '';
            const memberNotes = notes ? `${sharedLabelTag} ${memberRole} - ${notes}` : `${sharedLabelTag} ${memberRole}`;
            const memberStatus = a.status || finalInternalStatus;

            const curRes = await executeComposioTool('GOOGLESHEETS_VALUES_GET', {
              spreadsheet_id: SPREADSHEET_ID,
              range: `${memberTab}!A1:H100`
            });
            const memberRows = curRes?.data?.results?.[0]?.response?.data?.values || [];
            const existingMemberIdx = memberRows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
            
            let targetIdx;
            let targetRowNum;
            if (existingMemberIdx > 0) {
              targetIdx = memberRows[existingMemberIdx][0];
              targetRowNum = existingMemberIdx + 1;
            } else {
              const nextIdx = memberRows.length > 0 && memberRows[0][0] === '#' ? memberRows.length : (memberRows.length + 1);
              targetIdx = String(nextIdx);
              targetRowNum = memberRows.length > 0 ? (memberRows.length + 1) : 2;
            }

            const rowData = [
              targetIdx,
              ticketKey,
              ticketUrl,
              finalTitle,
              finalJiraStatus,
              memberStatus,
              memberNotes,
              finalDueDate
            ];

            await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
              spreadsheet_id: SPREADSHEET_ID,
              valueInputOption: 'USER_ENTERED',
              data: [{
                range: `${memberTab}!A${targetRowNum}:H${targetRowNum}`,
                majorDimension: 'ROWS',
                values: [rowData]
              }]
            });

            const jCol = STATUS_COLORS[finalJiraStatus] || STATUS_COLORS['To Pick Up'];
            const iCol = STATUS_COLORS[memberStatus] || STATUS_COLORS['To Pick Up'];

            await executeComposioBatch([
              {
                tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
                arguments: {
                  spreadsheet_id: SPREADSHEET_ID,
                  sheet_name: memberTab,
                  range: `E${targetRowNum}`,
                  background_color: jCol.bg,
                  text_color: jCol.text,
                  bold: true,
                  horizontal_alignment: 'CENTER'
                }
              },
              {
                tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
                arguments: {
                  spreadsheet_id: SPREADSHEET_ID,
                  sheet_name: memberTab,
                  range: `F${targetRowNum}`,
                  background_color: iCol.bg,
                  text_color: iCol.text,
                  bold: true,
                  horizontal_alignment: 'CENTER'
                }
              }
            ]);
          }

          cache.timestamp = 0;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            isShared: true,
            sharedAssignees,
            ticket: ticketKey,
            message: `Shared ticket ${ticketKey} synced across ${sharedAssignees.map(a => a.name).join(' & ')} tabs.`
          }));
          return;
        }

        // 1. Fetch live sheets to check if ticket already exists across ANY tab
        const { sheetNames, sheetData } = await fetchAllSheetsFromGoogle();
        const existingLocations = [];
        sheetNames.forEach(tab => {
          const rows = sheetData[tab] || [];
          const found = rows.find((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
          if (found) {
            existingLocations.push({
              tab,
              title: found[3] || '',
              internalStatus: found[5] || found[4] || 'To Pick Up'
            });
          }
        });

        // If ticket already exists in another member's tab and confirmReassign is not set
        const otherTabs = existingLocations.filter(loc => loc.tab !== tabName);
        if (otherTabs.length > 0 && !payload.confirmReassign) {
          const assignedNames = otherTabs.map(l => l.tab).join(', ');
          console.warn(`[Add Ticket Duplicate Warning] ${ticketKey} already exists in ${assignedNames}`);
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            alreadyAssigned: true,
            existingAssignees: otherTabs.map(l => l.tab),
            message: `Ticket ${ticketKey} is already present and assigned to ${assignedNames}.`
          }));
          return;
        }

        // If confirmReassign is true, remove ticket from previous tabs to prevent duplicates
        if (otherTabs.length > 0 && payload.confirmReassign) {
          console.log(`[Add Ticket Reassign] Removing ${ticketKey} from ${otherTabs.map(l => l.tab).join(', ')} to move to ${tabName}...`);
          const removeBatch = [];
          for (const loc of otherTabs) {
            const oldTab = loc.tab;
            const rows = sheetData[oldTab] || [];
            const rIdx = rows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
            if (rIdx > 0) {
              const oldLength = rows.length;
              const newRows = rows.filter((_, idx) => idx !== rIdx);
              newRows.forEach((r, idx) => { if (idx > 0) r[0] = String(idx); });
              while (newRows.length < oldLength) {
                newRows.push(['', '', '', '', '', '', '', '']);
              }
              sheetData[oldTab] = newRows;
              removeBatch.push({
                range: `${oldTab}!A1:H${newRows.length}`,
                majorDimension: 'ROWS',
                values: newRows
              });
            }
          }
          if (removeBatch.length > 0) {
            await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
              spreadsheet_id: SPREADSHEET_ID,
              valueInputOption: 'USER_ENTERED',
              data: removeBatch
            });
          }
        }

        // 2. Fetch current rows from target assignee sheet tab (from sheetData)
        const currentRows = sheetData[tabName] || [];
        const existingIdx = currentRows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);

        let targetIndexStr;
        let targetRowNum;
        let isExisting = false;

        if (existingIdx > 0) {
          // Prevent duplicate: Update existing row in place
          isExisting = true;
          targetIndexStr = currentRows[existingIdx][0];
          targetRowNum = existingIdx + 1;
        } else {
          // Append new row
          const nextIndex = currentRows.length > 0 && currentRows[0][0] === '#' ? currentRows.length : (currentRows.length + 1);
          targetIndexStr = String(nextIndex);
          targetRowNum = currentRows.length > 0 ? (currentRows.length + 1) : 2;
        }

        const newRow = [
          targetIndexStr,
          ticketKey,
          ticketUrl,
          finalTitle,
          finalJiraStatus,
          finalInternalStatus,
          finalNotes,
          finalDueDate
        ];

        // 2. Write / update row to Google Sheets
        const writeRange = `${tabName}!A${targetRowNum}:H${targetRowNum}`;
        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: [{
            range: writeRange,
            majorDimension: 'ROWS',
            values: [newRow]
          }]
        });

        // 3. Format Jira Status (Col E) and Internal Status (Col F)
        const jCol = STATUS_COLORS[finalJiraStatus] || STATUS_COLORS['To Pick Up'];
        const iCol = STATUS_COLORS[finalInternalStatus] || STATUS_COLORS['To Pick Up'];
        await executeComposioBatch([
          {
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              sheet_name: tabName,
              range: `E${targetRowNum}`,
              background_color: jCol.bg,
              text_color: jCol.text,
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          },
          {
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              sheet_name: tabName,
              range: `F${targetRowNum}`,
              background_color: iCol.bg,
              text_color: iCol.text,
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          }
        ]);

        // Invalidate cache immediately
        cache.timestamp = 0;

        if (finalInternalStatus) registerCustomStatus(finalInternalStatus);
        if (INDIVIDUAL_SHEETS[tabName]) {
          if (isExisting) {
            currentRows[existingIdx] = newRow;
          } else {
            currentRows.push(newRow);
          }
          pushMasterToIndividualSheet(tabName, currentRows).catch(() => {});
        }

        const successMsg = isExisting
          ? `Ticket ${ticketKey} was already assigned to ${tabName} — existing row details updated.`
          : (otherTabs.length > 0 && payload.confirmReassign
            ? `Ticket ${ticketKey} successfully reassigned from ${otherTabs.map(l => l.tab).join(', ')} to ${tabName}!`
            : `Added ${ticketKey} to ${tabName}!`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          tabName,
          rowNumber: targetRowNum,
          isUpdate: isExisting,
          alreadyExistedForMember: isExisting,
          reassignedFrom: otherTabs.length > 0 && payload.confirmReassign ? otherTabs.map(l => l.tab) : null,
          message: successMsg,
          row: newRow
        }));
      } catch (err) {
        console.error('Error adding ticket:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

const server = http.createServer(handleRequest);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`🚀 Task Sheet Sync Server running at http://localhost:${PORT}`);
  });
}

module.exports = {
  handleRequest,
  USER_ACCOUNTS,
  fetchAllSheetsFromGoogle,
  verifyComposioApiKey,
  server
};
