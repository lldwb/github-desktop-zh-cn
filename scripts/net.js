// scripts/net.js — 零依赖 HTTP(S) 客户端（仅 Node 内置模块）
// 用途：取远程字典（文本）、GitHub API（JSON）、Release 产物（二进制流式落盘）。
//
// 代理：**自动读系统配置**——环境变量优先，其次 Windows 注册表 / macOS scutil 的系统代理。
// 国内直连 GitHub 能通但慢到不可用（实测 15 KB/s，下 293 MB 的产物要 5 个多小时；同一份
// 走代理 593 KB/s、约 8 分钟），所以这不是锦上添花而是可用性前提。零依赖下自己实现 CONNECT
// 隧道（见 connectViaProxy）；代理不可用时**回退直连**，不让一个配坏的代理把工具彻底断网。
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');

const UA = 'github-desktop-zh-cn';
const DEFAULT_TIMEOUT = 20000; // 单次 socket 空闲超时；有大块传输时不会触发
const MAX_REDIRECTS = 5;

const ERROR_HINTS = {
  ENOTFOUND: '无法解析域名（请检查网络连接）',
  EAI_AGAIN: 'DNS 解析超时（请检查网络连接）',
  ECONNREFUSED: '连接被拒绝（可能被防火墙拦截）',
  ECONNRESET: '连接被重置',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
};

// 把底层网络错误换成可读中文，保留 cause 供排查
function describe(e, url) {
  const hint = ERROR_HINTS[e.code];
  if (!hint) return e;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* 非法 URL 时保留原串 */
  }
  const err = new Error(`${hint}：${host}`);
  err.cause = e;
  return err;
}

// —— 代理：系统配置读取 + CONNECT 隧道 ——
// 解析只在首次请求时做一次并缓存：读注册表 / 跑 scutil 都是同步子进程，不该出现在热路径上。
let _proxyResolved = false;
let _proxy = null; // { host, port, source }
let _proxyBroken = null; // 代理试过且不通时的说明；置上后本次进程内不再尝试

// 把各种写法归一成 { host, port }：http://127.0.0.1:7890 / 127.0.0.1:7890 / user:pass@host:port
function parseProxy(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // 去 scheme
  s = s.replace(/\/.*$/, ''); // 去路径
  const at = s.lastIndexOf('@'); // 带认证的写法，认证部分这里用不上
  if (at >= 0) s = s.slice(at + 1);
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) || /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  return { host: m[1], port: Number(m[2] || 80) };
}

// Windows：注册表 Internet Settings。ProxyServer 可能是 "host:port"，也可能是
// "http=host:port;https=host:port" 的分协议写法——后者取 https 那段，没有再退回 http。
function windowsProxy() {
  const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const query = (name) => execFileSync('reg', ['query', KEY, '/v', name], { encoding: 'utf8', timeout: 5000 });
  if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(query('ProxyEnable'))) return null;
  const m = /ProxyServer\s+REG_SZ\s+(.+)/.exec(query('ProxyServer'));
  if (!m) return null;
  const value = m[1].trim();
  if (!value.includes('=')) return parseProxy(value);
  const parts = new Map(
    value.split(';').map((kv) => {
      const i = kv.indexOf('=');
      return i < 0 ? ['', kv.trim()] : [kv.slice(0, i).trim().toLowerCase(), kv.slice(i + 1).trim()];
    })
  );
  return parseProxy(parts.get('https') || parts.get('http') || '');
}

// macOS：`scutil --proxy` 形如 "HTTPSProxy : 127.0.0.1" / "HTTPSPort : 7890" / "HTTPSEnable : 1"
function macProxy() {
  const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 5000 });
  const pick = (k) => {
    const m = new RegExp(`${k}\\s*:\\s*(.+)`).exec(out);
    return m ? m[1].trim() : '';
  };
  if (pick('HTTPSEnable') !== '1') return null;
  return parseProxy(`${pick('HTTPSProxy')}:${pick('HTTPSPort') || 443}`);
}

// 当前生效的代理：环境变量优先（几乎所有工具都认这套），其次各平台的系统代理。
// Linux 没有系统级标准，只用环境变量。
function detectProxy() {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const hit = parseProxy(process.env[name]);
    if (hit) return { ...hit, source: `环境变量 ${name}` };
  }
  try {
    if (process.platform === 'win32') {
      const hit = windowsProxy();
      if (hit) return { ...hit, source: 'Windows 系统代理' };
    } else if (process.platform === 'darwin') {
      const hit = macProxy();
      if (hit) return { ...hit, source: 'macOS 系统代理' };
    }
  } catch {
    /* 读不到系统代理不算错误：直连即可 */
  }
  return null;
}

