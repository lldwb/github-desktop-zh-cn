// tools/ops/lib.js — 探针共享的 GitHub API 取数（本目录唯一的联网处）
//
// 本目录原先各探针自己抄了一份 `https.get` 的取数函数：重复、且不走 net.js（没有代理支持——
// 国内直连 GitHub 慢到不可用，见 AGENTS.md「在线能力」一节）。现统一收敛到这里，底层用
// `scripts/net.js`：它是全仓唯一的发请求入口（自带代理探测与 CONNECT 隧道、超时、重定向）。
// **传输路径换了、取回的内容与各探针的输出格式不变**（重构契约 §3 表 8 的预期内变化）。
//
// 两个形态，按调用方要不要看状态码分：
//   get(path)     → { status, headers, text }：**非 2xx 不抛**——GitHub 把错误说明写在正文里
//                  （404 → {"message":"Not Found"}），要按 status 判定的探针自己看；
//   getJson(path) → 解析后的值；解析失败按 `HTTP <状态码>：<正文前 200 字符>` 抛错。
'use strict';

const net = require('../../scripts/net.js');

// GitHub API 主机：本目录只此一处。仓库前缀（/repos/<owner>/<repo>）仍由各探针用
// `scripts/common.js` 的 GH_OWNER / GH_REPO 拼。
const API = 'https://api.github.com';

async function get(path) {
  const { status, headers, buffer } = await net.getRaw(`${API}${path}`, {
    rawStatus: true,
    headers: { accept: 'application/vnd.github+json' },
  });
  return { status, headers, text: buffer.toString('utf8') };
}

async function getJson(path) {
  const { status, text } = await get(path);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${status}：${text.slice(0, 200)}`);
  }
}

module.exports = { get, getJson };
