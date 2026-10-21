const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3100;
const SPREADSHEET_ID = '1mMe1z7_fZRKjAcd_uMGUsY15SFfRcBPUKfttcYDa9FY';
const COMPOSIO_KEY = process.env.COMPOSIO_API_KEY || '';

// Stateless Server-Sealed Encryption for Device Tokens (AES-256-GCM)
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'task-sync-v2-device-seal-key-default-2026';
const CIPHER_KEY = crypto.createHash('sha256').update(ENCRYPTION_SECRET).digest();

// Polyfill global fetch using Node.js built-in https for Node < 18
if (typeof global.fetch !== 'function') {
  global.fetch = function fetchPolyfill(url, options = {}, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      if (redirectCount > 5) {
        return reject(new Error('Too many redirects'));
      }
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;
      const headers = { ...(options.headers || {}) };
      const body = options.body;
      if (body && !headers['Content-Length'] && !headers['content-length']) {
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = client.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).href;
          return resolve(fetchPolyfill(nextUrl, options, redirectCount + 1));
        }
        let chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            text: async () => text,
            json: async () => {
              try {
                return JSON.parse(text);
              } catch (e) {
                return text;
              }
            }
          });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };
}



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

const COMPOSIO_CONFIG_PATH = path.join(os.tmpdir(), 'task_sync_composio_config.json');

function loadComposioConfig() {
  try {
    if (fs.existsSync(COMPOSIO_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(COMPOSIO_CONFIG_PATH, 'utf8'));
      if (parsed && parsed.apiKey) {
        return parsed.apiKey;
      }
    }
  } catch (e) {
    console.warn('Could not read composio_config.json:', e.message);
  }
  return process.env.COMPOSIO_API_KEY || COMPOSIO_KEY || '';
}

function saveComposioConfig(key) {
  try {
    if (key && (key.startsWith('ck_') || key.startsWith('sealed_v1:'))) {
      fs.writeFileSync(COMPOSIO_CONFIG_PATH, JSON.stringify({ apiKey: key, lastUpdated: new Date().toISOString() }, null, 2), 'utf8');
      return true;
    }
  } catch (e) {
    console.warn('Could not write composio_config.json:', e.message);
  }
  return false;
}

let lastKnownActiveApiKey = loadComposioConfig();

function resolveApiKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return lastKnownActiveApiKey || loadComposioConfig() || '';
  const trimmed = rawKey.trim();
  if (trimmed.startsWith('ck_')) return trimmed;
  if (trimmed.startsWith('sealed_v1:')) {
    const unsealed = unsealApiKey(trimmed);
    return unsealed || lastKnownActiveApiKey || loadComposioConfig() || '';
  }
  return lastKnownActiveApiKey || loadComposioConfig() || '';
}

// ==========================================
// 🚀 YouTrack Integration Engine & Config
// ==========================================
const YOUTRACK_BASE_URL = process.env.YOUTRACK_BASE_URL || 'https://enveu.youtrack.cloud';
const YOUTRACK_CONFIG_PATH = path.join(os.tmpdir(), 'task_sync_youtrack_config.json');

function loadYouTrackConfig() {
  try {
    if (fs.existsSync(YOUTRACK_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(YOUTRACK_CONFIG_PATH, 'utf8'));
      return {
        baseUrl: parsed.baseUrl || YOUTRACK_BASE_URL,
        token: parsed.token || process.env.YOUTRACK_TOKEN || '',
        stateField: parsed.stateField || 'State',
        lastUpdated: parsed.lastUpdated || null
      };
    }
  } catch (e) {
    console.warn('Could not read youtrack_config.json:', e.message);
  }
  return {
    baseUrl: process.env.YOUTRACK_BASE_URL || YOUTRACK_BASE_URL,
    token: process.env.YOUTRACK_TOKEN || '',
    stateField: 'State',
    lastUpdated: null
  };
}

function saveYouTrackConfig(cfg) {
  try {
    fs.writeFileSync(YOUTRACK_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('Could not write youtrack_config.json:', e.message);
    return false;
  }
}

let activeYouTrackToken = loadYouTrackConfig().token || '';
let currentRequestYouTrackToken = null;

function parseYouTrackDueDate(rawDate) {
  if (!rawDate || rawDate === 'null' || rawDate === 'None') return 'Not set';
  if (typeof rawDate === 'object' && rawDate.presentation) return String(rawDate.presentation);
  if (typeof rawDate === 'number' || /^\d{10,13}$/.test(String(rawDate))) {
    const ms = Number(rawDate) < 10000000000 ? Number(rawDate) * 1000 : Number(rawDate);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${d.getDate()} ${months[d.getMonth()]}`;
    }
  }
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

function convertDateToYouTrackIso(raw) {
  if (!raw || raw === 'Not set' || raw === 'null' || raw === 'None') return null;
  const s = String(raw).trim();
  if (s.toLowerCase() === 'tbd') return null;

  // 1. Check YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${String(isoMatch[2]).padStart(2, '0')}-${String(isoMatch[3]).padStart(2, '0')}`;
  }

  // 2. Check DD Mon or DD Mon YYYY (e.g. 26 Oct or 26 Oct 2026)
  const monthMap = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const monMatch = s.match(/^(\d{1,2})[\s\-\/]+([a-zA-Z]{3,9})(?:[\s\-\/]+(\d{4}))?$/);
  if (monMatch) {
    const day = String(monMatch[1]).padStart(2, '0');
    const monKey = monMatch[2].slice(0, 3).toLowerCase();
    const month = monthMap[monKey];
    const year = monMatch[3] || new Date().getFullYear();
    if (month) return `${year}-${month}-${day}`;
  }

  // 3. Check DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) {
    const day = String(dmyMatch[1]).padStart(2, '0');
    const month = String(dmyMatch[2]).padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }

  // 4. Fallback Date object / parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return null;
}

async function verifyYouTrackToken(tokenToTest, customUrl) {
  const cfg = loadYouTrackConfig();
  const token = (tokenToTest || currentRequestYouTrackToken || activeYouTrackToken || cfg.token || '').trim();
  const cleanBaseUrl = (customUrl || cfg.baseUrl || YOUTRACK_BASE_URL).replace(/\/+$/, '');

  if (!token) {
    return { valid: false, error: 'Token is empty. Please enter your YouTrack Access Token.' };
  }

  try {
    const resp = await fetch(`${cleanBaseUrl}/api/users/me?fields=id,login,name,guest`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    if (resp.status === 401 || resp.status === 403) {
      return { valid: false, error: `Authentication failed (HTTP ${resp.status}): Token is invalid or expired.` };
    }

    if (!resp.ok) {
      const txt = await resp.text();
      return { valid: false, error: `YouTrack responded with HTTP ${resp.status}: ${txt}` };
    }

    const user = await resp.json();
    if (user.guest) {
      return { valid: false, error: 'Token resolved as Guest user. Please use a token with authenticated permissions.' };
    }

    return {
      valid: true,
      baseUrl: cleanBaseUrl,
      user: {
        id: user.id,
        login: user.login,
        name: user.name || user.login
      }
    };
  } catch (err) {
    return { valid: false, error: `Failed to connect to YouTrack: ${err.message}` };
  }
}

async function fetchYouTrackIssue(issueKey, customToken) {
  const cfg = loadYouTrackConfig();
  const token = (customToken || currentRequestYouTrackToken || activeYouTrackToken || cfg.token || '').trim();
  if (!token) {
    const err = new Error('YouTrack Access Token is missing. Please configure your token in the dashboard.');
    err.status = 401;
    err.isAuthError = true;
    throw err;
  }

  const cleanBaseUrl = (cfg.baseUrl || YOUTRACK_BASE_URL).replace(/\/+$/, '');
  const cleanKey = issueKey.trim().toUpperCase();
  const url = `${cleanBaseUrl}/api/issues/${encodeURIComponent(cleanKey)}?fields=idReadable,summary,resolved,customFields(name,value(name,presentation,text,minutes)),comments(id,text,created,author(name,login,avatarUrl),attachments(name,url,mimeType))`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    }
  });

  if (resp.status === 401 || resp.status === 403) {
    const err = new Error(`YouTrack Access Token expired or unauthorized (HTTP ${resp.status}). Please update token in dashboard.`);
    err.status = resp.status;
    err.isAuthError = true;
    throw err;
  }

  if (resp.status === 404) {
    const err = new Error(`Issue ${cleanKey} not found in YouTrack.`);
    err.status = 404;
    throw err;
  }

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`YouTrack error HTTP ${resp.status}: ${txt}`);
  }

  const issue = await resp.json();
  const title = issue.summary || '';
  let youTrackStatus = 'To Do';
  let dueDate = 'Not set';

  if (Array.isArray(issue.customFields)) {
    for (const cf of issue.customFields) {
      const cfName = (cf.name || '').trim().toLowerCase();
      // Match State / Status / Stage
      if (cfName === 'state' || cfName === 'status' || cfName === 'stage') {
        const val = cf.value?.name || cf.value?.presentation || cf.value?.text || (typeof cf.value === 'string' ? cf.value : null);
        if (val) youTrackStatus = String(val).trim();
      }
      // Match Due date
      if (cfName.includes('due') || cfName === 'deadline' || cfName === 'target date') {
        if (cf.value) {
          dueDate = parseYouTrackDueDate(cf.value);
        }
      }
    }
  }

  const comments = Array.isArray(issue.comments) ? issue.comments.map(c => {
    let avatar = c.author?.avatarUrl || '';
    if (avatar && !avatar.startsWith('http')) {
      avatar = `${cleanBaseUrl}${avatar}`;
    }
    return {
      id: c.id || `c-${c.created || Date.now()}`,
      text: c.text || '',
      created: c.created || Date.now(),
      author: {
        name: c.author?.name || c.author?.login || 'User',
        login: c.author?.login || 'user',
        avatarUrl: avatar
      },
      attachments: Array.isArray(c.attachments) ? c.attachments.map(a => ({
        name: a.name || 'attachment',
        url: a.url ? (a.url.startsWith('http') ? a.url : `${cleanBaseUrl}${a.url}`) : ''
      })) : []
    };
  }) : [];

  return {
    ticket: issue.idReadable || cleanKey,
    title,
    youTrackStatus,
    jiraStatus: youTrackStatus, // backward compatible
    status: youTrackStatus,
    dueDate,
    url: `${cleanBaseUrl}/issue/${issue.idReadable || cleanKey}`,
    comments
  };
}


// ==========================================
// 💬 Comment System Backend Engine (Node 16 Compatible https.request)
// ==========================================
const COMMENTS_STORE_PATH = process.env.VERCEL
  ? path.join(os.tmpdir(), 'comments.json')
  : path.join(__dirname, 'data', 'comments.json');
let cachedMentionUsers = null;
let lastMentionUsersFetch = 0;

function loadLocalComments() {
  try {
    if (fs.existsSync(COMMENTS_STORE_PATH)) {
      return JSON.parse(fs.readFileSync(COMMENTS_STORE_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[loadLocalComments] Error reading comments.json:', e.message);
  }
  return {};
}

function saveLocalComments(commentsMap) {
  try {
    const dir = path.dirname(COMMENTS_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(COMMENTS_STORE_PATH, JSON.stringify(commentsMap, null, 2), 'utf8');
  } catch (e) {
    console.warn('[saveLocalComments] Error writing comments.json:', e.message);
  }
}

function httpsYouTrackRequest({ method = 'GET', apiPath, body = null, token, timeout = 15000 }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      hostname: 'enveu.youtrack.cloud',
      path: '/api' + apiPath,
      method,
      timeout,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': payload.length
        } : {})
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: data });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`YouTrack request timed out (${timeout}ms): ${apiPath}`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchYouTrackComments(issueKey, customToken) {
  const cfg = loadYouTrackConfig();
  const token = (customToken || currentRequestYouTrackToken || activeYouTrackToken || cfg.token || '').trim();
  if (!token) return [];

  const cleanBaseUrl = (cfg.baseUrl || YOUTRACK_BASE_URL).replace(/\/+$/, '');
  const cleanKey = String(issueKey).trim().toUpperCase();
  const apiPath = `/issues/${encodeURIComponent(cleanKey)}/comments?fields=id,text,created,author(name,login,avatarUrl),attachments(name,url,mimeType)&$top=100`;

  try {
    const resp = await httpsYouTrackRequest({ method: 'GET', apiPath, token });
    if (!resp.ok) {
      console.warn(`[YouTrack Comments] HTTP ${resp.status} for ${cleanKey}`);
      return [];
    }

    const rawComments = resp.data;
    if (!Array.isArray(rawComments)) return [];

    return rawComments.map(c => {
      let avatar = c.author?.avatarUrl || '';
      if (avatar && !avatar.startsWith('http')) {
        avatar = `${cleanBaseUrl}${avatar}`;
      }
      return {
        id: c.id || `c-${c.created || Date.now()}`,
        text: c.text || '',
        created: c.created || Date.now(),
        author: {
          name: c.author?.name || c.author?.login || 'User',
          login: c.author?.login || '',
          avatarUrl: avatar
        },
        attachments: Array.isArray(c.attachments) ? c.attachments.map(a => ({
          name: a.name || 'attachment',
          url: a.url && !a.url.startsWith('http') ? `${cleanBaseUrl}${a.url}` : a.url,
          mimeType: a.mimeType || ''
        })) : []
      };
    });
  } catch (err) {
    console.warn(`[YouTrack Comments] Fetch error for ${cleanKey}:`, err.message);
    return [];
  }
}

async function postYouTrackComment(issueKey, text, customToken) {
  const cfg = loadYouTrackConfig();
  const token = (customToken || currentRequestYouTrackToken || activeYouTrackToken || cfg.token || '').trim();
  if (!token) throw new Error('YouTrack Access Token is missing.');

  const cleanBaseUrl = (cfg.baseUrl || YOUTRACK_BASE_URL).replace(/\/+$/, '');
  const cleanKey = String(issueKey).trim().toUpperCase();
  const apiPath = `/issues/${encodeURIComponent(cleanKey)}/comments?fields=id,text,created,author(name,login,avatarUrl),attachments(name,url,mimeType)`;

  // In YouTrack, user mentions MUST use @<login> (e.g. @arushdeep.gupta@enveu.com or @abhinav.rajput)
  // Convert any @Name or @@Name into @login for all known users
  let commentPayloadText = (text || '').trim();
  try {
    const mentionUsers = await getMentionableUsers();
    const sorted = [...mentionUsers].sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0));
    sorted.forEach(u => {
      if (u.name && u.login) {
        const escapedName = u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const reg = new RegExp(`@{1,2}(${escapedName})(?![a-zA-Z0-9_])`, 'gi');
        commentPayloadText = commentPayloadText.replace(reg, `@${u.login}`);
      }
    });
  } catch (e) {
    console.warn('[postYouTrackComment] Mentions normalization note:', e.message);
  }

  const resp = await httpsYouTrackRequest({
    method: 'POST',
    apiPath,
    body: { text: commentPayloadText },
    token
  });

  if (!resp.ok) {
    const errText = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || resp.text);
    throw new Error(`YouTrack error HTTP ${resp.status}: ${errText}`);
  }

  const c = resp.data;
  let avatar = c.author?.avatarUrl || '';
  if (avatar && !avatar.startsWith('http')) {
    avatar = `${cleanBaseUrl}${avatar}`;
  }
  return {
    id: c.id || `c-${c.created || Date.now()}`,
    text: c.text || text,
    created: c.created || Date.now(),
    author: {
      name: c.author?.name || c.author?.login || 'User',
      login: c.author?.login || '',
      avatarUrl: avatar
    },
    attachments: Array.isArray(c.attachments) ? c.attachments : []
  };
}

async function updateYouTrackComment(issueKey, commentId, text, customToken) {
  const cfg = loadYouTrackConfig();
  const token = (customToken || currentRequestYouTrackToken || activeYouTrackToken || cfg.token || '').trim();
  if (!token) throw new Error('YouTrack Access Token is missing.');

  const cleanBaseUrl = (cfg.baseUrl || YOUTRACK_BASE_URL).replace(/\/+$/, '');
  const cleanKey = String(issueKey).trim().toUpperCase();
  const cleanCommentId = String(commentId).trim();
  const apiPath = `/issues/${encodeURIComponent(cleanKey)}/comments/${encodeURIComponent(cleanCommentId)}?fields=id,text,created,author(name,login,avatarUrl),attachments(name,url,mimeType)`;

  let commentPayloadText = (text || '').trim();
  try {
    const mentionUsers = await getMentionableUsers();
    const sorted = [...mentionUsers].sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0));
    sorted.forEach(u => {
      if (u.name && u.login) {
        const escapedName = u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const reg = new RegExp(`@{1,2}(${escapedName})(?![a-zA-Z0-9_])`, 'gi');
        commentPayloadText = commentPayloadText.replace(reg, `@${u.login}`);
      }
    });
  } catch (e) {
    console.warn('[updateYouTrackComment] Mentions normalization note:', e.message);
  }

  const resp = await httpsYouTrackRequest({
    method: 'POST',
    apiPath,
    body: { text: commentPayloadText },
    token
  });

  if (!resp.ok) {
    const errText = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || resp.text);
    throw new Error(`YouTrack error HTTP ${resp.status}: ${errText}`);
  }

  const c = resp.data;
  let avatar = c.author?.avatarUrl || '';
  if (avatar && !avatar.startsWith('http')) {
    avatar = `${cleanBaseUrl}${avatar}`;
  }
  return {
    id: c.id || cleanCommentId,
    text: c.text || text,
    created: c.created || Date.now(),
    author: {
      name: c.author?.name || c.author?.login || 'User',
      login: c.author?.login || '',
      avatarUrl: avatar
    },
    attachments: Array.isArray(c.attachments) ? c.attachments : []
  };
}

async function deleteYouTrackComment(issueKey, commentId, customToken) {
  const cfg = loadYouTrackConfig();
  const token = (customToken || currentRequestYouTrackToken || activeYouTrackToken || cfg.token || '').trim();
  if (!token) throw new Error('YouTrack Access Token is missing.');

  const cleanKey = String(issueKey).trim().toUpperCase();
  const cleanCommentId = String(commentId).trim();
  const apiPath = `/issues/${encodeURIComponent(cleanKey)}/comments/${encodeURIComponent(cleanCommentId)}`;

  const resp = await httpsYouTrackRequest({
    method: 'DELETE',
    apiPath,
    token
  });

  if (!resp.ok && resp.status !== 404) {
    const errText = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || resp.text);
    throw new Error(`YouTrack delete error HTTP ${resp.status}: ${errText}`);
  }
  return true;
}