// NO_PROXY：`*` 全放过；域名按「相等或以点开头」匹配（与 curl 的宽松口径一致）
function bypassed(hostname) {
  const raw = process.env.NO_PROXY || process.env.no_proxy;
  if (!raw) return false;
  const host = hostname.toLowerCase();
  for (const item of raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (item === '*') return true;
    const bare = item.replace(/^\./, '');
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

// 当前请求该不该走代理；null 表示直连
function proxyFor(target) {
  if (_proxyBroken) return null;
  if (!_proxyResolved) {
    _proxy = detectProxy();
    _proxyResolved = true;
  }
  if (!_proxy || bypassed(target.hostname)) return null;
  return _proxy;
}

// 与代理建一条到目标主机的 CONNECT 隧道，返回裸 socket。
// target 既接受 URL 对象（hostname）也接受 Agent 传来的 options（host）。
function connectViaProxy(proxy, target, timeout) {
  const host = target.hostname || target.host;
  const port = target.port || 443;
  const authority = `${host}:${port}`;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, 'user-agent': UA },
      timeout,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 ${proxy.host}:${proxy.port} 拒绝建立隧道（HTTP ${res.statusCode}）`));
        return;
      }
      resolve(socket);
    });
    req.on('error', (e) => reject(describe(e, `http://${proxy.host}:${proxy.port}`)));
    req.setTimeout(timeout, () => req.destroy(new Error(`与代理 ${proxy.host}:${proxy.port} 建连超时`)));
    req.end();
  });
}

// 在 CONNECT 隧道上完成 TLS 的 Agent。
//
// 为什么必须是 Agent、不能给 request 传 createConnection：ClientRequest 拿到自定义
// createConnection 返回的 socket 后**不等 TLS 握手完成**就开始写请求头——实测那份数据以
// **明文**发到了 443 端口，GitHub 回 301（重定向到自己的 https:// 版本），于是钻进
// 重定向循环（`#0 301 github.com -> github.com` …）。走 Agent 的
// createConnection(options, cb) 这套契约，才能在 secureConnect 之后再放行。
function tunnelAgent(proxy, timeout) {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = (options, cb) => {
    connectViaProxy(proxy, options, timeout).then(
      (raw) => {
        const socket = tls.connect({ socket: raw, servername: options.host });
        socket.once('secureConnect', () => cb(null, socket));
        socket.once('error', cb);
      },
      (err) => cb(err)
    );
  };
  return agent;
}

// 代理不可用时回退直连，并**记住**这件事——每次请求都去撞一遍坏代理，只会让所有联网操作
// 都白等一轮超时。记一次、在 stderr 说一次（GUI 里看不到 stderr，但打包产物会留下日志），
// 后续请求直接直连。
function markProxyBroken(proxy, e) {
  if (_proxyBroken) return;
  _proxyBroken = `${proxy.source} 的代理 ${proxy.host}:${proxy.port} 不可用（${e.message}），已回退直连`;
  try {
    process.stderr.write(`[net] ${_proxyBroken}\n`);
  } catch {
    /* 没有 stderr 时忽略 */
  }
}


// 发一次请求并拿到响应对象（不含重定向跟随与状态码判定——那些在 openStream 里收口）。
// 单独抽出来是为了让「代理失败 → 摘掉 agent → 直连重试」这条回退路径能复用同一份参数。
function requestOnce(mod, reqOpts, timeout, url, body) {
  return new Promise((resolve, reject) => {
    const req = mod.request(reqOpts, resolve);
    req.on('error', (e) => reject(describe(e, url)));
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`请求超时（${timeout / 1000} 秒无响应）：${url}`));
    });
    req.end(body);
  });
}

