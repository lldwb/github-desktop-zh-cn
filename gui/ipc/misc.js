// gui/ipc/misc.js — 杂项组：状态 / 字典表格 / 翻译提示词 / 选择安装位置 / 打开项目地址
// 都是「只读或选路径」这类不套「确认框 + notifyBusy」骨架的动作。返回结构由渲染进程直接渲染，
// 字段全部取自既有 common API，不新增业务判定；写盘路径一律走 common 的 dataRoot()。
'use strict';

const path = require('path');
const { dialog, shell } = require('electron');

const common = require('../../scripts/common.js');
const dictPrompt = require('../../scripts/dict/dict-prompt.js');
const PKG = require('../../package.json');

// 「关于」窗口里那两条可点击链接（渲染进程拿不到地址，只能按 openUrl 的键名来点）。
// 地址本身取自 common.repoUrls()——与 CLI 菜单展示的是同一份。
const URLS = common.repoUrls();

// 界面上显示的「安装根」：Windows 是 …\GitHubDesktop（app-<版本> 的上一级），macOS 是 .app 包，
// Linux 是安装目录本身。仅用于展示，不参与任何写盘路径计算（写盘一律走 common 的 dataRoot()）。
function installRoot(resourcesDir) {
  if (process.platform === 'darwin') return path.resolve(resourcesDir, '..', '..');
  const parent = path.dirname(resourcesDir);
  return /^app-/.test(path.basename(parent)) ? path.dirname(parent) : parent;
}

// 「切换版本」窗口的数据源：本机已安装的 GitHub Desktop——Windows 上可能不止一个
// （官方升级后旧的 app-<版本> 目录会留着）。`hasDict` 决定它出不出现在默认视图
// （「只显示有汉化的版本」），`custom` 标记「不在自动探测范围内、由「选择」手动指定」的目录。
// 当前目标若不在已安装列表里（用「选择」指到了别处），补一条出来——否则列表里没有它，
// 就看不出来「现在正在用的是哪个」。
function installedForPicker(target, dictVersions) {
  const list = common.listInstalledVersions().map((x) => ({
    version: x.version,
    resourcesDir: x.resourcesDir,
    hasDict: dictVersions.includes(x.version),
    current: false,
    custom: false,
  }));
  if (!target.error) {
    const cur = target.app;
    const hit = list.find((x) => x.resourcesDir === cur.resourcesDir);
    if (hit) {
      hit.current = true;
    } else {
      list.push({
        version: cur.version,
        resourcesDir: cur.resourcesDir,
        hasDict: dictVersions.includes(cur.version),
        current: true,
        custom: true,
      });
    }
  }
  return list.sort((a, b) => common.compareVersions(a.version, b.version));
}

// 窗口状态：安装位置、版本、字典、是否已汉化、备份。字段全部取自既有 common API，不新增业务判定。
function collectState() {
  const target = common.resolveTarget();
  const versions = common.listDictVersions();
  const base = {
    ok: !target.error,
    error: target.error || null,
    toolVersion: PKG.version,
    platform: process.platform,
    dataRoot: common.dataRoot(),
    // 「关于」窗口要展示的项目信息（地址由主进程给，渲染进程不硬编码仓库地址）
    license: PKG.license,
    repoUrl: URLS.repo,
    mirrorUrl: URLS.mirror,
    dictVersions: versions,
    installed: installedForPicker(target, versions),
  };
  if (target.error) return base;

  const { app: found } = target;
  const version = found.version;
  const matched = versions.includes(version);
  const dict = { version, matched, count: null, source: null, error: null };
  if (matched) {
    try {
      dict.count = common.loadDict(version).size;
      dict.source = common.dictLabel(version);
    } catch (e) {
      dict.error = e.message;
    }
  }
  return {
    ...base,
    resourcesDir: found.resourcesDir,
    appDir: found.appDir,
    rootDir: installRoot(found.resourcesDir),
    version,
    dict,
    patched: common.isPatched(found.appDir, version),
    hasBackup: common.backupExists(version),
    backupPath: common.backupDir(version),
  };
}

// 字典表格的数据源。「类型」列只从键推导（design.md 的规则），不扫描产物：
//   全局键 → main.js / renderer.js（两个文件都生效）；作用域键 → 该文件名；整模板键额外加「模板 · 」前缀
// 「组名」列取自字典的 groups 段（dict-groups.js 推断，仅作核对参考、不参与替换），
// 段里没有的条目落「待分组」。
function collectDictEntries() {
  const target = common.resolveTarget();
  if (target.error) return { ok: false, error: target.error, rows: [] };

  const version = target.app.version;
  if (!common.listDictVersions().includes(version)) {
    return { ok: false, version, error: `本地无 ${version} 对应字典`, rows: [] };
  }
  let entries;
  let groupOf;
  try {
    entries = common.loadDict(version);
    groupOf = common.loadGroups(version);
  } catch (e) {
    return { ok: false, version, error: e.message, rows: [] };
  }
  const rows = [];
  for (const [k, v] of entries) {
    const { file, key } = common.splitScopedKey(k);
    const scope = file || 'main.js / renderer.js';
    rows.push({
      en: key,
      zh: v,
      // 用原样键 k 反查：groups 段存的就是字典键本身，剥掉作用域前缀反而查不到
      group: groupOf.get(k) || common.UNGROUPED,
      type: key.startsWith('`') ? `模板 · ${scope}` : scope,
    });
  }
  return { ok: true, version, count: rows.length, rows };
}

module.exports = function createMiscHandlers(ctx) {
  const { getWindow } = ctx;

  return {
    state: async () => collectState(),

    dictEntries: async () => collectDictEntries(),

    // 翻译提示词（只读展示）：与实际调模型用的是**同一个字符串**——dict-prompt.js 是唯一来源，
    // 展示的就是生效的那份，不存在「界面上写的和实际跑的不一样」。
    prompt: async () => ({ ok: true, text: dictPrompt.SYSTEM_PROMPT }),

    pickPath: async () => {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: '选择 GitHub Desktop 的 resources 目录',
        buttonLabel: '选择此目录',
        properties: ['openDirectory'],
        message:
          process.platform === 'win32'
            ? '例：C:\\Users\\<用户名>\\AppData\\Local\\GitHubDesktop\\app-3.6.6\\resources'
            : '例：/Applications/GitHub Desktop.app/Contents/Resources',
      });
      if (r.canceled || !r.filePaths.length) return collectState();

      // 多选到上一层是常事（选中 app-<版本> 或安装根），再往下试一层 resources 即可命中
      const picked = r.filePaths[0];
      let found = null;
      let lastError = null;
      for (const candidate of [picked, path.join(picked, 'resources')]) {
        try {
          found = common.locateApp({ explicitPath: candidate });
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (!found) return { ...collectState(), ok: false, error: `无效的目录——${lastError.message}` };

      common.writeConfig({ resourcesPath: found.resourcesDir });
      return collectState();
    },

    // 打开项目地址。入参是**白名单键**而不是 URL——渲染进程给不出任意链接，
    // shell.openExternal 就不会成为「界面上点什么都会去开」的跳板。
    openUrl: async (which) => {
      const url = { repo: URLS.repo, mirror: URLS.mirror }[which];
      if (!url) return { ok: false, error: `未知的地址：${which}` };
      await shell.openExternal(url);
      return { ok: true, url };
    },
  };
};