async function syncLatestCommentToSheet(ticketKey, latestComment, assignee, rowNumber) {
  if (!assignee || typeof executeComposioTool !== 'function') return null;
  try {
    const tabName = assignee.trim().toUpperCase();
    const isPulseTab = tabName === 'PULSE';
    const colLetter = isPulseTab ? 'C' : 'G';
    const colIdx = isPulseTab ? 2 : 6;

    let summaryForSheet = '';
    if (latestComment && latestComment.text) {
      const cleanSnippet = (latestComment.text || '')
        .replace(/!\[.*?\]\(.*?\)/g, '[Image]')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
      const dateStr = new Date(latestComment.created || Date.now()).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
      summaryForSheet = `[${latestComment.author?.name || 'Team'} • ${dateStr}]: ${cleanSnippet.slice(0, 160)}`;
    }

    let targetRow = parseInt(rowNumber, 10);
    if (!targetRow || isNaN(targetRow)) {
      const currentRes = await executeComposioTool('GOOGLESHEETS_VALUES_GET', {
        spreadsheet_id: SPREADSHEET_ID,
        range: `${tabName}!A1:I100`
      });
      const rows = currentRes?.data?.results?.[0]?.response?.data?.values || [];
      const foundIdx = rows.findIndex((r, idx) => {
        if (idx === 0) return false;
        const t1 = (r[1] || '').trim().toUpperCase();
        const t0 = (r[0] || '').trim().toUpperCase();
        return t1 === ticketKey || t0 === ticketKey;
      });
      targetRow = foundIdx > 0 ? (foundIdx + 1) : 2;
    }

    await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
      spreadsheet_id: SPREADSHEET_ID,
      valueInputOption: 'USER_ENTERED',
      data: [{
        range: `${tabName}!${colLetter}${targetRow}`,
        majorDimension: 'ROWS',
        values: [[summaryForSheet]]
      }]
    });

    if (cache.data && cache.data[tabName]) {
      const rIdx = targetRow - 1;
      if (cache.data[tabName][rIdx]) {
        cache.data[tabName][rIdx][colIdx] = summaryForSheet;
      }
    }
    return summaryForSheet;
  } catch (err) {
    console.warn(`[syncLatestCommentToSheet Note] ${err.message}`);
    return null;
  }
}

async function getMentionableUsers() {
  const now = Date.now();
  if (cachedMentionUsers && (now - lastMentionUsersFetch < 300000)) {
    return cachedMentionUsers;
  }

  const teamList = [
    { name: 'Arush Deep Gupta', login: 'arushdeep.gupta@enveu.com', role: 'Team Lead' },
    { name: 'Chetna', login: 'chetna@enveu.com', role: 'Frontend Engineer' },
    { name: 'Krishna', login: 'krishna@enveu.com', role: 'Frontend Engineer' },
    { name: 'Manish', login: 'manish@enveu.com', role: 'Fullstack Engineer' },
    { name: 'Rahul', login: 'rahul@enveu.com', role: 'Frontend Engineer' },
    { name: 'Sonu', login: 'sonu@enveu.com', role: 'Frontend Engineer' },
    { name: 'Abhinav Rajput', login: 'abhinav.rajput', role: 'Engineering Manager' },
    { name: 'Tanisha Upadhyay', login: 'Tanisha.Upadhyay', role: 'QA / Product' },
    { name: 'Sumayya Siddiqui', login: 'Sumayya.Siddiqui', role: 'Product Manager' }
  ];

  let ytUsers = [];
  try {
    const cfg = loadYouTrackConfig();
    const token = (currentRequestYouTrackToken || activeYouTrackToken || cfg.token || '').trim();
    if (token) {
      const cleanBaseUrl = (cfg.baseUrl || YOUTRACK_BASE_URL).replace(/\/+$/, '');
      const resp = await httpsYouTrackRequest({
        method: 'GET',
        apiPath: '/users?fields=id,login,name,avatarUrl&$top=200',
        token
      });
      if (resp.ok && Array.isArray(resp.data)) {
        ytUsers = resp.data.map(u => ({
          name: u.name || u.login,
          login: u.login,
          avatarUrl: u.avatarUrl && !u.avatarUrl.startsWith('http') ? `${cleanBaseUrl}${u.avatarUrl}` : (u.avatarUrl || '')
        }));
      }
    }
  } catch (e) {
    console.warn('[getMentionableUsers] YouTrack users fetch note:', e.message);
  }

  // Merge unique by login
  const map = new Map();
  teamList.forEach(u => map.set(u.login.toLowerCase(), { ...u, isTeam: true }));
  ytUsers.forEach(u => {
    const key = u.login.toLowerCase();
    if (!map.has(key)) {
      map.set(key, { ...u, isTeam: false });
    } else {
      const existing = map.get(key);
      if (u.avatarUrl) existing.avatarUrl = u.avatarUrl;
    }
  });

  cachedMentionUsers = Array.from(map.values());
  lastMentionUsersFetch = now;
  return cachedMentionUsers;
}

async function executeYouTrackCommand(issueKey, commandQuery, customToken) {
  const cfg = loadYouTrackConfig();
  const token = (customToken || currentRequestYouTrackToken || activeYouTrackToken || cfg.token || '').trim();
  const cleanBaseUrl = (cfg.baseUrl || YOUTRACK_BASE_URL).replace(/\/+$/, '');
  const cleanKey = String(issueKey).trim().toUpperCase();

  if (!token) {
    throw new Error('YouTrack Access Token is missing or empty. Please enter your YouTrack token.');
  }

  const url = `${cleanBaseUrl}/api/commands`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      query: commandQuery,
      issues: [{ idReadable: cleanKey }]
    })
  });

  if (resp.status === 401 || resp.status === 403) {
    const err = new Error(`YouTrack Access Token expired or unauthorized (HTTP ${resp.status}).`);
    err.status = resp.status;
    err.isAuthError = true;
    throw err;
  }

  if (!resp.ok) {
    const txt = await resp.text();
    let msg = txt;
    try {
      const j = JSON.parse(txt);
      msg = j.error_description || j.error || txt;
    } catch (_) {}
    throw new Error(`YouTrack command error: ${msg}`);
  }

  return true;
}

async function updateYouTrackIssueState(issueKey, newState, customToken) {
  const cfg = loadYouTrackConfig();
  const token = (customToken || currentRequestYouTrackToken || activeYouTrackToken || cfg.token || '').trim();
  const cleanBaseUrl = (cfg.baseUrl || YOUTRACK_BASE_URL).replace(/\/+$/, '');
  const cleanKey = String(issueKey).trim().toUpperCase();

  if (!token) {
    throw new Error('YouTrack Access Token is missing or empty. Please enter your YouTrack token.');
  }

  // 1. Fetch the issue custom fields to inspect the State field type & possibleEvents
  const metaUrl = `${cleanBaseUrl}/api/issues/${cleanKey}/customFields?fields=id,name,$type,value(id,name),possibleEvents(id,name,presentation)`;
  const metaResp = await fetch(metaUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    }
  });

  if (metaResp.status === 401 || metaResp.status === 403) {
    const err = new Error(`YouTrack Access Token expired or unauthorized (HTTP ${metaResp.status}).`);
    err.status = metaResp.status;
    err.isAuthError = true;
    throw err;
  }

  let stateField = null;
  if (metaResp.ok) {
    const fields = await metaResp.json();
    stateField = fields.find(f => (f.name || '').toLowerCase() === 'state');
  }

  async function postEvent(fieldId, eventObj) {
    const postUrl = `${cleanBaseUrl}/api/issues/${cleanKey}/customFields/${fieldId}?fields=id,name,value(id,name)`;
    const postResp = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        $type: 'StateMachineIssueCustomField',
        event: {
          id: eventObj.id,
          name: eventObj.name
        }
      })
    });
    if (!postResp.ok) {
      const errTxt = await postResp.text();
      let errMsg = errTxt;
      try {
        const j = JSON.parse(errTxt);
        errMsg = j.error_description || j.error || errTxt;
      } catch (_) {}
      throw new Error(`State machine transition to "${eventObj.name}" failed: ${errMsg}`);
    }
    const resData = await postResp.json();
    return resData?.value?.name;
  }

  // 2. If it is a StateMachineIssueCustomField (like in Project EN):
  if (stateField && stateField.$type === 'StateMachineIssueCustomField') {
    const curStateName = stateField.value?.name || '';
    if (curStateName.toLowerCase() === newState.toLowerCase()) {
      return { success: true, state: curStateName };
    }

    const events = stateField.possibleEvents || [];
    
    // Direct match check
    const directMatch = events.find(e => 
      (e.name || '').toLowerCase() === newState.toLowerCase() ||
      (e.presentation || '').toLowerCase() === newState.toLowerCase()
    );

    if (directMatch) {
      const finalState = await postEvent(stateField.id, directMatch);
      return { success: true, state: finalState || newState };
    }

    // Smart multi-hop path for State Machine (e.g. into "Verify")
    if (newState.toLowerCase() === 'verify') {
      // If current is Closed, Reopen first
      if (curStateName.toLowerCase() === 'closed') {
        const reopenEvent = events.find(e => (e.name || '').toLowerCase() === 'reopen');
        if (reopenEvent) {
          await postEvent(stateField.id, reopenEvent);
        }
      }

      // Check if we can move to an In Progress state
      const refreshedResp = await fetch(metaUrl, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
      });
      if (refreshedResp.ok) {
        const updatedFields = await refreshedResp.json();
        const curField = updatedFields.find(f => (f.name || '').toLowerCase() === 'state');
        const curEvents = curField?.possibleEvents || [];

        // Check if Verify is now available
        let verifyMatch = curEvents.find(e => (e.name || '').toLowerCase() === 'verify' || (e.presentation || '').toLowerCase() === 'verify');
        if (verifyMatch) {
          const finalState = await postEvent(stateField.id, verifyMatch);
          return { success: true, state: finalState || 'Verify' };
        }

        // Try transitioning to In Progress (L3) or any In Progress
        const inProg = curEvents.find(e => (e.name || '').toLowerCase().includes('in progress'));
        if (inProg) {
          await postEvent(stateField.id, inProg);

          // Now fetch events from In Progress
          const step2Resp = await fetch(metaUrl, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
          });
          if (step2Resp.ok) {
            const step2Fields = await step2Resp.json();
            const step2Field = step2Fields.find(f => (f.name || '').toLowerCase() === 'state');
            const step2Events = step2Field?.possibleEvents || [];
            verifyMatch = step2Events.find(e => (e.name || '').toLowerCase() === 'verify' || (e.presentation || '').toLowerCase() === 'verify');
            if (verifyMatch) {
              const finalState = await postEvent(stateField.id, verifyMatch);
              return { success: true, state: finalState || 'Verify' };
            }
          }
        }
      }
    }

    // Smart multi-hop for transitioning to "In Progress" (e.g. from Verify or Closed)
    if (newState.toLowerCase().includes('in progress')) {
      if (curStateName.toLowerCase() === 'verify' || curStateName.toLowerCase() === 'closed') {
        const reopenEvent = events.find(e => (e.name || '').toLowerCase() === 'reopen');
        if (reopenEvent) {
          await postEvent(stateField.id, reopenEvent);
          const refetch = await fetch(metaUrl, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
          if (refetch.ok) {
            const refFields = await refetch.json();
            const refField = refFields.find(f => (f.name || '').toLowerCase() === 'state');
            const refEvents = refField?.possibleEvents || [];
            const inProgMatch = refEvents.find(e => 
              (e.name || '').toLowerCase() === newState.toLowerCase() || 
              (e.presentation || '').toLowerCase() === newState.toLowerCase()
            );
            if (inProgMatch) {
              const finalState = await postEvent(stateField.id, inProgMatch);
              return { success: true, state: finalState || newState };
            }
          }
        }
      }
    }

    // Smart multi-hop for "Escalated to L2" or "Escalated to L3":
    if (newState.toLowerCase().includes('escalated')) {
      const inProg = events.find(e => (e.name || '').toLowerCase().includes('in progress'));
      if (inProg) {
        await postEvent(stateField.id, inProg);
        const refetch = await fetch(metaUrl, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
        if (refetch.ok) {
          const refFields = await refetch.json();
          const refState = refFields.find(f => (f.name || '').toLowerCase() === 'state');
          const refEvents = refState?.possibleEvents || [];
          const escMatch = refEvents.find(e => (e.name || '').toLowerCase() === newState.toLowerCase() || (e.presentation || '').toLowerCase() === newState.toLowerCase());
          if (escMatch) {
            const finalState = await postEvent(stateField.id, escMatch);
            return { success: true, state: finalState || newState };
          }
        }
      }
    }

    const allowed = events.map(e => e.presentation || e.name).join(', ');
    throw new Error(`State machine does not allow transition from "${curStateName}" to "${newState}". Allowed transitions: ${allowed || 'none'}`);
  }

  // 3. Fallback to standard YouTrack commands API for non-state-machine fields (e.g. SES)
  await executeYouTrackCommand(cleanKey, `State ${newState}`, token);
  return { success: true, state: newState };
}

async function batchFetchYouTrackIssues(keyList, customToken) {
  const CHUNK_SIZE = 15;
  const youTrackMap = {};
  let authErrorOccurred = null;

  for (let i = 0; i < keyList.length; i += CHUNK_SIZE) {
    const chunkKeys = keyList.slice(i, i + CHUNK_SIZE);
    const promises = chunkKeys.map(async key => {
      try {
        const item = await fetchYouTrackIssue(key, customToken);
        return { key, item };
      } catch (err) {
        if (err.isAuthError) authErrorOccurred = err;
        console.warn(`[YouTrack] Error fetching ${key}:`, err.message);
        return { key, error: err.message };
      }
    });

    const chunkResults = await Promise.all(promises);
    chunkResults.forEach(res => {
      if (res.item) {
        youTrackMap[res.key] = res.item;
      }
    });

    if (authErrorOccurred) {
      throw authErrorOccurred;
    }
  }

  return youTrackMap;
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
    allowedSheets: ['ARUSH', 'PLAN']
  },
  'chetna': {
    username: 'chetna',
    password: 'chetna@enveu2026',
    name: 'Chetna',
    role: 'MEMBER',
    allowedSheets: ['CHETNA', 'FE Ready', 'FE READY', 'PLAN']
  },
  'krishna': {
    username: 'krishna',
    password: 'krishna@enveu2026',
    name: 'Krishna',
    role: 'MEMBER',
    allowedSheets: ['KRISHNA', 'PLAN']
  },
  'manish': {
    username: 'manish',
    password: 'manish@enveu2026',
    name: 'Manish',
    role: 'MEMBER',
    allowedSheets: ['MANISH', 'PLAN']
  },
  'rahul': {
    username: 'rahul',
    password: 'rahul@enveu2026',
    name: 'Rahul',
    role: 'MEMBER',
    allowedSheets: ['RAHUL', 'PLAN']
  },
  'sonu': {
    username: 'sonu',
    password: 'sonu@enveu2026',
    name: 'Sonu',
    role: 'MEMBER',
    allowedSheets: ['SONU', 'PLAN']
  }
};

let currentRequestApiKey = null;
if (!lastKnownActiveApiKey) lastKnownActiveApiKey = loadComposioConfig() || '';
let currentRequestUser = 'workspace';

// Monthly Composio Free Allowance Tracker (100,000 free calls / month)
const USAGE_FILE = path.join(os.tmpdir(), 'task_sync_composio_usage.json');
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

// Cache with disk persistence & 3-minute TTL (Prevents redundant Google Sheets calls on page reloads)
const CACHE_FILE = path.join(os.tmpdir(), 'task_sync_sheets_cache.json');

function loadDiskCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (parsed && parsed.data && Object.keys(parsed.data).length > 0) {
        let totalRows = 0;
        for (const rows of Object.values(parsed.data)) {
          if (Array.isArray(rows) && rows.length > 1) totalRows += (rows.length - 1);
        }
        if (totalRows > 0) {
          console.log(`[loadDiskCache] Loaded ${totalRows} cached tickets across ${Object.keys(parsed.data).length} sheets from runtime disk cache.`);
          return {
            data: parsed.data,
            sheetNames: parsed.sheetNames || Object.keys(parsed.data),
            timestamp: parsed.timestamp || 0
          };
        }
      }
    }
  } catch (e) {
    console.warn('Could not read sheets_cache.json:', e.message);
  }
  return { data: null, sheetNames: null, timestamp: 0 };
}

function saveDiskCache(c) {
  try {
    if (c && c.data) {
      let totalRows = 0;
      for (const rows of Object.values(c.data)) {
        if (Array.isArray(rows) && rows.length > 1) totalRows += (rows.length - 1);
      }
      // CRITICAL: Never write an empty cache to disk!
      if (totalRows > 0) {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), 'utf8');
      }
    }
  } catch (e) {
    console.warn('Could not write sheets_cache.json:', e.message);
  }
}

let cache = loadDiskCache();
const CACHE_TTL_MS = 300000; // 5 minutes (300,000 ms)

let isBackgroundFetchingSheets = false;
async function refreshSheetsInBackground() {
  if (isBackgroundFetchingSheets) return;
  isBackgroundFetchingSheets = true;
  try {
    console.log('[refreshSheetsInBackground] Starting background refresh of sheets...');
    await fetchAllSheetsFromGoogle();
  } catch (e) {
    console.warn('[refreshSheetsInBackground] Note:', e.message);
  } finally {
    isBackgroundFetchingSheets = false;
  }
}

let feReadyVerified = true;
let closedSheetVerified = true;
let tagColumnsVerified = true;

