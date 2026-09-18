// scripts/net.js — 零依赖 HTTP(S) 客户端（仅 Node 内置模块）
// 用途：取远程字典（文本）、GitHub API（JSON）、Release 产物（二进制流式落盘）。
//
// 已知限制：不支持 HTTP 代理。零依赖约束下实现 CONNECT 隧道成本过高，
// 需要代理的环境会走到 describe() 给出的可读提示，而不是堆栈。
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
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

// 发起请求，把 2xx 的响应流交给调用方；重定向、非 2xx、超时、网络错误都在这里收口
function openStream(url, opts, redirects) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'http:' ? http : https;
    const timeout = opts.timeout || DEFAULT_TIMEOUT;

    const req = mod.request(
      {
        method: opts.method || 'GET',
        hostname: target.hostname,
        port: target.port || undefined,
        path: target.pathname + target.search,
        headers: { 'user-agent': UA, ...(opts.headers || {}) },
      },
      (res) => {
        const status = res.statusCode;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error(`重定向次数超过 ${MAX_REDIRECTS} 次：${url}`));
            return;
          }
          resolve(openStream(new URL(location, url).toString(), opts, redirects + 1));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status}：${url}`));
          return;
        }
        resolve(res);
      }
    );

    req.on('error', (e) => reject(describe(e, url)));
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`请求超时（${timeout / 1000} 秒无响应）：${url}`));
    });
    req.end();
  });
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

module.exports = { get, getRaw, getJson, head, download, UA };
