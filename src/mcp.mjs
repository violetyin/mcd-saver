// 零依赖 MCP Streamable HTTP 客户端（Node 18+，内置 fetch）
// 只做三件事：initialize 握手、tools/call、把结果解析成 JS 对象
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(file = '.env') {
  const p = path.resolve(file);
  const out = { ...process.env };
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

/**
 * 麦当劳 MCP 的 text 结果是「markdown 说明 + JSON 正文」拼起来的，
 * 不能直接 JSON.parse。这里从第一个可能的 '{' 开始做括号配对扫描。
 */
export function extractJson(text) {
  try { return JSON.parse(text); } catch { /* 继续找 */ }
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(text.slice(i, j + 1));
            if (obj && typeof obj === 'object' && ('success' in obj || 'data' in obj)) return obj;
          } catch { /* 这段不是合法 JSON，换个起点 */ }
          break;
        }
      }
    }
  }
  return null;
}

/** 从 SSE 或 JSON 响应体里取出 JSON-RPC 消息 */
function parseBody(text, contentType) {
  if (contentType && contentType.includes('text/event-stream')) {
    const msgs = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try { msgs.push(JSON.parse(data)); } catch { /* 忽略心跳 */ }
    }
    return msgs[msgs.length - 1] || null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

export class McpClient {
  constructor({ url, token, name = 'mcd-saver', version = '0.1.0' }) {
    this.url = url;
    this.token = token;
    this.name = name;
    this.version = version;
    this.sessionId = null;
    this.nextId = 1;
    this.calls = 0;
  }

  get headers() {
    const h = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async rpc(method, params) {
    const body = { jsonrpc: '2.0', id: this.nextId++, method };
    if (params !== undefined) body.params = params;

    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetch(this.url, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(body),
        });
      } catch (err) {
        // 连接被掐断 / 代理抖动：退避后重试，演示现场不能一次抖动就挂
        if (attempt === 3) throw new Error(`网络请求失败（已重试 3 次）：${err.message}`);
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const text = await res.text();

      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
      }
      const msg = parseBody(text, res.headers.get('content-type'));
      if (msg && msg.error) {
        throw new Error(`MCP error ${msg.error.code}: ${JSON.stringify(msg.error.data ?? msg.error.message)}`);
      }
      return msg?.result ?? null;
    }
    throw new Error('请求被限流，重试 3 次仍失败（429）');
  }

  async init() {
    const r = await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: this.name, version: this.version },
    });
    // 按协议补一条 initialized 通知（通知无 id，失败不影响后续调用）
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
    } catch { /* ignore */ }
    return r;
  }

  /**
   * 调用工具，返回已经解除 MCP 包装的业务对象。
   * MCP 返回形如 { content: [{ type:'text', text:'{json}' }] }
   */
  async call(tool, args = {}) {
    this.calls += 1;
    const result = await this.rpc('tools/call', { name: tool, arguments: args });
    if (!result) return null;
    const text = (result.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (result.isError) throw new Error(`${tool} 调用失败: ${text.slice(0, 300)}`);
    if (!text) return result;
    const parsed = extractJson(text);
    return parsed ?? text; // 纯 markdown 结果（活动日历等）原样返回
  }
}