const STATUS_SHEETS = ['CLOSED'];
const PROJECT_SHEETS = [];
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
  'In-Progress': { bg: '#d1fae5', text: '#065f46' },
  'In Progress (L1)': { bg: '#d1fae5', text: '#065f46' },
  'In Progress (L2)': { bg: '#d1fae5', text: '#065f46' },
  'In Progress (L3)': { bg: '#d1fae5', text: '#065f46' },
  'Escalated to L2': { bg: '#f3e8ff', text: '#6b21a8' },
  'Escalated to L3': { bg: '#fee2e2', text: '#991b1b' },
  'Escalated to L4': { bg: '#fee2e2', text: '#991b1b' },
  'Waiting for customer': { bg: '#fef3c7', text: '#92400e' },
  'On hold': { bg: '#fef3c7', text: '#92400e' },
  'Verify': { bg: '#fef3c7', text: '#92400e' },
  'Under Review': { bg: '#fef3c7', text: '#92400e' },
  'Resolved': { bg: '#d1fae5', text: '#065f46' },
  'Invalid': { bg: '#f1f5f9', text: '#475569' },
  'Reopen': { bg: '#e0e7ff', text: '#3730a3' },
  'In Progress (L2)': { bg: '#d1fae5', text: '#065f46' },
  'Dev Done': { bg: '#d1fae5', text: '#065f46' },
  'BE Done': { bg: '#d1fae5', text: '#065f46' },
  'BE Done / FE ToDo': { bg: '#d1fae5', text: '#065f46' },
  'BE Done (Verify)': { bg: '#d1fae5', text: '#065f46' },
  'In Progress (CMS)': { bg: '#d1fae5', text: '#065f46' },
  'In Review': { bg: '#fef3c7', text: '#92400e' },
  'BE InReview': { bg: '#fef3c7', text: '#92400e' },
  'Ready for review': { bg: '#fef3c7', text: '#92400e' },
  'Review': { bg: '#fef3c7', text: '#92400e' },
  'Testing': { bg: '#fef3c7', text: '#92400e' },
  'To Pick Up': { bg: '#dbeafe', text: '#1e40af' },
  'To Do': { bg: '#dbeafe', text: '#1e40af' },
  'Submitted': { bg: '#dbeafe', text: '#1e40af' },
  'To Do (Analyzing)': { bg: '#dbeafe', text: '#1e40af' },
  'Open': { bg: '#dbeafe', text: '#1e40af' },
  'Selected for Development': { bg: '#dbeafe', text: '#1e40af' },
  'Fixed': { bg: '#d1fae5', text: '#065f46' },
  'Verified': { bg: '#d1fae5', text: '#065f46' },
  'Closed': { bg: '#d1fae5', text: '#065f46' },
  'Done': { bg: '#d1fae5', text: '#065f46' },
  'POC': { bg: '#f3e8ff', text: '#6b21a8' },
  'Escalated to L2': { bg: '#f3e8ff', text: '#6b21a8' },
  'Escalated to L3': { bg: '#fee2e2', text: '#991b1b' },
  'Discuss First': { bg: '#fee2e2', text: '#991b1b' },
  'Backlog': { bg: '#f1f5f9', text: '#475569' },
  "Won't fix": { bg: '#f1f5f9', text: '#475569' },
  'Duplicate': { bg: '#f1f5f9', text: '#475569' },
  'Incomplete': { bg: '#fee2e2', text: '#991b1b' },
  'FE Ready': { bg: '#e0e7ff', text: '#3730a3' }
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
  'Submitted',
  'To Do (Analyzing)',
  'In Progress',
  'Dev Done',
  'BE Done',
  'BE Done / FE ToDo',
  'BE Done (Verify)',
  'In Review',
  'BE InReview',
  'Ready for review',
  'Review',
  'Testing',
  'Fixed',
  'Verified',
  'POC',
  'Discuss First',
  'Backlog',
  'Closed',
  'Done',
  'FE Ready'
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

const parseJiraDueDate = parseYouTrackDueDate;

function formatToday() {
  const d = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

// MCP Session Cache: reuse session IDs across tool calls instead of re-handshaking every time
const mcpSessionCache = {}; // { [apiKey]: { sid: string, expires: number } }

async function getOrInitSession(apiKey) {
  const activeKey = (apiKey && apiKey.startsWith('ck_')) ? apiKey : (currentRequestApiKey || lastKnownActiveApiKey || COMPOSIO_KEY);
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

    let activeKey = customApiKey || currentRequestApiKey || lastKnownActiveApiKey;
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
  const activeKey = customApiKey || currentRequestApiKey || lastKnownActiveApiKey || COMPOSIO_KEY;
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
      const resData = parsed.result?.content?.[0]?.text ? JSON.parse(parsed.result.content[0].text) : parsed;
      if (parsed.result?.isError || (resData && (resData.error || resData.successful === false))) {
        console.warn(`[executeComposioTool] Warning/Error from tool ${toolSlug}:`, resData.error || (resData.data && resData.data.results && resData.data.results[0]?.response?.error) || resData);
      }
      return resData;
    }
  }
  return null;
}

async function executeComposioBatch(toolsList, customApiKey) {
  if (!toolsList || toolsList.length === 0) return null;
  const activeKey = customApiKey || currentRequestApiKey || lastKnownActiveApiKey || COMPOSIO_KEY;
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
      const resData = parsed.result?.content?.[0]?.text ? JSON.parse(parsed.result.content[0].text) : parsed;
      if (parsed.result?.isError || (resData && (resData.error || resData.successful === false))) {
        console.warn(`[executeComposioBatch] Warning/Error from batch:`, resData.error || (resData.data && resData.data.results && resData.data.results.find(r => r.response?.error)?.response?.error) || resData);
      }
      return resData;
    }
  }
  return null;
}

async function ensureFeReadySheetExists(customApiKey) {
  if (feReadyVerified) return true;
  if (cache?.sheetNames && cache.sheetNames.some(s => s.toUpperCase() === 'FE READY')) {
    feReadyVerified = true;
    return true;
  }
  const activeKey = customApiKey || currentRequestApiKey || lastKnownActiveApiKey || COMPOSIO_KEY;
  console.log('[ensureFeReadySheetExists] Verifying if FE Ready sheet exists in Google Sheets...');

  try {
    const testRes = await executeComposioTool('GOOGLESHEETS_VALUES_GET', {
      spreadsheet_id: SPREADSHEET_ID,
      spreadsheetId: SPREADSHEET_ID,
      range: 'FE Ready!A1:H1'
    }, activeKey);

    if (testRes?.data?.values && testRes.data.values.length > 0) {
      console.log('[ensureFeReadySheetExists] FE Ready sheet already exists with headers.');
      return true;
    }
  } catch (err) {
    console.log('[ensureFeReadySheetExists] Check returned:', err.message);
  }

  // If not found or empty, create the worksheet using GOOGLESHEETS_ADD_SHEET
  try {
    console.log('[ensureFeReadySheetExists] Creating FE Ready worksheet in Google Sheets via GOOGLESHEETS_ADD_SHEET...');
    const addRes = await executeComposioTool('GOOGLESHEETS_ADD_SHEET', {
      spreadsheet_id: SPREADSHEET_ID,
      spreadsheetId: SPREADSHEET_ID,
      title: 'FE Ready',
      forceUnique: false
    }, activeKey);
    console.log('[ensureFeReadySheetExists] addRes result:', JSON.stringify(addRes));
  } catch (cErr) {
    console.warn('[ensureFeReadySheetExists] GOOGLESHEETS_ADD_SHEET warning:', cErr.message);
  }

  // Populate Header row in FE Ready
  try {
    console.log('[ensureFeReadySheetExists] Writing standard header row to FE Ready!A1:H1...');
    const headerRes = await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
      spreadsheet_id: SPREADSHEET_ID,
      spreadsheetId: SPREADSHEET_ID,
      valueInputOption: 'USER_ENTERED',
      data: [{
        range: 'FE Ready!A1:I1',
        majorDimension: 'ROWS',
        values: [['#', 'Ticket ID', 'Ticket Link', 'Title', 'YouTrack Status', 'Internal Status', 'Action / Notes', 'Due Date', 'Tag']]
      }]
    }, activeKey);
    console.log('[ensureFeReadySheetExists] headerRes result:', JSON.stringify(headerRes));
  } catch (hErr) {
    console.warn('[ensureFeReadySheetExists] Header row write warning:', hErr.message);
  }

  // Format header row (indigo theme background, white bold text, centered)
  try {
    await executeComposioBatch([
      {
        tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
        arguments: {
          spreadsheet_id: SPREADSHEET_ID,
          spreadsheetId: SPREADSHEET_ID,
          sheet_name: 'FE Ready',
          range: 'A1:I1',
          background_color: '#3730a3',
          text_color: '#ffffff',
          bold: true,
          horizontal_alignment: 'CENTER'
        }
      }
    ], activeKey);
  } catch (fErr) {
    console.warn('[ensureFeReadySheetExists] Header format note:', fErr.message);
  }

  return true;
}

async function ensureClosedSheetExists(customApiKey) {
  if (closedSheetVerified) return true;
  if (cache?.sheetNames && cache.sheetNames.some(s => s.toUpperCase() === 'CLOSED')) {
    closedSheetVerified = true;
    return true;
  }
  const activeKey = customApiKey || currentRequestApiKey || lastKnownActiveApiKey || COMPOSIO_KEY;
  try {
    const testRes = await executeComposioTool('GOOGLESHEETS_VALUES_GET', {
      spreadsheet_id: SPREADSHEET_ID,
      spreadsheetId: SPREADSHEET_ID,
      range: 'CLOSED!A1:I1'
    }, activeKey);

    if (testRes?.data?.values && testRes.data.values.length > 0) {
      return true;
    }
  } catch (err) {
    // continue
  }

  try {
    await executeComposioTool('GOOGLESHEETS_ADD_SHEET', {
      spreadsheet_id: SPREADSHEET_ID,
      spreadsheetId: SPREADSHEET_ID,
      title: 'CLOSED',
      forceUnique: false
    }, activeKey);
  } catch (cErr) {
    // sheet may already exist
  }

  try {
    await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
      spreadsheet_id: SPREADSHEET_ID,
      spreadsheetId: SPREADSHEET_ID,
      valueInputOption: 'USER_ENTERED',
      data: [{
        range: 'CLOSED!A1:I1',
        majorDimension: 'ROWS',
        values: [['#', 'Ticket ID', 'Ticket Link', 'Title', 'YouTrack Status', 'Internal Status', 'Action / Notes', 'Due Date', 'Tag']]
      }]
    }, activeKey);

    await executeComposioBatch([
      {
        tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
        arguments: {
          spreadsheet_id: SPREADSHEET_ID,
          spreadsheetId: SPREADSHEET_ID,
          sheet_name: 'CLOSED',
          range: 'A1:I1',
          background_color: '#065f46',
          text_color: '#ffffff',
          bold: true,
          horizontal_alignment: 'CENTER'
        }
      }
    ], activeKey);
  } catch (hErr) {
    console.warn('[ensureClosedSheetExists] Warning writing header:', hErr.message);
  }

  return true;
}


async function ensureTagColumnAcrossSheets(customApiKey) {
  if (tagColumnsVerified) return true;
  tagColumnsVerified = true;
  const activeKey = customApiKey || currentRequestApiKey || lastKnownActiveApiKey || COMPOSIO_KEY;
  console.log('[ensureTagColumnAcrossSheets] Ensuring Tag column and dropdown validation in Master & Individual sheets...');

  const masterTabs = ['ARUSH', 'MANISH', 'KRISHNA', 'CHETNA', 'SONU', 'RAHUL', 'UPCOMING', 'CLOSED', 'FE Ready', 'PLAN'];
  
  // 1. Ensure header I1 is 'Tag' and formatted across Master tabs
  for (const tab of masterTabs) {
    try {
      await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
        spreadsheet_id: SPREADSHEET_ID,
        spreadsheetId: SPREADSHEET_ID,
        valueInputOption: 'USER_ENTERED',
        data: [{
          range: `${tab}!I1`,
          majorDimension: 'ROWS',
          values: [['Tag']]
        }]
      }, activeKey);

      await executeComposioTool('GOOGLESHEETS_FORMAT_CELL', {
        spreadsheet_id: SPREADSHEET_ID,
        spreadsheetId: SPREADSHEET_ID,
        sheet_name: tab,
        range: 'I1',
        background_color: '#3730a3',
        text_color: '#ffffff',
        bold: true,
        horizontal_alignment: 'CENTER'
      }, activeKey);
    } catch (e) {
      console.warn(`[ensureTagColumnAcrossSheets] Note on master tab ${tab}:`, e.message);
    }
  }

  // 2. Data validation dropdown on Column I across individual sheets & master
  try {
    const valTools = [];
    for (const [name, sheetId] of Object.entries(INDIVIDUAL_SHEETS)) {
      valTools.push({
        tool_slug: 'GOOGLESHEETS_SET_DATA_VALIDATION_RULE',
        arguments: {
          spreadsheet_id: sheetId,
          sheet_id: 0,
          mode: 'SET',
          start_row_index: 1,
          end_row_index: 100,
          start_column_index: 8,
          end_column_index: 9,
          validation_type: 'ONE_OF_LIST',
          values: ['Product', 'Support'],
          strict: false,
          show_custom_ui: true
        }
      });
      try {
        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: sheetId,
          spreadsheetId: sheetId,
          valueInputOption: 'USER_ENTERED',
          data: [{
            range: 'Sheet1!I1',
            majorDimension: 'ROWS',
            values: [['Tag']]
          }]
        }, activeKey);
      } catch (err) {}
    }
    if (valTools.length > 0) {
      await executeComposioBatch(valTools, activeKey);
      console.log('✅ [ensureTagColumnAcrossSheets] Data validation dropdown (Product | Support) configured for all sheets');
    }
  } catch (err) {
    console.warn('[ensureTagColumnAcrossSheets] Data validation note:', err.message);
  }

  return true;
}