// 发起请求，把 2xx 的响应流交给调用方；重定向、非 2xx、超时、网络错误与代理隧道都在这里收口。
// rawStatus 为真时不因非 2xx 而拒绝——AI 接口把出错原因写在响应体里，读不到就没法诊断。
async function openStream(url, opts, redirects) {
  const target = new URL(url);
  const mod = target.protocol === 'http:' ? http : https;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;

  const reqOpts = {
    method: opts.method || 'GET',
    hostname: target.hostname,
    port: target.port || undefined,
    path: target.pathname + target.search,
    headers: { 'user-agent': UA, ...(opts.headers || {}) },
  };

  // 代理：https 走 CONNECT 隧道 + 隧道上的 TLS（见 tunnelAgent）；http 走绝对 URI 的经典写法。
  const proxy = proxyFor(target);
  if (proxy && target.protocol === 'https:') {
    reqOpts.agent = tunnelAgent(proxy, timeout);
  } else if (proxy) {
    reqOpts.path = url;
    reqOpts.hostname = proxy.host;
    reqOpts.port = proxy.port;
    reqOpts.headers.host = target.host;
  }

  let res;
  try {
    res = await requestOnce(mod, reqOpts, timeout, url, opts.body);
  } catch (e) {
    // 代理是第一嫌疑：隧道建不起来、代理拒绝连接，都走这条。回退直连再试一次——
    // 配坏的代理不该让工具彻底断网（直连本来就通，只是慢）。
    if (!proxy || !reqOpts.agent) throw e;
    markProxyBroken(proxy, e);
    delete reqOpts.agent;
    res = await requestOnce(mod, reqOpts, timeout, url, opts.body);
  }

  const status = res.statusCode;
  const location = res.headers.location;
  if (status >= 300 && status < 400 && location) {
    res.resume();
    if (redirects >= MAX_REDIRECTS) throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次：${url}`);
    return openStream(new URL(location, url).toString(), opts, redirects + 1);
  }
  if (!opts.rawStatus && (status < 200 || status >= 300)) {
    res.resume();
    throw new Error(`HTTP ${status}：${url}`);
  }
  return res;
}

// 把响应体读进内存，超过 maxBytes 立刻掐断（AI 接口的响应是 JSON，几 MB 足够）
async function readBody(res, url, limit) {
  const chunks = [];
  let received = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      received += c.length;
      if (received > limit) {
        res.destroy(new Error(`响应体超过 ${limit} 字节上限：${url}`));
        return;
      }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', (e) => reject(describe(e, url)));
  });
  return Buffer.concat(chunks).toString('utf8');
}

// GET 到内存，连同状态码与响应头一起返回。Range 请求要靠状态码区分 206（服务端真按区间
// 返回）与 200（忽略了 Range，把整个文件送了回来）—— 后者必须由调用方发现并中止。
// maxBytes 是配套的保险丝：响应体一旦超限立刻掐断连接，免得 250 MB 的产物被整包读进来。
async function getRaw(url, opts = {}) {
  const res = await openStream(url, opts, 0);
  const total = Number(res.headers['content-length'] || 0);
  const limit = opts.maxBytes || 0;
  if (opts.onProgress) opts.onProgress(0, total);
  const chunks = [];
  let received = 0;
  let aborted = false;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      if (aborted) return;
      received += c.length;
      if (limit && received > limit) {
        aborted = true;
        chunks.length = 0;
        res.destroy(new Error(`响应体超过 ${limit} 字节上限（HTTP ${res.statusCode}）：${url}`));
        return;
      }
      chunks.push(c);
      if (opts.onProgress) opts.onProgress(received, total);
    });
    res.on('end', resolve);
    res.on('error', (e) => reject(describe(e, url)));
  });
  return { status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) };
}

// GET 到内存：文本默认，binary 为真时返回 Buffer（字典、API 响应用这个）
async function get(url, opts = {}) {
  const { buffer } = await getRaw(url, opts);
  return opts.binary ? buffer : buffer.toString('utf8');
}

// HEAD：只取状态与响应头，不读响应体。用于下载前探大小、探服务端是否支持 Range。
// 注意 GitHub Release 资产是 302 到另一台主机，节点上拿到的才是真正的 content-length。
async function head(url, opts = {}) {
  const res = await openStream(url, { ...opts, method: 'HEAD' }, 0);
  res.resume();
  return {
    status: res.statusCode,
    size: Number(res.headers['content-length'] || 0),
    acceptRanges: res.headers['accept-ranges'] || null,
  };
}

async function getJson(url, opts = {}) {
  const headers = { accept: 'application/vnd.github+json', ...(opts.headers || {}) };
  const text = await get(url, { ...opts, headers });
  return JSON.parse(text);
}

// POST JSON 并把响应解析成 JSON（AI 兼容接口用）。非 2xx 不在这里抛——
// 报错详情在响应体里，交给调用方读到之后再决定怎么报。
// 默认 4 MB 上限：翻译响应是纯 JSON，正常几十 KB；超了说明对面回的不是预期内容。
async function postJson(url, body, opts = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const res = await openStream(
    url,
    {
      ...opts,
      method: 'POST',
      body: payload,
      rawStatus: true,
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...(opts.headers || {}),
      },
    },
    0
  );
  const text = await readBody(res, url, opts.maxBytes || 4 * 1024 * 1024);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON（HTTP ${res.statusCode}）：${text.slice(0, 200)}`);
  }
  return { status: res.statusCode, data };
}

// 流式下载到文件：产物可达上百 MB，不进内存；先写 .part 再改名，避免半成品被当成成品
async function download(url, destPath, opts = {}) {
  const res = await openStream(url, opts, 0);
  const total = Number(res.headers['content-length'] || 0);
  const part = `${destPath}.part`;
  let received = 0;
  res.on('data', (c) => {
    received += c.length;
    if (opts.onProgress) opts.onProgress(received, total);
  });
  if (opts.onProgress) opts.onProgress(0, total);
  try {
    await pipeline(res, fs.createWriteStream(part));
    fs.renameSync(part, destPath);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw describe(e, url);
  }
  return { bytes: received, total };
}

module.exports = { get, getRaw, getJson, postJson, head, download, UA };