function colIndexToLetter(colIdx) {
  let temp = colIdx + 1;
  let letter = '';
  while (temp > 0) {
    let mod = (temp - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    temp = Math.floor((temp - mod) / 26);
  }
  return letter;
}

function resolveActualTabName(inputName) {
  if (!inputName) return '';
  const trimmed = String(inputName).trim();
  const known = ['ARUSH', 'MANISH', 'KRISHNA', 'CHETNA', 'SONU', 'RAHUL', 'UPCOMING', 'CLOSED', 'FE Ready', 'PLAN'];
  const allSheets = (cache && cache.sheetNames) ? cache.sheetNames : known;
  const found = allSheets.find(s => s.toUpperCase() === trimmed.toUpperCase());
  return found || trimmed.toUpperCase();
}

// Dynamically discover all worksheets/tabs from the Google Spreadsheet
async function discoverSheetNames(customApiKey) {
  try {
    const activeKey = customApiKey || currentRequestApiKey || lastKnownActiveApiKey || COMPOSIO_KEY;
    const res = await executeComposioTool('GOOGLESHEETS_GET_SHEET_NAMES', {
      spreadsheet_id: SPREADSHEET_ID
    }, activeKey);
    const names = res?.data?.results?.[0]?.response?.data?.sheet_names || res?.data?.sheet_names;
    if (Array.isArray(names) && names.length > 0) {
      return names;
    }
  } catch (e) {
    console.warn('[discoverSheetNames] Note querying sheet names:', e.message);
  }
  return null;
}

// Fetch all sheets from Google Sheets (Consolidated in 1 single batch request with dynamic columns A:ZZ and rows up to 500)
async function fetchAllSheetsFromGoogle(passedApiKey) {
  const baseTabs = [
    'ARUSH', 'MANISH', 'KRISHNA', 'CHETNA', 'SONU', 'RAHUL', 'UPCOMING', 'CLOSED', 'FE Ready', 'PLAN'
  ];

  const activeKey = passedApiKey || currentRequestApiKey || lastKnownActiveApiKey || COMPOSIO_KEY;

  let sheetNames = [...baseTabs];
  try {
    if (activeKey) {
      const discovered = await discoverSheetNames(activeKey);
      if (discovered && discovered.length > 0) {
        const validDiscovered = discovered.map(d => String(d).trim());
        sheetNames = baseTabs.filter(b => validDiscovered.some(v => v.toUpperCase() === b.toUpperCase()));
        validDiscovered.forEach(d => {
          if (!sheetNames.some(s => s.toUpperCase() === d.toUpperCase())) {
            sheetNames.push(d);
          }
        });
      }
    }
  } catch (dErr) {
    console.warn('[fetchAllSheetsFromGoogle] Note discovering sheet names:', dErr.message);
  }

  // Chunk sheets into batches of 3 to avoid Composio payload truncation and timeout
  const chunkSize = 3;
  const chunks = [];
  for (let i = 0; i < sheetNames.length; i += chunkSize) {
    chunks.push(sheetNames.slice(i, i + chunkSize));
  }

  const sheetData = {};

  for (const chunk of chunks) {
    const tools = chunk.map(tab => ({
      tool_slug: 'GOOGLESHEETS_VALUES_GET',
      arguments: {
        spreadsheet_id: SPREADSHEET_ID,
        range: `${tab}!A1:Z200`
      }
    }));

    try {
      const batchResult = await executeComposioBatch(tools, activeKey);
      if (batchResult?.data?.results) {
        batchResult.data.results.forEach((r, idx) => {
          const tab = chunk[idx];
          if (!r.response?.error && !r.response?.data?.error) {
            const vals = r.response?.data?.values || r.response?.data_preview?.values;
            if (vals && vals.length > 0) {
              sheetData[tab] = vals;
            }
          }
        });
      }
    } catch (chunkErr) {
      console.warn(`[fetchAllSheetsFromGoogle] Error fetching chunk [${chunk.join(', ')}]:`, chunkErr.message);
    }
  }

  // Merge with existing cache if any tabs failed or returned empty
  if (cache && cache.data) {
    for (const tab of sheetNames) {
      if ((!sheetData[tab] || sheetData[tab].length === 0) && cache.data[tab] && cache.data[tab].length > 0) {
        sheetData[tab] = cache.data[tab];
      }
    }
  }

  // Calculate total tickets after merge
  let totalTicketsAfterMerge = 0;
  for (const rows of Object.values(sheetData)) {
    if (Array.isArray(rows) && rows.length > 1) {
      totalTicketsAfterMerge += (rows.length - 1);
    }
  }

  // CRITICAL GUARD: Never wipe cache if 0 tickets were fetched from Google Sheets!
  if (totalTicketsAfterMerge > 0) {
    cache = {
      data: sheetData,
      sheetNames: sheetNames.filter(tab => sheetData[tab] !== undefined),
      timestamp: Date.now()
    };
    saveDiskCache(cache);
    console.log(`[fetchAllSheetsFromGoogle] Cache updated with ${totalTicketsAfterMerge} tickets across ${Object.keys(sheetData).length} sheets.`);
  } else if (cache && cache.data && Object.keys(cache.data).length > 0) {
    console.warn('[fetchAllSheetsFromGoogle] Live fetch yielded 0 tickets; preserving existing cache to prevent data loss.');
    return { sheetNames: cache.sheetNames, sheetData: cache.data };
  }

  return { sheetNames: cache.sheetNames || sheetNames, sheetData: cache.data || sheetData };
}

async function updateDataValidationAcrossSheets() {
  const tools = [];
  const statusList = Array.from(KNOWN_STATUSES);
  for (const [name, sheetId] of Object.entries(INDIVIDUAL_SHEETS)) {
    // Internal status validation (Col F: index 5)
    tools.push({
      tool_slug: 'GOOGLESHEETS_SET_DATA_VALIDATION_RULE',
      arguments: {
        spreadsheet_id: sheetId,
        sheet_id: 0,
        mode: 'SET',
        start_row_index: 1,
        end_row_index: 100,
        start_column_index: 5,
        end_column_index: 6,
        validation_type: 'ONE_OF_LIST',
        values: statusList,
        strict: false,
        show_custom_ui: true
      }
    });
    // Tag validation (Col I: index 8)
    tools.push({
      tool_slug: 'GOOGLESHEETS_SET_DATA_VALIDATION_RULE',
      arguments: {
        spreadsheet_id: sheetId,
        sheet_id: 0,
        mode: 'SET',
        start_row_index: 1,
        end_row_index: 100,
        start_column_index: 8,
        end_column_index: 9,
        validation_type: 'ONE_OF_LIST',
        values: ['Product', 'Support'],
        strict: false,
        show_custom_ui: true
      }
    });
  }
  if (tools.length > 0) {
    await executeComposioBatch(tools);
    console.log('✅ [Data Validation Updated] Dynamic status and tag dropdown rules updated across all individual sheets');
  }
}

async function pushMasterToIndividualSheet(memberName, masterRows) {
  if (!memberName) return;
  const memberKey = memberName.trim().toUpperCase();
  const sheetId = INDIVIDUAL_SHEETS[memberKey];
  if (!sheetId) return;

  try {
    const rowsToWrite = masterRows.map(r => {
      const copy = [...r];
      while (copy.length < 9) copy.push('');
      return copy;
    });
    while (rowsToWrite.length < 30) {
      rowsToWrite.push(['', '', '', '', '', '', '', '', '']);
    }
    await executeComposioTool('GOOGLESHEETS_VALUES_UPDATE', {
      spreadsheet_id: sheetId,
      range: `Sheet1!A1:I${rowsToWrite.length}`,
      value_input_option: 'USER_ENTERED',
      values: rowsToWrite
    });
    console.log(`📤 [1-Way Push] Synced ${masterRows.length} rows to ${memberKey}'s individual sheet`);
  } catch (err) {
    console.error(`Error pushing to ${memberKey} individual sheet:`, err.message);
  }
}

async function syncPulseSheet() {
  // Decommissioned: PULSE sheet deleted by user
  return;
}

let isSyncingIndividual = false;
async function syncIndividualSheetsWithMaster() {
  if (isSyncingIndividual) return;
  isSyncingIndividual = true;

  try {
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-composio-key, x-user-name, x-user-role, x-youtrack-token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Dynamic user-provided Composio key from request headers (plain ck_ key or sealed_v1: token)
  const incomingKey = req.headers['x-composio-key'];
  const resolvedKey = resolveApiKey(incomingKey);
  currentRequestApiKey = resolvedKey || null;
  if (resolvedKey && resolvedKey.startsWith('ck_')) {
    lastKnownActiveApiKey = resolvedKey;
    saveComposioConfig(resolvedKey);
  }
  const incomingUser = req.headers['x-user-name'];
  currentRequestUser = incomingUser ? incomingUser.trim().toLowerCase() : 'workspace';

  // Dynamic user-provided YouTrack token from request headers
  const incomingYtToken = req.headers['x-youtrack-token'];
  currentRequestYouTrackToken = incomingYtToken ? incomingYtToken.trim() : null;

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Serve static HTML dashboard
  if (urlObj.pathname === '/' || urlObj.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }
  }

  // GET /api/youtrack/status -> Get current live YouTrack token status
  if (urlObj.pathname === '/api/youtrack/status' && req.method === 'GET') {
    try {
      const cfg = loadYouTrackConfig();
      const token = currentRequestYouTrackToken || activeYouTrackToken || cfg.token;
      const verifyRes = await verifyYouTrackToken(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        active: verifyRes.valid,
        baseUrl: verifyRes.baseUrl || cfg.baseUrl || YOUTRACK_BASE_URL,
        hasToken: !!token,
        token: verifyRes.valid ? token : null,
        maskedToken: token ? `${token.slice(0, 4)}••••${token.slice(-4)}` : null,
        user: verifyRes.user || null,
        error: verifyRes.error || null
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/youtrack/save-token -> Validate and save YouTrack token
  if (urlObj.pathname === '/api/youtrack/save-token' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const token = (payload.token || '').trim();
        const baseUrl = ((payload.baseUrl || '').trim() || YOUTRACK_BASE_URL).replace(/\/+$/, '');
        const force = !!payload.force;

        if (!token) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'YouTrack Access Token is required.' }));
          return;
        }

        const verifyRes = await verifyYouTrackToken(token, baseUrl);
        if (!verifyRes.valid && !force) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: verifyRes.error, allowForce: true }));
          return;
        }

        const cfg = loadYouTrackConfig();
        cfg.token = token;
        cfg.baseUrl = baseUrl;
        cfg.lastUpdated = new Date().toISOString();
        saveYouTrackConfig(cfg);
        activeYouTrackToken = token;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: verifyRes.valid ? 'YouTrack Access Token verified and saved!' : 'Token saved (unverified).',
          active: verifyRes.valid,
          baseUrl,
          user: verifyRes.user || null
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/youtrack/verify-token -> Test a token without saving
  if (urlObj.pathname === '/api/youtrack/verify-token' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const token = (payload.token || currentRequestYouTrackToken || activeYouTrackToken || '').trim();
        const baseUrl = ((payload.baseUrl || '').trim() || YOUTRACK_BASE_URL).replace(/\/+$/, '');
        const verifyRes = await verifyYouTrackToken(token, baseUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: verifyRes.valid,
          ...verifyRes
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/auth/login -> Authenticate with hardcoded credentials and return user role
  if (urlObj.pathname === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
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

        // Strict YouTrack Bearer Token check on login
        const incomingYtToken = (payload.youTrackToken || '').trim();
        const effectiveYtToken = incomingYtToken || currentRequestYouTrackToken || activeYouTrackToken;
        const ytCheck = await verifyYouTrackToken(effectiveYtToken);

        if (!ytCheck.valid) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'YouTrack Bearer Token is required to sign in. Please provide a valid YouTrack token.',
            youTrackRequired: true
          }));
          return;
        }

        if (incomingYtToken && ytCheck.valid) {
          saveYouTrackConfig({ youtrack_token: incomingYtToken });
        }

        const { password: _, ...safeUser } = user;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          user: safeUser,
          youtrack: {
            active: true,
            user: ytCheck.user || null,
            baseUrl: ytCheck.baseUrl || YOUTRACK_BASE_URL
          }
        }));
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

        // Check if required toolkits (googlesheets, jira) are connected, and check YouTrack status
        // Check if required toolkits (googlesheets) are connected, and check YouTrack status
        let connections = { googlesheets: { active: false }, youtrack: { active: false }, allActive: false };
        try {
          const resConn = await manageComposioConnections(actualKey, [
            { name: 'googlesheets', action: 'list' }
          ]);
          const results = resConn?.data?.results || {};
          const sheetsActive = results.googlesheets?.status === 'active' || 
            (Array.isArray(results.googlesheets?.accounts) && results.googlesheets.accounts.some(a => a.status === 'active'));

          const ytCheck = await verifyYouTrackToken(currentRequestYouTrackToken);

          connections = {
            googlesheets: {
              active: !!sheetsActive,
              status: sheetsActive ? 'active' : (results.googlesheets?.status || 'not_connected'),
              accountEmail: results.googlesheets?.accounts?.find(a => a.status === 'active')?.user_info?.email || null
            },
            youtrack: {
              active: !!ytCheck.valid,
              status: ytCheck.valid ? 'active' : 'token_needed',
              baseUrl: ytCheck.baseUrl || YOUTRACK_BASE_URL,
              user: ytCheck.user || null,
              error: ytCheck.error || null
            },
            allActive: !!(sheetsActive && ytCheck.valid)
          };
        } catch (connErr) {
          console.warn('Connection check error during verify:', connErr.message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'API Key connected and verified successfully!',
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

  // POST /api/composio/check-connections -> Check live connection statuses for Google Sheets & YouTrack
  if (urlObj.pathname === '/api/composio/check-connections' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const apiKey = resolveApiKey(payload.apiKey || req.headers['x-composio-key']) || currentRequestApiKey || COMPOSIO_KEY;
        if (apiKey && apiKey.startsWith('ck_')) {
          lastKnownActiveApiKey = apiKey;
          saveComposioConfig(apiKey);
        }
        const ytCheck = await verifyYouTrackToken(payload.youTrackToken || currentRequestYouTrackToken);
        const resolvedYtToken = ytCheck.valid ? (payload.youTrackToken || currentRequestYouTrackToken || activeYouTrackToken || loadYouTrackConfig().token) : null;

        if (!apiKey) {
          const emptyStatus = { active: false, status: 'not_connected', connectedAccount: null };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            googlesheets: emptyStatus,
            youtrack: {
              active: !!ytCheck.valid,
              status: ytCheck.valid ? 'active' : 'token_needed',
              baseUrl: ytCheck.baseUrl || YOUTRACK_BASE_URL,
              token: resolvedYtToken,
              user: ytCheck.user || null,
              error: ytCheck.error || null
            },
            allActive: false
          }));
          return;
        }

        const resConn = await manageComposioConnections(apiKey, [
          { name: 'googlesheets', action: 'list' }
        ]);

        const results = resConn?.data?.results || {};
        const sheetsActive = results.googlesheets?.status === 'active' || 
          (Array.isArray(results.googlesheets?.accounts) && results.googlesheets.accounts.some(a => a.status === 'active'));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          googlesheets: {
            active: !!sheetsActive,
            status: sheetsActive ? 'active' : (results.googlesheets?.status || 'not_connected'),
            connectedAccount: { email: results.googlesheets?.accounts?.find(a => a.status === 'active')?.user_info?.email || null }
          },
          youtrack: {
            active: !!ytCheck.valid,
            status: ytCheck.valid ? 'active' : 'token_needed',
            baseUrl: ytCheck.baseUrl || YOUTRACK_BASE_URL,
            token: resolvedYtToken,
            user: ytCheck.user || null,
            error: ytCheck.error || null
          },
          allActive: !!(sheetsActive && ytCheck.valid)
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
        const apiKey = resolveApiKey(payload.apiKey || req.headers['x-composio-key']) || currentRequestApiKey || COMPOSIO_KEY;

        if (toolkit !== 'googlesheets') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid toolkit: only googlesheets is supported' }));
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

  // GET /api/debug/composio-tools -> List all tools available in active Composio session
  if (urlObj.pathname === '/api/debug/composio-tools' && req.method === 'GET') {
    try {
      const activeKey = resolveApiKey(req.headers['x-composio-key']) || currentRequestApiKey || lastKnownActiveApiKey || COMPOSIO_KEY;
      const sid = await getOrInitSession(activeKey);
      const listRes = await sendComposioMcp('tools/list', {}, sid, activeKey);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sid, activeKey: activeKey ? activeKey.slice(0, 8) + '...' : null, response: listRes.body }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST or GET /api/sheet/create-fe-ready -> Explicitly ensure FE Ready worksheet exists in Google Sheets
  if (urlObj.pathname === '/api/sheet/create-fe-ready' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      const apiKey = resolveApiKey(req.headers['x-composio-key']) || currentRequestApiKey || lastKnownActiveApiKey || COMPOSIO_KEY;
      console.log('🚀 Triggering manual ensureFeReadySheetExists with key:', apiKey ? apiKey.slice(0, 8) + '...' : 'none');
      await ensureFeReadySheetExists(apiKey);
      cache.timestamp = 0; // Invalidate cache so next fetch gets fresh sheets
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'FE Ready worksheet creation/verification completed in Google Sheets!' }));
    } catch (e) {
      console.error('Error in create-fe-ready endpoint:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // POST or GET /api/sheet/ensure-tags -> Ensure Tag column and validation in all sheets
  if (urlObj.pathname === '/api/sheet/ensure-tags' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      const apiKey = resolveApiKey(req.headers['x-composio-key']) || currentRequestApiKey || lastKnownActiveApiKey || COMPOSIO_KEY;
      console.log('🏷️ Triggering manual ensureTagColumnAcrossSheets with key:', apiKey ? apiKey.slice(0, 8) + '...' : 'none');
      await ensureTagColumnAcrossSheets(apiKey);
      cache.timestamp = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Tag column and dropdown validation successfully ensured across all sheets!' }));
    } catch (e) {
      console.error('Error in ensure-tags endpoint:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // POST /api/sheet/update-cell -> Update any arbitrary cell in any sheet dynamically & sync to Google Sheets
  if (urlObj.pathname === '/api/sheet/update-cell' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { sheet, row, col, value } = JSON.parse(body || '{}');
        if (!sheet || row === undefined || col === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sheet, row, and col are required' }));
          return;
        }

        const tabName = String(sheet).trim().toUpperCase();
        const rowNum = parseInt(row, 10);
        const colIdx = parseInt(col, 10);
        const cellVal = (value !== undefined && value !== null) ? String(value) : '';

        // RBAC check: ADMIN can edit any sheet;
        // PLAN is a shared team collaboration sheet, accessible to all users;
        // For individual member sheets, users can edit their own sheet
        const clientRole = (req.headers['x-user-role'] || '').toUpperCase();
        const clientUser = (req.headers['x-user-name'] || '').toLowerCase();
        const userConfig = USER_ACCOUNTS[clientUser];
        const isSharedTab = ['PLAN'].includes(tabName);
        if (!isSharedTab && clientRole === 'MEMBER' && userConfig && !userConfig.allowedSheets.includes('ALL')) {
          const isAllowed = userConfig.allowedSheets.some(s => s.toUpperCase() === tabName);
          if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Permission denied: As a team member, you can only edit tasks on your assigned sheet (${userConfig.allowedSheets.join(', ')}).` }));
            return;
          }
        }

        const colLetter = colIndexToLetter(colIdx);
        const cellRange = `${tabName}!${colLetter}${rowNum}`;

        console.log(`[Update Cell] Tab: ${tabName}, Cell: ${cellRange}, Value: "${cellVal}"`);

        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: [{
            range: cellRange,
            majorDimension: 'ROWS',
            values: [[cellVal]]
          }]
        });

        // If updating Internal Status (Col F / idx 5) on non-PLAN sheets, also format cell color
        if (tabName !== 'PLAN' && colIdx === 5 && STATUS_COLORS[cellVal]) {
          const colorConfig = STATUS_COLORS[cellVal];
          await executeComposioTool('GOOGLESHEETS_FORMAT_CELL', {
            spreadsheet_id: SPREADSHEET_ID,
            sheet_name: tabName,
            range: `${colLetter}${rowNum}`,
            background_color: colorConfig.bg,
            text_color: colorConfig.text,
            bold: true,
            horizontal_alignment: 'CENTER'
          }).catch(() => {});
          registerCustomStatus(cellVal);
        }

        // If updating Tag (Col I / idx 8), format tag color
        if (colIdx === 8) {
          const tagCol = (cellVal.toLowerCase() === 'support') ? { bg: '#fef3c7', text: '#92400e' } : { bg: '#e0e7ff', text: '#3730a3' };
          await executeComposioTool('GOOGLESHEETS_FORMAT_CELL', {
            spreadsheet_id: SPREADSHEET_ID,
            sheet_name: tabName,
            range: `${colLetter}${rowNum}`,
            background_color: tagCol.bg,
            text_color: tagCol.text,
            bold: true,
            horizontal_alignment: 'CENTER'
          }).catch(() => {});
        }

        // Update in-memory cache
        if (cache.data && cache.data[tabName]) {
          const rIdx = rowNum - 1;
          if (cache.data[tabName][rIdx]) {
            while (cache.data[tabName][rIdx].length <= colIdx) {
              cache.data[tabName][rIdx].push('');
            }
            cache.data[tabName][rIdx][colIdx] = cellVal;
          }
          if (INDIVIDUAL_SHEETS[tabName]) {
            pushMasterToIndividualSheet(tabName, cache.data[tabName]).catch(() => {});
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          sheet: tabName,
          row: rowNum,
          col: colIdx,
          colLetter,
          range: cellRange,
          value: cellVal,
          message: `Cell ${colLetter}${rowNum} in ${tabName} updated successfully!`
        }));
      } catch (err) {
        console.error('Error updating cell:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/sheet/add-column -> Dynamically add a new column header to Google Sheets
  if (urlObj.pathname === '/api/sheet/add-column' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { sheet, columnName } = JSON.parse(body || '{}');
        if (!sheet || !columnName || !columnName.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sheet and columnName are required' }));
          return;
        }

        const tabName = String(sheet).trim().toUpperCase();
        const newColName = columnName.trim();

        // 1. Fetch current row 1 to see existing headers
        const curRes = await executeComposioTool('GOOGLESHEETS_VALUES_GET', {
          spreadsheet_id: SPREADSHEET_ID,
          range: `${tabName}!1:1`
        });
        const headerRow = curRes?.data?.results?.[0]?.response?.data?.values?.[0] || [];
        
        // Find next column index
        const nextColIdx = headerRow.length > 0 ? headerRow.length : 9;
        const colLetter = colIndexToLetter(nextColIdx);
        const cellRange = `${tabName}!${colLetter}1`;

        console.log(`[Add Column] Tab: ${tabName}, Column "${newColName}" at ${cellRange}`);

        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: [{
            range: cellRange,
            majorDimension: 'ROWS',
            values: [[newColName]]
          }]
        });

        // Format header cell with clean styling
        try {
          await executeComposioTool('GOOGLESHEETS_FORMAT_CELL', {
            spreadsheet_id: SPREADSHEET_ID,
            sheet_name: tabName,
            range: `${colLetter}1`,
            background_color: '#3730a3',
            text_color: '#ffffff',
            bold: true,
            horizontal_alignment: 'CENTER'
          });
        } catch (fErr) {
          console.warn('[add-column] Format header note:', fErr.message);
        }

        // Invalidate cache immediately so next pull gets new column
        cache.timestamp = 0;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          sheet: tabName,
          columnName: newColName,
          colIndex: nextColIdx,
          colLetter,
          range: cellRange,
          message: `Column "${newColName}" added successfully at ${colLetter}1 in ${tabName}!`
        }));
      } catch (err) {
        console.error('Error adding column:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // GET /api/sheets -> Dynamically fetch all sheet names and rows with RBAC enforcement
  if (urlObj.pathname === '/api/sheets' && req.method === 'GET') {
    try {
      const forceRefresh = urlObj.searchParams.get('force') === 'true';
      const clientRole = (req.headers['x-user-role'] || '').toUpperCase();
      const clientUser = (req.headers['x-user-name'] || '').toLowerCase();
      const userConfig = USER_ACCOUNTS[clientUser];

      let hasCachedData = false;
      if (cache.data && Object.keys(cache.data).length > 0) {
        for (const rows of Object.values(cache.data)) {
          if (Array.isArray(rows) && rows.length > 1) {
            hasCachedData = true;
            break;
          }
        }
      }

      let sheetNames = cache.sheetNames;
      let sheetData = cache.data;
      let wasCached = true;

      // Check if memory/disk cache is fresh (< CACHE_TTL_MS, 3 minutes)
      const isCacheFresh = hasCachedData && !forceRefresh && (Date.now() - cache.timestamp < CACHE_TTL_MS);

      if (isCacheFresh) {
        // FAST PATH: Serve warm cache in < 15ms
        wasCached = true;
      } else {
        // Cache expired (> 3 mins or after 10 days) or cold start or force refresh:
        // MUST fetch 100% LIVE data from Google Sheets!
        try {
          const apiKey = resolveApiKey(req.headers['x-composio-key']);
          if (apiKey && !feReadyVerified) {
            ensureFeReadySheetExists(apiKey).catch(err => console.warn('[ensureFeReadySheetExists] background note:', err.message));
          }
          if (apiKey && !tagColumnsVerified) {
            ensureTagColumnAcrossSheets(apiKey).catch(err => console.warn('[ensureTagColumnAcrossSheets] background note:', err.message));
          }
          const fetched = await fetchAllSheetsFromGoogle();
          sheetNames = fetched.sheetNames;
          sheetData = fetched.sheetData;
          wasCached = false;
        } catch (fetchErr) {
          // If live fetch throws (network/API rate limit), fallback to cached data so user is never blocked
          if (hasCachedData) {
            console.warn('[api/sheets] Live Google Sheets fetch failed, serving cached fallback:', fetchErr.message);
            sheetNames = cache.sheetNames;
            sheetData = cache.data;
            wasCached = true;
          } else {
            throw fetchErr;
          }
        }
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

  // POST /api/youtrack/fetch-ticket -> Fetch ticket details from YouTrack
  if (urlObj.pathname === '/api/youtrack/fetch-ticket' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        if (!body) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Empty request body' }));
          return;
        }
        const { ticket, token: bodyToken } = JSON.parse(body);
        if (!ticket) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Ticket key is required' }));
          return;
        }

        const ticketKey = ticket.trim().toUpperCase();
        console.log(`[YouTrack Lookup] Querying ${ticketKey}...`);

        const ytToken = bodyToken || currentRequestYouTrackToken || activeYouTrackToken;
        const ytData = await fetchYouTrackIssue(ticketKey, ytToken);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          source: 'youtrack',
          ticket: ytData.ticket,
          title: ytData.title,
          trackerStatus: ytData.youTrackStatus,
          youTrackStatus: ytData.youTrackStatus,
          jiraStatus: ytData.youTrackStatus,
          internalStatus: ytData.youTrackStatus,
          status: ytData.youTrackStatus,
          dueDate: ytData.dueDate,
          url: ytData.url,
          assignee: ''
        }));
      } catch (err) {
        console.error('YouTrack fetch error:', err.message);
        const statusCode = err.status || (err.isAuthError ? 401 : 500);
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: err.message,
          isAuthError: !!err.isAuthError
        }));
      }
    });
    return;
  }

  // POST /api/jira/fetch-ticket -> Disabled (Jira removed, using YouTrack)
  if (urlObj.pathname === '/api/jira/fetch-ticket') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Jira integration has been removed. Please use YouTrack.' }));
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
        const isPlan = tabName === 'PLAN';
        const targetColLetter = isPlan ? 'G' : 'F';
        const targetColIdx = isPlan ? 6 : 5;

        // RBAC Check: Team members can only update their own assigned tasks or shared sheets (PLAN, PULSE)
        const clientRole = (req.headers['x-user-role'] || '').toUpperCase();
        const clientUser = (req.headers['x-user-name'] || '').toLowerCase();
        const userConfig = USER_ACCOUNTS[clientUser];
        const isSharedTab = ['PLAN', 'PULSE'].includes(tabName);
        if (!isSharedTab && clientRole === 'MEMBER' && userConfig && !userConfig.allowedSheets.includes('ALL')) {
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
            range: `${tabName}!A1:I50`
          });
          const rows = currentRes?.data?.results?.[0]?.response?.data?.values || [];
          const foundIdx = rows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticket.trim().toUpperCase());
          if (foundIdx > 0) {
            targetRow = foundIdx + 1;
          } else {
            targetRow = 2;
          }
        }

        console.log(`[Update Internal Status] Tab: ${tabName}, Row: ${targetRow} (${targetColLetter}), Status: ${internalStatus}`);

        // 1. Update Column G (Internal Status in PLAN) or Column F (standard sheets) in Google Sheets
        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: [{
            range: `${tabName}!${targetColLetter}${targetRow}`,
            majorDimension: 'ROWS',
            values: [[internalStatus]]
          }]
        });

        // 2. Format cell
        const colorConfig = STATUS_COLORS[internalStatus] || STATUS_COLORS['To Pick Up'];
        await executeComposioTool('GOOGLESHEETS_FORMAT_CELL', {
          spreadsheet_id: SPREADSHEET_ID,
          sheet_name: tabName,
          range: `${targetColLetter}${targetRow}`,
          background_color: colorConfig.bg,
          text_color: colorConfig.text,
          bold: true,
          horizontal_alignment: 'CENTER'
        }).catch(() => {});

        // Register custom status if new
        registerCustomStatus(internalStatus);

        // 3. Update memory cache if present
        if (cache.data && cache.data[tabName]) {
          const rIdx = targetRow - 1;
          if (cache.data[tabName][rIdx]) {
            cache.data[tabName][rIdx][targetColIdx] = internalStatus;
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

  // POST /api/ticket/update-tag -> Update Column I (Tag: Product | Support) in Google Sheets
  if (urlObj.pathname === '/api/ticket/update-tag' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { assignee, ticket, tag, rowNumber } = JSON.parse(body || '{}');
        if (!assignee || !tag) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'assignee and tag are required' }));
          return;
        }

        const tabName = assignee.trim().toUpperCase();
        const validTag = (tag.trim().toLowerCase() === 'support') ? 'Support' : 'Product';

        // RBAC Check: Team members can only update their own assigned tasks or shared sheets (PLAN, PULSE)
        const clientRole = (req.headers['x-user-role'] || '').toUpperCase();
        const clientUser = (req.headers['x-user-name'] || '').toLowerCase();
        const userConfig = USER_ACCOUNTS[clientUser];
        const isSharedTab = ['PLAN', 'PULSE'].includes(tabName);
        if (!isSharedTab && clientRole === 'MEMBER' && userConfig && !userConfig.allowedSheets.includes('ALL')) {
          const isAllowed = userConfig.allowedSheets.some(s => s.toUpperCase() === tabName);
          if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Permission denied: As a team member, you can only update your own tasks (${userConfig.allowedSheets.join(', ')}).` }));
            return;
          }
        }

        let targetRow = parseInt(rowNumber, 10);
        if (!targetRow || isNaN(targetRow)) {
          const currentRes = await executeComposioTool('GOOGLESHEETS_VALUES_GET', {
            spreadsheet_id: SPREADSHEET_ID,
            range: `${tabName}!A1:I50`
          });
          const rows = currentRes?.data?.results?.[0]?.response?.data?.values || [];
          const foundIdx = rows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === (ticket || '').trim().toUpperCase());
          if (foundIdx > 0) {
            targetRow = foundIdx + 1;
          } else {
            targetRow = 2;
          }
        }

        console.log(`[Update Tag] Tab: ${tabName}, Row: ${targetRow}, Ticket: ${ticket}, Tag: ${validTag}`);

        // 1. Update Column I (Tag) in Google Sheets
        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: [{
            range: `${tabName}!I${targetRow}`,
            majorDimension: 'ROWS',
            values: [[validTag]]
          }]
        });

        // 2. Format cell I with matching tag color
        const isSupport = validTag === 'Support';
        const tagCol = isSupport 
          ? { bg: '#fef3c7', text: '#92400e' }
          : { bg: '#e0e7ff', text: '#3730a3' };

        await executeComposioBatch([
          {
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              sheet_name: tabName,
              range: `I${targetRow}`,
              background_color: tagCol.bg,
              text_color: tagCol.text,
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          }
        ]);

        // 3. Update cache
        if (cache.data && cache.data[tabName] && cache.data[tabName][targetRow - 1]) {
          while (cache.data[tabName][targetRow - 1].length < 9) {
            cache.data[tabName][targetRow - 1].push('');
          }
          cache.data[tabName][targetRow - 1][8] = validTag;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ticket, tag: validTag, assignee: tabName, rowNumber: targetRow }));
      } catch (err) {
        console.error('Error updating tag:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  
  // Serve static files from uploads directory
  if (urlObj.pathname.startsWith('/uploads/')) {
    const filename = path.basename(urlObj.pathname);
    const filePath = path.join(__dirname, 'uploads', filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml'
      };
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400'
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Image not found');
      return;
    }
  }

  // POST /api/upload-image -> Upload and save image for comments
  if (urlObj.pathname === '/api/upload-image' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { dataBase64, filename } = JSON.parse(body || '{}');
        if (!dataBase64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'dataBase64 is required' }));
          return;
        }

        const uploadsDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

        const matches = dataBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        let ext = '.png';
        let buffer;
        if (matches) {
          const mime = matches[1];
          if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg';
          else if (mime.includes('webp')) ext = '.webp';
          else if (mime.includes('gif')) ext = '.gif';
          buffer = Buffer.from(matches[2], 'base64');
        } else {
          buffer = Buffer.from(dataBase64, 'base64');
        }

        const safeBaseName = (filename || 'img').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
        const uniqueName = `${safeBaseName}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}${ext}`;
        const filePath = path.join(uploadsDir, uniqueName);
        fs.writeFileSync(filePath, buffer);

        const fileUrl = `http://localhost:3100/uploads/${uniqueName}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, url: fileUrl, filename: uniqueName }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // GET /api/users/mentionable -> List of team members & YouTrack users for @mention
  if (urlObj.pathname === '/api/users/mentionable' && req.method === 'GET') {
    getMentionableUsers().then(users => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, users }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // GET /api/ticket/comments -> Load complete comment section for a ticket
  if (urlObj.pathname === '/api/ticket/comments' && req.method === 'GET') {
    const ticketParam = (urlObj.searchParams.get('ticket') || '').trim();
    if (!ticketParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'ticket parameter required' }));
      return;
    }

    const tKey = ticketParam.toUpperCase();
    const isRealYt = !tKey.startsWith('PLAN-') && !tKey.startsWith('TASK-') && /\b[A-Z][A-Z0-9]+-\d+\b/.test(tKey);

    (async () => {
      try {
        const localStore = loadLocalComments();
        const localComments = localStore[tKey] || [];

        let ytComments = [];
        if (isRealYt) {
          ytComments = await fetchYouTrackComments(tKey);
        }

        // Merge comments: YouTrack comments + any local additions not in YT
        const commentMap = new Map();
        ytComments.forEach(c => commentMap.set(String(c.id), c));
        localComments.forEach(c => {
          const idStr = String(c.id);
          if (!commentMap.has(idStr)) {
            commentMap.set(idStr, c);
          } else {
            const ytItem = commentMap.get(idStr);
            if (c.pinned) {
              ytItem.pinned = true;
              ytItem.pinnedAt = c.pinnedAt;
              ytItem.pinnedBy = c.pinnedBy;
            }
            if (c.deleted) {
              ytItem.deleted = true;
              ytItem.deletedAt = c.deletedAt;
              ytItem.deletedBy = c.deletedBy;
            }
            if (c.isEdited) {
              ytItem.isEdited = true;
              ytItem.updated = c.updated;
              if (c.text) ytItem.text = c.text;
            }
          }
        });

        const merged = Array.from(commentMap.values()).sort((a, b) => a.created - b.created);

        // Update local cache
        localStore[tKey] = merged;
        saveLocalComments(localStore);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          ticket: tKey,
          source: isRealYt ? 'youtrack' : 'local',
          totalCount: merged.filter(c => !c.deleted).length,
          comments: merged
        }));
      } catch (err) {
        console.error(`Error loading comments for ${tKey}:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    })();
    return;
  }

  // GET /api/ticket/comments/batch -> Fetch latest comments dictionary for all tickets
  if (urlObj.pathname === '/api/ticket/comments/batch' && req.method === 'GET') {
    try {
      const localStore = loadLocalComments();
      const batch = {};
      Object.keys(localStore).forEach(tKey => {
        const list = (localStore[tKey] || []).filter(c => !c.deleted);
        if (list.length > 0) {
          const latest = list[list.length - 1];
          batch[tKey] = {
            author: latest.author?.name || latest.author?.login || 'User',
            text: latest.text || '',
            created: latest.created || Date.now(),
            count: list.length
          };
        } else {
          batch[tKey] = {
            author: '',
            text: '',
            created: Date.now(),
            count: 0
          };
        }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, batch }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /api/ticket/add-comment -> Post comment to YouTrack, local store, & sync latest to Google Sheets
  if (urlObj.pathname === '/api/ticket/add-comment' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticket, text, authorName, authorLogin, assignee, rowNumber } = JSON.parse(body || '{}');
        if (!ticket || !text || !text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket and text are required' }));
          return;
        }

        const tKey = ticket.trim().toUpperCase();
        const commentText = text.trim();
        const isRealYt = !tKey.startsWith('PLAN-') && !tKey.startsWith('TASK-') && /\b[A-Z][A-Z0-9]+-\d+\b/.test(tKey);

        let createdComment = null;
        let youTrackSynced = false;
        let youTrackError = null;

        // 1. Post to YouTrack if real issue key
        if (isRealYt) {
          try {
            createdComment = await postYouTrackComment(tKey, commentText);
            youTrackSynced = true;
          } catch (ytErr) {
            console.warn(`[YouTrack Comment Post Error] ${tKey}:`, ytErr.message);
            youTrackError = ytErr.message;
          }
        }

        if (!createdComment) {
          createdComment = {
            id: `local-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            text: commentText,
            created: Date.now(),
            author: {
              name: authorName || 'Team Member',
              login: authorLogin || 'user',
              avatarUrl: ''
            },
            attachments: []
          };
        }

        // 2. Save in local comments store
        const localStore = loadLocalComments();
        if (!localStore[tKey]) localStore[tKey] = [];
        localStore[tKey].push(createdComment);
        saveLocalComments(localStore);

        // 3. Sync compact latest comment to Google Sheets Col G (Col C for PULSE)
        const latestSummary = await syncLatestCommentToSheet(tKey, createdComment, assignee, rowNumber);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          comment: createdComment,
          latestSummary,
          youTrackSynced,
          youTrackError,
          totalCount: localStore[tKey].filter(c => !c.deleted).length
        }));
      } catch (err) {
        console.error('Error adding comment:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/edit-comment -> Update existing comment text in YouTrack, local store, & sync latest if applicable
  if (urlObj.pathname === '/api/ticket/edit-comment' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticket, commentId, text, assignee, rowNumber } = JSON.parse(body || '{}');
        if (!ticket || !commentId || !text || !text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket, commentId, and text are required' }));
          return;
        }

        const tKey = ticket.trim().toUpperCase();
        const cleanText = text.trim();
        const isRealYt = !tKey.startsWith('PLAN-') && !tKey.startsWith('TASK-') && /\b[A-Z][A-Z0-9]+-\d+\b/.test(tKey);
        const isLocalId = String(commentId).startsWith('local-');

        let youTrackSynced = false;
        let youTrackError = null;

        // 1. Update in YouTrack if real YouTrack ticket and not local ID
        if (isRealYt && !isLocalId) {
          try {
            await updateYouTrackComment(tKey, commentId, cleanText);
            youTrackSynced = true;
          } catch (ytErr) {
            console.warn(`[YouTrack Comment Edit Error] ${tKey} ${commentId}:`, ytErr.message);
            youTrackError = ytErr.message;
          }
        }

        // 2. Update in local comments store
        const localStore = loadLocalComments();
        const list = localStore[tKey] || [];
        let updatedComment = null;

        for (let i = 0; i < list.length; i++) {
          if (String(list[i].id) === String(commentId)) {
            list[i].text = cleanText;
            list[i].isEdited = true;
            list[i].updated = Date.now();
            updatedComment = list[i];
            break;
          }
        }

        if (!updatedComment) {
          updatedComment = {
            id: commentId,
            text: cleanText,
            created: Date.now(),
            updated: Date.now(),
            isEdited: true,
            author: { name: 'Team Member', login: 'user' }
          };
          list.push(updatedComment);
        }

        localStore[tKey] = list;
        saveLocalComments(localStore);

        // 3. If this was the latest active comment, update Google Sheets
        const activeList = list.filter(c => !c.deleted);
        let latestSummary = null;
        if (activeList.length > 0 && String(activeList[activeList.length - 1].id) === String(commentId)) {
          latestSummary = await syncLatestCommentToSheet(tKey, updatedComment, assignee, rowNumber);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          comment: updatedComment,
          latestSummary,
          youTrackSynced,
          youTrackError
        }));
      } catch (err) {
        console.error('Error editing comment:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/pin-comment -> Pin or unpin a comment to the top of the thread
  if (urlObj.pathname === '/api/ticket/pin-comment' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticket, commentId, pinned, userName } = JSON.parse(body || '{}');
        if (!ticket || !commentId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket and commentId required' }));
          return;
        }

        const tKey = ticket.trim().toUpperCase();
        const localStore = loadLocalComments();
        const list = localStore[tKey] || [];
        let found = null;

        for (let i = 0; i < list.length; i++) {
          if (String(list[i].id) === String(commentId)) {
            list[i].pinned = !!pinned;
            list[i].pinnedAt = pinned ? Date.now() : null;
            list[i].pinnedBy = pinned ? (userName || 'Team Member') : null;
            found = list[i];
            break;
          }
        }

        if (!found) {
          found = {
            id: commentId,
            pinned: !!pinned,
            pinnedAt: pinned ? Date.now() : null,
            pinnedBy: pinned ? (userName || 'Team Member') : null
          };
          list.push(found);
        }

        localStore[tKey] = list;
        saveLocalComments(localStore);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, pinned: !!pinned, comment: found }));
      } catch (err) {
        console.error('Error toggling pin:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/delete-comment -> Soft delete (Trash) or Permanent delete comment
  if (urlObj.pathname === '/api/ticket/delete-comment' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticket, commentId, permanent = false, userName, assignee, rowNumber } = JSON.parse(body || '{}');
        if (!ticket || !commentId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket and commentId required' }));
          return;
        }

        const tKey = ticket.trim().toUpperCase();
        const isRealYt = !tKey.startsWith('PLAN-') && !tKey.startsWith('TASK-') && /\b[A-Z][A-Z0-9]+-\d+\b/.test(tKey);
        const isLocalId = String(commentId).startsWith('local-');

        let youTrackDeleted = false;
        let youTrackError = null;

        const localStore = loadLocalComments();
        let list = localStore[tKey] || [];

        if (permanent) {
          // Permanent deletion from YouTrack & localStore
          if (isRealYt && !isLocalId) {
            try {
              await deleteYouTrackComment(tKey, commentId);
              youTrackDeleted = true;
            } catch (ytErr) {
              console.warn(`[YouTrack Comment Permanent Delete Error] ${tKey} ${commentId}:`, ytErr.message);
              youTrackError = ytErr.message;
            }
          }
          list = list.filter(c => String(c.id) !== String(commentId));
        } else {
          // Soft deletion (Move to trash)
          let found = false;
          for (let i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(commentId)) {
              list[i].deleted = true;
              list[i].deletedAt = Date.now();
              list[i].deletedBy = userName || 'Team Member';
              list[i].pinned = false; // automatically unpin if moved to trash
              found = true;
              break;
            }
          }
          if (!found) {
            list.push({
              id: commentId,
              deleted: true,
              deletedAt: Date.now(),
              deletedBy: userName || 'Team Member'
            });
          }
        }

        localStore[tKey] = list;
        saveLocalComments(localStore);

        // Update Google Sheets with the latest active (non-deleted) comment
        const activeList = list.filter(c => !c.deleted);
        const newLatest = activeList.length > 0 ? activeList[activeList.length - 1] : null;
        const latestSummary = await syncLatestCommentToSheet(tKey, newLatest, assignee, rowNumber);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          permanent: !!permanent,
          activeCount: activeList.length,
          latestSummary,
          youTrackDeleted,
          youTrackError
        }));
      } catch (err) {
        console.error('Error deleting comment:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/restore-comment -> Restore a soft-deleted comment from Trash
  if (urlObj.pathname === '/api/ticket/restore-comment' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticket, commentId, assignee, rowNumber } = JSON.parse(body || '{}');
        if (!ticket || !commentId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket and commentId required' }));
          return;
        }

        const tKey = ticket.trim().toUpperCase();
        const localStore = loadLocalComments();
        const list = localStore[tKey] || [];
        let restored = null;

        for (let i = 0; i < list.length; i++) {
          if (String(list[i].id) === String(commentId)) {
            list[i].deleted = false;
            list[i].restoredAt = Date.now();
            delete list[i].deletedAt;
            delete list[i].deletedBy;
            restored = list[i];
            break;
          }
        }

        localStore[tKey] = list;
        saveLocalComments(localStore);

        // If this restored comment is now the latest active comment, update Google Sheets Col G
        const activeList = list.filter(c => !c.deleted);
        const newLatest = activeList.length > 0 ? activeList[activeList.length - 1] : null;
        let latestSummary = null;
        if (newLatest && String(newLatest.id) === String(commentId)) {
          latestSummary = await syncLatestCommentToSheet(tKey, newLatest, assignee, rowNumber);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          comment: restored,
          latestSummary,
          activeCount: activeList.length
        }));
      } catch (err) {
        console.error('Error restoring comment:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/update-action-notes -> Edit and sync Action / Notes from dashboard to Google Sheets
  if ((urlObj.pathname === '/api/ticket/update-action-notes' || urlObj.pathname === '/api/ticket/update-notes') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { assignee, ticket, notes, rowNumber } = JSON.parse(body || '{}');
        if (!assignee) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'assignee is required' }));
          return;
        }

        const tabName = assignee.trim().toUpperCase();
        const ticketKey = (ticket || '').trim().toUpperCase();
        const actionNotes = typeof notes === 'string' ? notes : (notes !== undefined && notes !== null ? String(notes) : '');

        // RBAC Check: Team members can only update their own assigned tasks (or PLAN / PULSE if allowed)
        const clientRole = (req.headers['x-user-role'] || '').toUpperCase();
        const clientUser = (req.headers['x-user-name'] || '').toLowerCase();
        const userConfig = USER_ACCOUNTS[clientUser];
        const isSharedTab = ['PLAN', 'PULSE'].includes(tabName);
        if (!isSharedTab && clientRole === 'MEMBER' && userConfig && !userConfig.allowedSheets.includes('ALL')) {
          const isAllowed = userConfig.allowedSheets.some(s => s.toUpperCase() === tabName);
          if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Permission denied: As a team member, you can only update your own tasks (${userConfig.allowedSheets.join(', ')}).` }));
            return;
          }
        }

        let targetRow = parseInt(rowNumber, 10);

        const isPlan = tabName === 'PLAN';
        const targetColLetter = isPlan ? 'F' : 'G';
        const targetColIdx = isPlan ? 5 : 6;

        // If rowNumber is not supplied or invalid, find row in sheet by ticket
        if (!targetRow || isNaN(targetRow)) {
          const currentRes = await executeComposioTool('GOOGLESHEETS_VALUES_GET', {
            spreadsheet_id: SPREADSHEET_ID,
            range: `${tabName}!A1:I100`
          });
          const rows = currentRes?.data?.results?.[0]?.response?.data?.values || [];
          const foundIdx = rows.findIndex((r, idx) => {
            if (idx === 0) return false;
            const t1 = (r[1] || '').trim().toUpperCase();
            const t0 = (r[0] || '').trim().toUpperCase();
            const t2 = (r[2] || '').trim().toUpperCase();
            return t1 === ticketKey || t0 === ticketKey || (isPlan && t2 === ticketKey) || `PLAN-${t0}` === ticketKey;
          });
          if (foundIdx > 0) {
            targetRow = foundIdx + 1;
          } else {
            targetRow = 2;
          }
        }

        console.log(`[Update Action Notes] Tab: ${tabName}, Row: ${targetRow} (${targetColLetter}), Ticket: ${ticketKey}, Notes: "${actionNotes}"`);

        // 1. Update Column F (Dependency / Remarks in PLAN) or Column G (Action / Notes in standard sheets)
        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: [{
            range: `${tabName}!${targetColLetter}${targetRow}`,
            majorDimension: 'ROWS',
            values: [[actionNotes]]
          }]
        });

        // 2. If tab is PULSE, also sync to Chetna's PULSE sheet
        if (tabName === 'PULSE' && INDIVIDUAL_SHEETS.CHETNA) {
          try {
            await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
              spreadsheet_id: INDIVIDUAL_SHEETS.CHETNA,
              valueInputOption: 'USER_ENTERED',
              data: [{
                range: `PULSE!G${targetRow}`,
                majorDimension: 'ROWS',
                values: [[actionNotes]]
              }]
            });
            console.log(`✅ [PULSE Note Synced] Chetna's PULSE sheet updated for row ${targetRow}`);
          } catch (pErr) {
            console.warn('Warning syncing PULSE note to Chetna sheet:', pErr.message);
          }
        }

        // 3. Update memory cache if present
        if (cache.data && cache.data[tabName]) {
          const rIdx = targetRow - 1;
          if (cache.data[tabName][rIdx]) {
            cache.data[tabName][rIdx][targetColIdx] = actionNotes;
          }
          if (INDIVIDUAL_SHEETS[tabName]) {
            pushMasterToIndividualSheet(tabName, cache.data[tabName]).catch(() => {});
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          assignee: tabName,
          ticket: ticketKey,
          notes: actionNotes,
          rowNumber: targetRow,
          message: 'Action / Notes updated and synced to Google Sheets!'
        }));
      } catch (err) {
        console.error('Error updating action notes:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/update-due-date -> Update Due Date and sync to Google Sheets (Col H)
  if (urlObj.pathname === '/api/ticket/update-due-date' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { assignee, ticket, dueDate, rowNumber } = JSON.parse(body || '{}');
        if (!assignee) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'assignee is required' }));
          return;
        }

        const tabName = assignee.trim().toUpperCase();
        const ticketKey = (ticket || '').trim().toUpperCase();
        const formattedDueDate = parseJiraDueDate(dueDate);

        let targetRow = parseInt(rowNumber, 10);
        if (!targetRow || isNaN(targetRow)) {
          const currentRes = await executeComposioTool('GOOGLESHEETS_VALUES_GET', {
            spreadsheet_id: SPREADSHEET_ID,
            range: `${tabName}!A1:I100`
          });
          const rows = currentRes?.data?.results?.[0]?.response?.data?.values || [];
          const foundIdx = rows.findIndex((r, idx) => {
            if (idx === 0) return false;
            const t1 = (r[1] || '').trim().toUpperCase();
            const t0 = (r[0] || '').trim().toUpperCase();
            const t2 = (r[2] || '').trim().toUpperCase();
            return t1 === ticketKey || t0 === ticketKey || t2 === ticketKey || `PLAN-${t0}` === ticketKey;
          });
          if (foundIdx > 0) {
            targetRow = foundIdx + 1;
          } else {
            targetRow = 2;
          }
        }

        // 1. Push Due Date update to YouTrack if real issue key
        let youTrackSynced = false;
        let youTrackError = null;
        if (!ticketKey.startsWith('PLAN-') && !ticketKey.startsWith('TASK-') && /\b[A-Z][A-Z0-9]+-\d+\b/.test(ticketKey)) {
          try {
            const ytToken = currentRequestYouTrackToken || activeYouTrackToken;
            const ytIso = convertDateToYouTrackIso(dueDate || formattedDueDate);
            if (!ytIso) {
              await executeYouTrackCommand(ticketKey, 'Due Date No Due Date', ytToken);
            } else {
              await executeYouTrackCommand(ticketKey, `Due Date ${ytIso}`, ytToken);
            }
            youTrackSynced = true;
          } catch (ytErr) {
            console.warn(`[YouTrack Due Date Sync] Failed for ${ticketKey}:`, ytErr.message);
            youTrackError = ytErr.message;
          }
        }

        // Col H is index 7 (Due Date) in both standard sheets and PLAN!
        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: [{
            range: `${tabName}!H${targetRow}`,
            majorDimension: 'ROWS',
            values: [[formattedDueDate]]
          }]
        });

        if (cache.data && cache.data[tabName]) {
          const rIdx = targetRow - 1;
          if (cache.data[tabName][rIdx]) {
            cache.data[tabName][rIdx][7] = formattedDueDate;
          }
          if (INDIVIDUAL_SHEETS[tabName]) {
            pushMasterToIndividualSheet(tabName, cache.data[tabName]).catch(() => {});
          }
        }

        if (youTrackError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `YouTrack update failed: ${youTrackError}`
          }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          assignee: tabName,
          ticket: ticketKey,
          dueDate: formattedDueDate,
          rowNumber: targetRow,
          youTrackSynced,
          message: youTrackSynced
            ? `Due date updated in YouTrack & Google Sheets ("${formattedDueDate}")!`
            : 'Due date updated and synced to Google Sheets!'
        }));
      } catch (err) {
        console.error('Error updating due date:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/ticket/update-youtrack-state -> Update YouTrack State (and sync to Google Sheets Col E)
  if (urlObj.pathname === '/api/ticket/update-youtrack-state' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { assignee, ticket, state, rowNumber } = JSON.parse(body || '{}');
        if (!assignee || !ticket || !state) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'assignee, ticket, and state are required' }));
          return;
        }

        const tabName = assignee.trim().toUpperCase();
        const ticketKey = ticket.trim().toUpperCase();
        const newState = state.trim();

        // 1. If real YouTrack ticket, push State update to YouTrack
        let youTrackSynced = false;
        let youTrackError = null;
        if (!ticketKey.startsWith('PLAN-') && !ticketKey.startsWith('TASK-') && /\b[A-Z][A-Z0-9]+-\d+\b/.test(ticketKey)) {
          try {
            const ytToken = currentRequestYouTrackToken || activeYouTrackToken;
            await updateYouTrackIssueState(ticketKey, newState, ytToken);
            youTrackSynced = true;
          } catch (ytErr) {
            console.warn(`[YouTrack State Sync] Failed for ${ticketKey}:`, ytErr.message);
            youTrackError = ytErr.message;
          }
        }

        if (youTrackError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `YouTrack update failed: ${youTrackError}`
          }));
          return;
        }

        // 2. Find row index in Google Sheet
        let targetRow = parseInt(rowNumber, 10);
        if (!targetRow || isNaN(targetRow)) {
          const currentRes = await executeComposioTool('GOOGLESHEETS_VALUES_GET', {
            spreadsheet_id: SPREADSHEET_ID,
            range: `${tabName}!A1:I100`
          });
          const rows = currentRes?.data?.results?.[0]?.response?.data?.values || [];
          const foundIdx = rows.findIndex((r, idx) => {
            if (idx === 0) return false;
            const t1 = (r[1] || '').trim().toUpperCase();
            const t0 = (r[0] || '').trim().toUpperCase();
            return t1 === ticketKey || t0 === ticketKey;
          });
          targetRow = foundIdx > 0 ? (foundIdx + 1) : 2;
        }

        // Col E is index 4 (1-indexed col 5: YouTrack Status) in standard sheets; Col C is index 2 in PULSE
        const isPulseTab = tabName === 'PULSE';
        const colLetter = isPulseTab ? 'C' : 'E';
        const colIdx = isPulseTab ? 2 : 4;

        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: [{
            range: `${tabName}!${colLetter}${targetRow}`,
            majorDimension: 'ROWS',
            values: [[newState]]
          }]
        });

        // Cell formatting
        const colStyle = STATUS_COLORS[newState] || STATUS_COLORS['To Pick Up'];
        if (colStyle) {
          executeComposioTool('GOOGLESHEETS_FORMAT_CELL', {
            spreadsheet_id: SPREADSHEET_ID,
            sheet_name: tabName,
            range: `${colLetter}${targetRow}`,
            background_color: colStyle.bg,
            text_color: colStyle.text,
            bold: true,
            horizontal_alignment: 'CENTER'
          }).catch(() => {});
        }

        if (cache.data && cache.data[tabName]) {
          const rIdx = targetRow - 1;
          if (cache.data[tabName][rIdx]) {
            cache.data[tabName][rIdx][colIdx] = newState;
          }
          if (INDIVIDUAL_SHEETS[tabName]) {
            pushMasterToIndividualSheet(tabName, cache.data[tabName]).catch(() => {});
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          assignee: tabName,
          ticket: ticketKey,
          state: newState,
          rowNumber: targetRow,
          youTrackSynced,
          youTrackError,
          message: youTrackSynced 
            ? `YouTrack State updated to "${newState}" in YouTrack & Google Sheets!`
            : (youTrackError ? `Updated in Google Sheets (YouTrack notice: ${youTrackError})` : 'State updated in Google Sheets!')
        }));
      } catch (err) {
        console.error('Error updating YouTrack state:', err);
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

        // 2. Find row in fromTab (check ticket Col B, S.No Col A, title Col C, or PLAN-x)
        const targetIdx = fromRows.findIndex((r, idx) => {
          if (idx === 0) return false;
          const t1 = (r[1] || '').trim().toUpperCase();
          const t0 = (r[0] || '').trim().toUpperCase();
          const t2 = (r[2] || '').trim().toUpperCase();
          return t1 === ticketKey || t0 === ticketKey || `PLAN-${t0}` === ticketKey || t2.toUpperCase() === ticketKey;
        });
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
        const fromColCount = Math.max(8, (fromRows[0] && fromRows[0].length) || 8);
        const paddedFromRows = [...newFromRows];
        const emptyRow = new Array(fromColCount).fill('');
        while (paddedFromRows.length < fromRows.length) {
          paddedFromRows.push([...emptyRow]);
        }

        // 4. Upsert row to toTab (prevent duplicate entries if already in destination tab)
        const newToRows = [...toRows];
        if (newToRows.length === 0 || newToRows[0][0] !== '#') {
          newToRows.unshift(['#', 'Ticket ID', 'Ticket Link', 'Title', 'YouTrack Status', 'Internal Status', 'Action / Notes', 'Due Date', 'Tag']);
        }
        const existingToIdx = newToRows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
        
        let movedRow;
        if (fromTab === 'PLAN') {
          const taskTitle = targetRow[2] || targetRow[1] || ticketKey;
          const taskNotes = targetRow[5] ? `[Epic: ${targetRow[1] || 'None'}] ${targetRow[5]}` : (targetRow[1] ? `[Epic: ${targetRow[1]}]` : '');
          const taskTag = targetRow[8] || 'Product';
          movedRow = [
            '',
            ticketKey,
            ticketKey.includes('-') && !ticketKey.startsWith('PLAN-') ? `https://enveu.youtrack.cloud/issue/${ticketKey}` : '',
            taskTitle,
            'To Do',
            'To Pick Up',
            taskNotes,
            'Not set',
            taskTag
          ];
        } else {
          movedRow = [...targetRow];
        }

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
        const fromEndCol = colIndexToLetter(Math.max(8, (paddedFromRows[0] && paddedFromRows[0].length - 1) || 8));
        const toEndCol = colIndexToLetter(Math.max(8, (newToRows[0] && newToRows[0].length - 1) || 8));
        const updatePayload = [
          {
            range: `${fromTab}!A1:${fromEndCol}${paddedFromRows.length}`,
            majorDimension: 'ROWS',
            values: paddedFromRows
          },
          {
            range: `${toTab}!A1:${toEndCol}${newToRows.length}`,
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
              ticketUrl: found[2] || `https://enveu.youtrack.cloud/issue/${ticketKey}`,
              title: found[3] || '',
              jiraStatus: found[4] || 'To Do',
              internalStatus: found[5] || 'To Pick Up',
              notes: found[6] || '',
              dueDate: found[7] || 'Not set'
            };
            break;
          }
        }

        if (existingInfo) {
          try {
            const ytToken = currentRequestYouTrackToken || activeYouTrackToken;
            const ytRes = await fetchYouTrackIssue(ticketKey, ytToken);
            if (ytRes.dueDate && ytRes.dueDate !== 'Not set' && ytRes.dueDate.toLowerCase() !== 'tbd') {
              existingInfo.dueDate = ytRes.dueDate;
            }
            if (ytRes.youTrackStatus) existingInfo.jiraStatus = ytRes.youTrackStatus;
            if (ytRes.title && !existingInfo.title) existingInfo.title = ytRes.title;
          } catch (e) {}
        } else {
          try {
            const ytToken = currentRequestYouTrackToken || activeYouTrackToken;
            const ytRes = await fetchYouTrackIssue(ticketKey, ytToken);
            existingInfo = {
              ticketKey,
              ticketUrl: ytRes.url || `https://enveu.youtrack.cloud/issue/${ticketKey}`,
              title: ytRes.title || `Ticket ${ticketKey}`,
              jiraStatus: ytRes.youTrackStatus || 'To Do',
              internalStatus: 'To Pick Up',
              notes: '',
              dueDate: ytRes.dueDate || 'Not set'
            };
          } catch (e) {
            existingInfo = {
              ticketKey,
              ticketUrl: `https://enveu.youtrack.cloud/issue/${ticketKey}`,
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
            rows.unshift(['#', 'Ticket ID', 'Ticket Link', 'Title', 'YouTrack Status', 'Internal Status', 'Action / Notes', 'Due Date', 'Tag']);
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

          const maxCols = Math.max(9, (rows[0] && rows[0].length) || 9, ...rows.map(r => (r ? r.length : 0)));
          const endLetter = colIndexToLetter(maxCols - 1);
          const normalizedRows = rows.map(r => {
            const copy = [...r];
            while (copy.length < maxCols) copy.push('');
            return copy.slice(0, maxCols);
          });

          sheetData[tabName] = rows;
          updatePayload.push({
            range: `${tabName}!A1:${endLetter}${normalizedRows.length}`,
            majorDimension: 'ROWS',
            values: normalizedRows
          });

          const jCol = STATUS_COLORS[existingInfo.jiraStatus] || STATUS_COLORS['To Pick Up'];
          const iCol = STATUS_COLORS[iStatus] || STATUS_COLORS['To Pick Up'];

          formatCalls.push({
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              spreadsheetId: SPREADSHEET_ID,
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
              spreadsheetId: SPREADSHEET_ID,
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

              const maxRemCols = Math.max(9, (rows[0] && rows[0].length) || 9, ...newRows.map(r => (r ? r.length : 0)));
              const remEndLetter = colIndexToLetter(maxRemCols - 1);
              const paddedNewRows = [...newRows];
              while (paddedNewRows.length < oldLength) {
                paddedNewRows.push(new Array(maxRemCols).fill(''));
              }
              const normalizedNewRows = paddedNewRows.map(r => {
                const copy = [...r];
                while (copy.length < maxRemCols) copy.push('');
                return copy.slice(0, maxRemCols);
              });
              sheetData[remTab] = newRows;
              updatePayload.push({
                range: `${remTab}!A1:${remEndLetter}${normalizedNewRows.length}`,
                majorDimension: 'ROWS',
                values: normalizedNewRows
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
          const targetIdx = rows.findIndex((r, idx) => {
            if (idx === 0) return false;
            if (r[1] && r[1].trim().toUpperCase() === ticketKey) return true;
            if (ticketKey.startsWith('PLAN-')) {
              const numPart = ticketKey.replace('PLAN-', '').trim();
              if (r[0] && r[0].trim() === numPart) return true;
              if (r[2] && r[2].trim().toUpperCase() === ticketKey) return true;
            }
            if (r[0] && r[0].trim().toUpperCase() === ticketKey) return true;
            return false;
          });

          if (targetIdx > 0) {
            deletedFromCount++;
            const oldLength = rows.length;
            const newRows = rows.filter((_, idx) => idx !== targetIdx);
            newRows.forEach((r, idx) => {
              if (idx > 0) r[0] = String(idx);
            });

            // Pad with empty row to clear out deleted row in Google Sheets
            const maxCols = Math.max(9, ...rows.map(r => r.length));
            const endLetter = colIndexToLetter(maxCols - 1);
            const paddedRows = [...newRows];
            while (paddedRows.length < oldLength) {
              paddedRows.push(new Array(maxCols).fill(''));
            }

            sheetData[tab] = newRows;
            updatePayload.push({
              range: `${tab}!A1:${endLetter}${paddedRows.length}`,
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
          const fromTab = fromAssignee ? resolveActualTabName(fromAssignee) : '';
          const isAllowed = fromTab && userConfig.allowedSheets.some(s => s.toUpperCase() === fromTab.toUpperCase());
          if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Permission denied: As a team member, you can only close tasks from your own sheet (${userConfig.allowedSheets.join(', ')}).` }));
            return;
          }
        }

        // 1. Fetch live sheets
        const { sheetNames, sheetData } = await fetchAllSheetsFromGoogle();

        let closedTab = resolveActualTabName('CLOSED') || 'CLOSED';
        let closedRows = sheetData[closedTab] || [];
        if (closedRows.length === 0 || (closedRows[0][0] !== '#' && closedRows[0][0] !== 'SNo')) {
          await ensureClosedSheetExists();
          closedRows.unshift(['#', 'Ticket ID', 'Ticket Link', 'Title', 'YouTrack Status', 'Internal Status', 'Action / Notes', 'Due Date', 'Tag']);
        }

        // Determine target member tabs to remove from
        const resolvedFrom = fromAssignee ? resolveActualTabName(fromAssignee) : null;
        let memberTabs = (resolvedFrom && !allTabs)
          ? [resolvedFrom]
          : sheetNames.filter(s => s.trim().toUpperCase() !== closedTab.toUpperCase());

        let movedTicketData = null;
        const updatePayload = [];
        let removedCount = 0;
        const affectedMemberTabs = [];

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

            // Calculate max columns to ensure uniform grid and dynamic end column
            const maxTabCols = Math.max(9, ...rows.map(r => (r ? r.length : 0)));
            const endCol = colIndexToLetter(maxTabCols - 1);

            // Pad with empty row to clear out deleted row in Google Sheets
            const paddedRows = [...newRows];
            while (paddedRows.length < oldLength) {
              paddedRows.push(new Array(maxTabCols).fill(''));
            }

            const normalizedPaddedRows = paddedRows.map(r => {
              const copy = [...r];
              while (copy.length < maxTabCols) copy.push('');
              return copy.slice(0, maxTabCols);
            });

            sheetData[tab] = newRows;
            affectedMemberTabs.push(tab);
            updatePayload.push({
              range: `${tab}!A1:${endCol}${normalizedPaddedRows.length}`,
              majorDimension: 'ROWS',
              values: normalizedPaddedRows
            });
          }
        }

        // Fallback: If not found in specified fromAssignee tab, search all member sheets
        if (!movedTicketData && resolvedFrom && !allTabs) {
          const fallbackTabs = sheetNames.filter(s => s.trim().toUpperCase() !== closedTab.toUpperCase() && s.trim().toUpperCase() !== resolvedFrom.toUpperCase());
          for (const tab of fallbackTabs) {
            if (!sheetData[tab]) continue;
            const rows = sheetData[tab] || [];
            const targetIdx = rows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
            if (targetIdx > 0) {
              removedCount++;
              movedTicketData = [...rows[targetIdx]];
              const oldLength = rows.length;
              const newRows = rows.filter((_, idx) => idx !== targetIdx);
              newRows.forEach((r, idx) => {
                if (idx > 0) r[0] = String(idx);
              });
              const maxTabCols = Math.max(9, ...rows.map(r => (r ? r.length : 0)));
              const endCol = colIndexToLetter(maxTabCols - 1);
              const paddedRows = [...newRows];
              while (paddedRows.length < oldLength) {
                paddedRows.push(new Array(maxTabCols).fill(''));
              }
              const normalizedPaddedRows = paddedRows.map(r => {
                const copy = [...r];
                while (copy.length < maxTabCols) copy.push('');
                return copy.slice(0, maxTabCols);
              });
              sheetData[tab] = newRows;
              affectedMemberTabs.push(tab);
              updatePayload.push({
                range: `${tab}!A1:${endCol}${normalizedPaddedRows.length}`,
                majorDimension: 'ROWS',
                values: normalizedPaddedRows
              });
              break;
            }
          }
        }

        if (!movedTicketData) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Ticket ${ticketKey} not found in member sheet tabs` }));
          return;
        }

        // Determine max columns for CLOSED tab
        const maxClosedCols = Math.max(9, (closedRows[0] && closedRows[0].length) || 9, movedTicketData.length);
        const closedEndCol = colIndexToLetter(maxClosedCols - 1);

        // Prepare row in CLOSED sheet
        const existingClosedIdx = closedRows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
        const closedRow = [...movedTicketData];
        while (closedRow.length < maxClosedCols) closedRow.push('');

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

        const normalizedClosedRows = closedRows.map(r => {
          const copy = [...r];
          while (copy.length < maxClosedCols) copy.push('');
          return copy.slice(0, maxClosedCols);
        });

        sheetData[closedTab] = closedRows;
        updatePayload.push({
          range: `${closedTab}!A1:${closedEndCol}${normalizedClosedRows.length}`,
          majorDimension: 'ROWS',
          values: normalizedClosedRows
        });

        // 2. Batch update Google Sheets
        const updateRes = await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          spreadsheetId: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: updatePayload
        });

        if (updateRes && (updateRes.error || updateRes.isError || updateRes.successful === false || (updateRes.data && updateRes.data.results && updateRes.data.results.some(r => r.response && r.response.successful === false)))) {
          const errMsg = updateRes.error || updateRes.data?.results?.find(r => r.response?.error)?.response?.error || 'Google Sheets update failed';
          console.error(`❌ [Close Ticket] Google Sheets batch update failed:`, errMsg);
          throw new Error(`Google Sheets update failed: ${errMsg}`);
        }

        // 3. Format status cells in CLOSED sheet
        const cCol = STATUS_COLORS['Closed'];
        await executeComposioBatch([
          {
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              spreadsheetId: SPREADSHEET_ID,
              sheet_name: closedTab,
              range: `F${targetClosedRowIdx}`,
              background_color: cCol.bg,
              text_color: cCol.text,
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          }
        ]).catch(e => console.warn('[Close Ticket] Format note:', e.message));

        // 4. Push updates to individual member sheets immediately
        affectedMemberTabs.forEach(mTab => {
          if (INDIVIDUAL_SHEETS[mTab]) {
            pushMasterToIndividualSheet(mTab, sheetData[mTab]).catch(e => console.warn(`[pushMasterToIndividualSheet] ${mTab}:`, e.message));
          }
        });

        // 5. Update server cache
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
        const destTab = resolveActualTabName(toAssignee);
        console.log(`[Reopen Ticket] Moving ${ticketKey} from CLOSED to ${destTab}...`);

        const { sheetNames, sheetData } = await fetchAllSheetsFromGoogle();
        let closedTab = resolveActualTabName('CLOSED') || 'CLOSED';

        const closedRows = sheetData[closedTab] || [];
        const targetIdx = closedRows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);

        if (targetIdx <= 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Ticket ${ticketKey} not found in ${closedTab} tab` }));
          return;
        }

        const targetRow = [...closedRows[targetIdx]];

        // Remove from CLOSED
        const oldLength = closedRows.length;
        const newClosedRows = closedRows.filter((_, idx) => idx !== targetIdx);
        newClosedRows.forEach((r, idx) => {
          if (idx > 0) r[0] = String(idx);
        });

        const maxClosedCols = Math.max(9, ...closedRows.map(r => (r ? r.length : 0)));
        const closedEndCol = colIndexToLetter(maxClosedCols - 1);

        const paddedClosedRows = [...newClosedRows];
        while (paddedClosedRows.length < oldLength) {
          paddedClosedRows.push(new Array(maxClosedCols).fill(''));
        }
        const normalizedPaddedClosedRows = paddedClosedRows.map(r => {
          const copy = [...r];
          while (copy.length < maxClosedCols) copy.push('');
          return copy.slice(0, maxClosedCols);
        });

        sheetData[closedTab] = newClosedRows;

        // Upsert into destTab
        const toRows = sheetData[destTab] || [];
        const newToRows = [...toRows];
        if (newToRows.length === 0 || (newToRows[0][0] !== '#' && newToRows[0][0] !== 'SNo')) {
          newToRows.unshift(['#', 'Ticket ID', 'Ticket Link', 'Title', 'YouTrack Status', 'Internal Status', 'Action / Notes', 'Due Date', 'Tag']);
        }

        const maxDestCols = Math.max(9, (newToRows[0] && newToRows[0].length) || 9, targetRow.length);
        const destEndCol = colIndexToLetter(maxDestCols - 1);

        while (targetRow.length < maxDestCols) targetRow.push('');

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

        const normalizedNewToRows = newToRows.map(r => {
          const copy = [...r];
          while (copy.length < maxDestCols) copy.push('');
          return copy.slice(0, maxDestCols);
        });

        sheetData[destTab] = newToRows;

        const updatePayload = [
          {
            range: `${closedTab}!A1:${closedEndCol}${normalizedPaddedClosedRows.length}`,
            majorDimension: 'ROWS',
            values: normalizedPaddedClosedRows
          },
          {
            range: `${destTab}!A1:${destEndCol}${normalizedNewToRows.length}`,
            majorDimension: 'ROWS',
            values: normalizedNewToRows
          }
        ];

        const updateRes = await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          spreadsheetId: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: updatePayload
        });

        if (updateRes && (updateRes.error || updateRes.isError || updateRes.successful === false || (updateRes.data && updateRes.data.results && updateRes.data.results.some(r => r.response && r.response.successful === false)))) {
          const errMsg = updateRes.error || updateRes.data?.results?.find(r => r.response?.error)?.response?.error || 'Google Sheets update failed';
          console.error(`❌ [Reopen Ticket] Google Sheets batch update failed:`, errMsg);
          throw new Error(`Google Sheets update failed: ${errMsg}`);
        }

        // Format status cell in destTab
        const iCol = STATUS_COLORS[targetRow[5]] || STATUS_COLORS['To Pick Up'];
        await executeComposioBatch([
          {
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              spreadsheetId: SPREADSHEET_ID,
              sheet_name: destTab,
              range: `F${newRowIndex}`,
              background_color: iCol.bg,
              text_color: iCol.text,
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          }
        ]).catch(e => console.warn('[Reopen Ticket] Format note:', e.message));

        // Push to individual member sheet
        if (INDIVIDUAL_SHEETS[destTab]) {
          pushMasterToIndividualSheet(destTab, sheetData[destTab]).catch(e => console.warn(`[pushMasterToIndividualSheet] ${destTab}:`, e.message));
        }

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

  // POST /api/ticket/move-to-fe-ready -> Clone ticket to FE Ready sheet with assignee CHETNA and status FE Ready
  if (urlObj.pathname === '/api/ticket/move-to-fe-ready' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticket, fromAssignee } = JSON.parse(body);
        if (!ticket) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket key is required' }));
          return;
        }

        const ticketKey = ticket.trim().toUpperCase();
        console.log(`[Move to FE Ready] Cloning ${ticketKey} to FE Ready sheet for CHETNA...`);

        const apiKey = resolveApiKey(req.headers['x-composio-key']);
        await ensureFeReadySheetExists(apiKey);

        const { sheetNames, sheetData } = await fetchAllSheetsFromGoogle();
        let feReadyTab = sheetNames.find(s => s.trim().toUpperCase() === 'FE READY') || 'FE Ready';
        let feReadyRows = sheetData[feReadyTab] || [];

        if (feReadyRows.length === 0 || (feReadyRows[0][0] !== '#' && feReadyRows[0][0] !== 'SNo')) {
          feReadyRows.unshift(['#', 'Ticket ID', 'Ticket Link', 'Title', 'YouTrack Status', 'Internal Status', 'Action / Notes', 'Due Date', 'Tag']);
        }

        // Search for ticket in source tab or all tabs
        let sourceRow = null;
        const searchTabs = fromAssignee ? [fromAssignee.trim().toUpperCase()] : sheetNames;
        for (const tab of searchTabs) {
          if (!sheetData[tab]) continue;
          const targetIdx = sheetData[tab].findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
          if (targetIdx > 0) {
            sourceRow = [...sheetData[tab][targetIdx]];
            break;
          }
        }

        if (!sourceRow) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Ticket ${ticketKey} not found in sheets` }));
          return;
        }

        // Prepare cloned row
        const clonedRow = [...sourceRow];
        while (clonedRow.length < 9) clonedRow.push('');
        clonedRow[5] = 'FE Ready'; // Fixed status
        if (!clonedRow[8]) clonedRow[8] = 'Product';

        // Check if already in FE Ready
        const existingIdx = feReadyRows.findIndex((r, idx) => idx > 0 && r[1] && r[1].trim().toUpperCase() === ticketKey);
        let targetRowIdx;
        if (existingIdx > 0) {
          clonedRow[0] = String(existingIdx);
          feReadyRows[existingIdx] = clonedRow;
          targetRowIdx = existingIdx + 1;
        } else {
          clonedRow[0] = String(feReadyRows.length);
          feReadyRows.push(clonedRow);
          targetRowIdx = feReadyRows.length;
        }

        sheetData[feReadyTab] = feReadyRows;

        // Write to Google Sheets
        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: [{
            range: `${feReadyTab}!A1:I${feReadyRows.length}`,
            majorDimension: 'ROWS',
            values: feReadyRows
          }]
        }, apiKey);

        // Format status cell in FE Ready
        await executeComposioBatch([
          {
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              sheet_name: feReadyTab,
              range: `F${targetRowIdx}`,
              background_color: '#e0e7ff',
              text_color: '#3730a3',
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          }
        ], apiKey);

        // Update cache
        cache = {
          data: sheetData,
          sheetNames,
          timestamp: Date.now()
        };

        console.log(`✅ [Move to FE Ready Complete] ${ticketKey} cloned into ${feReadyTab} for CHETNA`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `Ticket ${ticketKey} successfully cloned to ${feReadyTab} for CHETNA!`,
          data: sheetData
        }));
      } catch (err) {
        console.error('Error in move-to-fe-ready:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

let activeYouTrackSyncPromise = null;

async function executeYouTrackBulkSync(syncApiKey, ytToken) {
  console.log('⚡ Starting Bulk YouTrack Sync for All Sheets...');
  
  // 1. Fetch live sheets
  const { sheetNames, sheetData } = await fetchAllSheetsFromGoogle(syncApiKey);
  
  // 2. Collect unique tickets
  const allTicketKeys = new Set();
  sheetNames.forEach(tab => {
    if (tab === 'PLAN') return; // PLAN doesn't contain tracker tickets
    const rows = sheetData[tab] || [];
    const isPulse = tab === 'PULSE';

    rows.forEach((row, idx) => {
      if (idx === 0) return; // skip header
      const targetStr = isPulse ? String(row[0] || '') : String(row[1] || '');
      const matches = targetStr.match(/\b[A-Z][A-Z0-9]+-\d+\b/g);
      if (matches) {
        matches.forEach(m => allTicketKeys.add(m.trim().toUpperCase()));
      }
    });
  });

  const keyList = Array.from(allTicketKeys);
  console.log(`Found ${keyList.length} valid tickets across all sheets:`, keyList);

  if (keyList.length === 0) {
    return { success: true, count: 0, message: 'No tickets to sync', data: sheetData, sheetNames, commentsBatch: {} };
  }

  // 3. Query YouTrack using batch fetcher
  let youTrackMap = {};
  try {
    youTrackMap = await batchFetchYouTrackIssues(keyList, ytToken);
  } catch (ytErr) {
    if (ytErr.isAuthError) {
      const err = new Error(ytErr.message);
      err.isAuthError = true;
      throw err;
    }
    console.warn('YouTrack batch fetch warning:', ytErr.message);
  }

  console.log(`Successfully fetched details for ${Object.keys(youTrackMap).length} tickets from YouTrack.`);

  // 3.5. Override comments store with latest comments from YouTrack & construct commentsBatch
  const localCommentsStore = loadLocalComments();
  const commentsBatch = {};

  Object.keys(youTrackMap).forEach(key => {
    const item = youTrackMap[key];
    if (item && Array.isArray(item.comments) && item.comments.length > 0) {
      localCommentsStore[key] = item.comments;
      const latest = item.comments[item.comments.length - 1];
      commentsBatch[key] = {
        author: latest.author?.name || latest.author?.login || 'User',
        text: latest.text || '',
        created: latest.created || Date.now(),
        count: item.comments.length
      };
    } else {
      localCommentsStore[key] = [];
      commentsBatch[key] = {
        author: '',
        text: '',
        created: Date.now(),
        count: 0
      };
    }
  });
  saveLocalComments(localCommentsStore);

  // 4. Update rows for each sheet tab and prepare batch writes
  const updateData = [];
  const updatedMemberTabs = [];
  let updatedCount = 0;

  sheetNames.forEach(tab => {
    if (tab === 'PLAN') return; // PLAN tab does not have tracker status
    const rows = sheetData[tab] || [];
    if (rows.length <= 1) return;

    let hasTabChanges = false;
    const isPulse = tab === 'PULSE';

    rows.forEach((row, rIdx) => {
      if (rIdx === 0) return;

      if (isPulse) {
        // PULSE layout: [Ticket Number, Title, Status, Assignee, Type, Link, Remarks]
        const ticketCell = String(row[0] || '').trim();
        const matches = ticketCell.match(/\b[A-Z][A-Z0-9]+-\d+\b/g);
        if (matches && matches.length > 0) {
          const mainKey = matches[0].toUpperCase();
          if (youTrackMap[mainKey]) {
            const item = youTrackMap[mainKey];
            if (item.title) row[1] = item.title;
            if (item.youTrackStatus) row[2] = item.youTrackStatus;
            row[5] = item.url || `https://enveu.youtrack.cloud/issue/${mainKey}`;

            // Override Remarks (Col G / index 6) with last YouTrack comment if present
            if (commentsBatch[mainKey] && commentsBatch[mainKey].count > 0 && commentsBatch[mainKey].text) {
              row[6] = commentsBatch[mainKey].text;
            } else if (commentsBatch[mainKey] && commentsBatch[mainKey].count === 0) {
              row[6] = '';
            }

            hasTabChanges = true;
            updatedCount++;
          }
        }
      } else {
        // Standard Member Sheet layout: [Link, Ticket, Title, Tag, YouTrack Status, Internal Status, Action/Notes, Due Date]
        const ticketKey = String(row[1] || '').trim().toUpperCase();
        if (youTrackMap[ticketKey]) {
          const item = youTrackMap[ticketKey];
          if (item.title) row[2] = item.title;
          if (item.tag) row[3] = item.tag;
          if (item.youTrackStatus) row[4] = item.youTrackStatus;
          row[0] = item.url || `https://enveu.youtrack.cloud/issue/${ticketKey}`;

          // Override Action / Notes (Col G / index 6) with last YouTrack comment if present
          if (commentsBatch[ticketKey] && commentsBatch[ticketKey].count > 0 && commentsBatch[ticketKey].text) {
            row[6] = commentsBatch[ticketKey].text;
          } else if (commentsBatch[ticketKey] && commentsBatch[ticketKey].count === 0) {
            row[6] = '';
          }

          hasTabChanges = true;
          updatedCount++;
        }
      }
    });

    if (hasTabChanges) {
      updateData.push({
        range: `${tab}!A2:G${rows.length}`,
        values: rows.slice(1).map(r => [
          r[0] || '',
          r[1] || '',
          r[2] || '',
          r[3] || '',
          r[4] || '',
          r[5] || '',
          r[6] || ''
        ])
      });

      if (!isPulse && tab !== 'ALL' && tab !== 'MASTER') {
        updatedMemberTabs.push(tab);
      }
    }
  });

  // 5. Batch write to Master Google Sheet
  if (updateData.length > 0) {
    console.log(`Writing batch updates to Master Google Sheet for ${updateData.length} tabs...`);
    await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
      spreadsheet_id: SPREADSHEET_ID,
      valueInputOption: 'USER_ENTERED',
      data: updateData
    }, syncApiKey);
  }

  // 6. Push updates to individual member sheets in background
  updatedMemberTabs.forEach(tab => {
    pushMasterToIndividualSheet(tab, sheetData[tab]).catch(e => console.warn(`[pushMasterToIndividualSheet] ${tab}:`, e.message));
  });

  // 7. Update cache immediately
  cache = {
    data: sheetData,
    sheetNames,
    timestamp: Date.now()
  };

  console.log(`✅ Bulk YouTrack Sync Complete. Synchronized ${updatedCount} ticket rows with YouTrack & Google Sheets.`);
  return {
    success: true,
    source: 'youtrack',
    count: updatedCount,
    sheetNames,
    data: sheetData,
    commentsBatch
  };
}

  // POST /api/youtrack/sync-all -> Batch sync all YouTrack tickets across all sheets
  if (urlObj.pathname === '/api/youtrack/sync-all' && req.method === 'POST') {
    try {
      // Validate Composio API key upfront for Google Sheets operations
      const syncApiKey = currentRequestApiKey || lastKnownActiveApiKey || COMPOSIO_KEY;
      if (!syncApiKey || !syncApiKey.startsWith('ck_')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Composio API Key is required for Google Sheets. Please sign in and configure your key in the dashboard.' }));
        return;
      }

      const ytToken = currentRequestYouTrackToken || activeYouTrackToken;

      // Deduplicate: If another sync is already running in background, join it without creating parallel requests
      if (activeYouTrackSyncPromise) {
        console.log('⚡ Bulk YouTrack Sync already in progress. Joining running background sync...');
        const result = await activeYouTrackSyncPromise;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      activeYouTrackSyncPromise = executeYouTrackBulkSync(syncApiKey, ytToken);
      const result = await activeYouTrackSyncPromise;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('Error in youtrack sync-all:', err);
      res.writeHead(err.isAuthError ? 401 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message, isAuthError: !!err.isAuthError }));
    } finally {
      activeYouTrackSyncPromise = null;
    }
    return;
  }

  // POST /api/jira/sync-all -> Disabled (Jira removed, using YouTrack)
  if (urlObj.pathname === '/api/jira/sync-all') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Jira bulk sync has been removed. Please use YouTrack bulk sync (/api/youtrack/sync-all).' }));
    return;
  }

  // POST /api/add-ticket -> Add ticket to sheet & dashboard (supports both YouTrack and Jira)
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
          source,
          jiraStatus,
          youTrackStatus,
          internalStatus,
          status,
          notes,
          dueDate
        } = payload;

        const tabName = (assignee || '').trim().toUpperCase();

        // Support for items that need to be planned later or ticket is not present
        if (!ticket && (title || notes || tabName === 'PLAN')) {
          ticket = (tabName === 'PLAN' ? 'PLAN-' : 'TASK-') + Date.now().toString().slice(-4);
        }

        if (!ticket || !assignee) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ticket (or title) and assignee are required' }));
          return;
        }

        // RBAC Check: Team members can add tasks to their own sheet or shared sheets like PLAN
        const clientRole = (req.headers['x-user-role'] || '').toUpperCase();
        const clientUser = (req.headers['x-user-name'] || '').toLowerCase();
        const userConfig = USER_ACCOUNTS[clientUser];
        const isSharedTab = ['PLAN'].includes(tabName);
        if (!isSharedTab && clientRole === 'MEMBER' && userConfig && !userConfig.allowedSheets.includes('ALL')) {
          const isAllowed = userConfig.allowedSheets.some(s => s.toUpperCase() === tabName);
          if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Permission denied: As a team member, you can only add tasks to your own sheet (${userConfig.allowedSheets.join(', ')}).` }));
            return;
          }
        }

        const ticketKey = ticket.trim().toUpperCase();
        let trackerStatus = youTrackStatus || jiraStatus || '';
        let ticketUrl = '';

        // Query tracker if real ticket key
        if (!ticketKey.startsWith('PLAN-') && !ticketKey.startsWith('TASK-')) {
          try {
            const ytToken = currentRequestYouTrackToken || activeYouTrackToken;
            const ytRes = await fetchYouTrackIssue(ticketKey, ytToken);
            if (ytRes.title && !title) title = ytRes.title;
            if (ytRes.youTrackStatus && !trackerStatus) trackerStatus = ytRes.youTrackStatus;
            ticketUrl = ytRes.url || `https://enveu.youtrack.cloud/issue/${ticketKey}`;
            if (ytRes.dueDate && ytRes.dueDate !== 'Not set' && ytRes.dueDate.toLowerCase() !== 'tbd') {
              dueDate = ytRes.dueDate;
            }
          } catch (ytErr) {
            console.warn(`[add-ticket] YouTrack fetch error for ${ticketKey}:`, ytErr.message);
            ticketUrl = `https://enveu.youtrack.cloud/issue/${ticketKey}`;
          }
        }

        const finalTitle = title || `Ticket ${ticketKey}`;
        const finalJiraStatus = trackerStatus || 'To Do';
        const finalInternalStatus = internalStatus || status || finalJiraStatus || 'To Pick Up';
        const finalDueDate = parseYouTrackDueDate(dueDate);
        const finalNotes = notes || `Added on ${formatToday()}`;
        const finalTag = (payload.tag && payload.tag.toLowerCase().includes('support')) ? 'Support' : 'Product';

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
              range: `${memberTab}!A1:I100`
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

            let memberDueDate = finalDueDate;
            if ((!memberDueDate || memberDueDate === 'Not set') && existingMemberIdx > 0 && memberRows[existingMemberIdx][7] && memberRows[existingMemberIdx][7] !== 'Not set') {
              memberDueDate = memberRows[existingMemberIdx][7];
            }

            const rowData = [
              targetIdx,
              ticketKey,
              ticketUrl,
              finalTitle,
              finalJiraStatus,
              memberStatus,
              memberNotes,
              memberDueDate,
              finalTag
            ];

            await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
              spreadsheet_id: SPREADSHEET_ID,
              valueInputOption: 'USER_ENTERED',
              data: [{
                range: `${memberTab}!A${targetRowNum}:I${targetRowNum}`,
                majorDimension: 'ROWS',
                values: [rowData]
              }]
            });

            const jCol = STATUS_COLORS[finalJiraStatus] || STATUS_COLORS['To Pick Up'];
            const iCol = STATUS_COLORS[memberStatus] || STATUS_COLORS['To Pick Up'];
            const tagCol = finalTag === 'Support'
              ? { bg: '#fef3c7', text: '#92400e' }
              : { bg: '#e0e7ff', text: '#3730a3' };

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
              },
              {
                tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
                arguments: {
                  spreadsheet_id: SPREADSHEET_ID,
                  sheet_name: memberTab,
                  range: `I${targetRowNum}`,
                  background_color: tagCol.bg,
                  text_color: tagCol.text,
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
            tag: finalTag,
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
              const maxOldCols = Math.max(9, (rows[0] && rows[0].length) || 9, ...newRows.map(r => (r ? r.length : 0)));
              const oldEndLetter = colIndexToLetter(maxOldCols - 1);
              const paddedNewRows = [...newRows];
              while (paddedNewRows.length < oldLength) {
                paddedNewRows.push(new Array(maxOldCols).fill(''));
              }
              const normalizedNewRows = paddedNewRows.map(r => {
                const copy = [...r];
                while (copy.length < maxOldCols) copy.push('');
                return copy.slice(0, maxOldCols);
              });
              sheetData[oldTab] = newRows;
              removeBatch.push({
                range: `${oldTab}!A1:${oldEndLetter}${normalizedNewRows.length}`,
                majorDimension: 'ROWS',
                values: normalizedNewRows
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

        let rowDueDate = finalDueDate;
        if ((!rowDueDate || rowDueDate === 'Not set') && isExisting && currentRows[existingIdx][7] && currentRows[existingIdx][7] !== 'Not set') {
          rowDueDate = currentRows[existingIdx][7];
        }

        let newRow;
        if (tabName === 'PLAN') {
          // Schema for PLAN: [S.No., Epic, Task, Region, Effort, Dependency / Remarks, Internal Status, Due Date, Tag]
          newRow = [
            targetIndexStr,
            (payload.epic || '').trim(),
            finalTitle,
            (payload.region || '').trim(),
            (payload.effort || '').trim(),
            (payload.notes || payload.remarks || payload.dependency || '').trim(),
            finalInternalStatus || 'Planned',
            rowDueDate || 'Not set',
            finalTag
          ];
        } else {
          newRow = [
            targetIndexStr,
            ticketKey,
            ticketUrl,
            finalTitle,
            finalJiraStatus,
            finalInternalStatus,
            finalNotes,
            rowDueDate,
            finalTag
          ];
        }

        // 2. Write / update row to Google Sheets
        const maxColIdx = Math.max(8, newRow.length - 1);
        const endLetter = colIndexToLetter(maxColIdx);
        const writeRange = `${tabName}!A${targetRowNum}:${endLetter}${targetRowNum}`;
        await executeComposioTool('GOOGLESHEETS_UPDATE_VALUES_BATCH', {
          spreadsheet_id: SPREADSHEET_ID,
          valueInputOption: 'USER_ENTERED',
          data: [{
            range: writeRange,
            majorDimension: 'ROWS',
            values: [newRow]
          }]
        });

        // 3. Format cells
        const tagCol = finalTag === 'Support'
          ? { bg: '#fef3c7', text: '#92400e' }
          : { bg: '#e0e7ff', text: '#3730a3' };

        const formatBatch = [
          {
            tool_slug: 'GOOGLESHEETS_FORMAT_CELL',
            arguments: {
              spreadsheet_id: SPREADSHEET_ID,
              sheet_name: tabName,
              range: `I${targetRowNum}`,
              background_color: tagCol.bg,
              text_color: tagCol.text,
              bold: true,
              horizontal_alignment: 'CENTER'
            }
          }
        ];

        if (tabName !== 'PLAN') {
          const jCol = STATUS_COLORS[finalJiraStatus] || STATUS_COLORS['To Pick Up'];
          const iCol = STATUS_COLORS[finalInternalStatus] || STATUS_COLORS['To Pick Up'];
          formatBatch.unshift(
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
          );
        }

        await executeComposioBatch(formatBatch).catch(() => {});

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
