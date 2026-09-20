// gui/renderer.js — 界面逻辑
// 这里没有 Node 能力：一切数据与动作都经 window.api（preload.js 暴露的 IPC 通道）。
// 本文件只负责渲染与交互，不含任何替换/备份规则。
'use strict';

const els = {
  patch: document.getElementById('btn-patch'),
  restore: document.getElementById('btn-restore'),
  pick: document.getElementById('btn-pick'),
  updateControl: document.getElementById('btn-update-control'),
  versionSelect: document.getElementById('version-select'),
  versionAll: document.getElementById('version-all'),
  refresh: document.getElementById('btn-refresh'),
  about: document.getElementById('btn-about'),
  tabs: document.querySelectorAll('.tab'),
  panels: {
    'panel-dict': document.getElementById('panel-dict'),
    'panel-prompt': document.getElementById('panel-prompt'),
  },
  aboutModal: document.getElementById('about'),
  aboutClose: document.getElementById('btn-about-close'),
  aboutVersion: document.getElementById('about-version'),
  aboutRepo: document.getElementById('about-repo'),
  aboutMirror: document.getElementById('about-mirror'),
  aboutLicense: document.getElementById('about-license'),
  aboutDataRoot: document.getElementById('about-dataroot'),
  checkUpdate: document.getElementById('btn-check-update'),
  syncDict: document.getElementById('btn-sync-dict'),
  tabDict: document.getElementById('tab-dict'),
  search: document.getElementById('search'),
  body: document.getElementById('dict-body'),
  empty: document.getElementById('table-empty'),
  promptText: document.getElementById('prompt-text'),
  rootPath: document.getElementById('root-path'),
  progress: document.getElementById('progress'),
  progressText: document.getElementById('progress-text'),
  statusbar: document.getElementById('statusbar'),
  toast: document.getElementById('toast'),
};

// 有操作在跑时统一禁用的控件（「关于」的打开/关闭不在此列：看信息不该被挡）
const BUSY_DISABLED = [
  els.patch, els.restore, els.pick, els.updateControl, els.refresh,
  els.versionSelect, els.versionAll, els.checkUpdate, els.syncDict,
];

let rows = []; // 全部字典条目（搜索在内存里过滤，不重新读盘）
let emptyHint = ''; // 字典读不到时的原因，显示在表格空态里
let pending = false; // 有操作在跑：按钮全部禁用，避免并发改同一份文件
let toastTimer = null;
let promptLoaded = false; // 提示词是静态内容，读一次就够

// —— 界面状态 ——
function setPhase(text) {
  els.progress.classList.toggle('busy', !!text);
  els.progressText.textContent = text || '空闲';
}

function setPending(value) {
  pending = value;
  for (const el of BUSY_DISABLED) el.disabled = value;
  // 下拉在「本机一个版本都没有」时本来就该禁用，解除 pended 时按数据重新判一次
  if (!value && els.versionSelect.options.length === 0) els.versionSelect.disabled = true;
}

function showToast(text, isError) {
  els.toast.textContent = text;
  els.toast.classList.toggle('error', !!isError);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, isError ? 9000 : 4500);
}

// —— 标签页 ——
async function showTab(panelId) {
  for (const t of els.tabs) t.classList.toggle('active', t.dataset.panel === panelId);
  for (const [id, el] of Object.entries(els.panels)) el.hidden = id !== panelId;
  if (panelId === 'panel-prompt' && !promptLoaded) await loadPrompt();
}

async function loadPrompt() {
  promptLoaded = true;
  try {
    const r = await window.api.prompt();
    els.promptText.textContent = r.ok ? r.text : `读取失败：${r.error || '未知原因'}`;
  } catch (e) {
    promptLoaded = false; // 读失败允许下次切回来重试
    els.promptText.textContent = `读取失败：${e.message || e}`;
  }
}

// —— 渲染 ——
function renderState(state) {
  if (!state.ok) {
    els.rootPath.textContent = '—';
    els.statusbar.classList.add('warn');
    els.statusbar.textContent = `未识别到 GitHub Desktop（${state.error}）请点击「选择」指定安装位置。`;
    return;
  }
  els.rootPath.textContent = state.rootDir;
  els.statusbar.classList.remove('warn');
  const parts = [`已识别：${state.rootDir}`, `版本 ${state.version}`];
  if (state.dict.matched) {
    parts.push(`字典 ${state.dict.count} 条`);
  } else {
    const others = state.dictVersions.length ? `（现有 ${state.dictVersions.join(' / ')}）` : '';
    parts.push(`无 ${state.version} 对应字典${others}`);
  }
  parts.push(state.patched ? '已汉化' : '未汉化');
  parts.push(state.hasBackup ? '有备份' : '无备份');
  els.statusbar.textContent = parts.join(' · ');
}

// 版本下拉：默认只列**有汉化**（有字典）的版本，勾「全部」才连没字典的一起列。
// 当前正在处理的那个恒在列——否则切换中或选了没字典的版本时，下拉会没有选中项。
function renderVersions(state) {
  const all = state.installed || [];
  const list = els.versionAll.checked ? all : all.filter((x) => x.hasDict || x.current);

  els.versionSelect.replaceChildren(
    ...list.map((x) => {
      const opt = document.createElement('option');
      opt.value = x.version;
      opt.textContent = x.custom ? `${x.version}（自定义）` : x.hasDict ? x.version : `${x.version}（无字典）`;
      opt.selected = !!x.current;
      return opt;
    })
  );
  // 一个都列不出来（本机没装 GitHub Desktop）时给个占位项，下拉不至于空着
  if (!list.length) {
    const opt = document.createElement('option');
    opt.textContent = all.length ? '（勾「全部」查看）' : '未找到 GitHub Desktop';
    opt.disabled = true;
    opt.selected = true;
    els.versionSelect.appendChild(opt);
    els.versionSelect.disabled = true;
  }
}

function renderAbout(state) {
  els.aboutVersion.textContent = `v${state.toolVersion}`;
  els.aboutLicense.textContent = state.license || '—';
  els.aboutDataRoot.textContent = state.dataRoot || '—';
  els.aboutRepo.textContent = state.repoUrl || '—';
  els.aboutMirror.textContent = state.mirrorUrl || '—';
}

function renderRows(list) {
  const frag = document.createDocumentFragment();
  for (const r of list) {
    const tr = document.createElement('tr');
    // 列顺序与 index.html 的表头一致：英文 / 中文 / 组名 / 类型
    for (const [cls, text] of [
      ['col-en', r.en],
      ['col-zh', r.zh],
      ['col-group', r.group],
      ['col-type', r.type],
    ]) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text; // 一律 textContent：字典内容不会被当成 HTML 解析
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  els.body.replaceChildren(frag);
}

function applyFilter() {
  const query = els.search.value.trim();
  const needle = query.toLowerCase();
  // 组名一并参与匹配：组名列的用途就是按界面区域定位，搜「菜单」「设置」应当能筛出整组
  const list = needle
    ? rows.filter(
        (r) =>
          r.en.toLowerCase().includes(needle) ||
          r.zh.toLowerCase().includes(needle) ||
          r.group.toLowerCase().includes(needle)
      )
    : rows;

  renderRows(list);
  els.tabDict.textContent = rows.length
    ? `汉化字典 (${list.length}${needle ? ` / ${rows.length}` : ''})`
    : '汉化字典';

  if (list.length) {
    els.empty.hidden = true;
  } else {
    els.empty.hidden = false;
    els.empty.textContent = needle ? `没有匹配「${query}」的条目` : emptyHint || '字典为空';
  }
}

// —— 数据 ——
async function refresh() {
  const state = await window.api.state();
  renderState(state);
  renderVersions(state);
  renderAbout(state);

  const dict = await window.api.dictEntries();
  rows = dict.ok ? dict.rows : [];
  emptyHint = dict.ok ? '' : dict.error || '字典不可用';
  applyFilter();
  return state;
}

// 所有操作共用的外壳：禁用按钮 → 显示阶段文字 → 执行 → 回到空闲 → 重读状态
async function withPending(phase, action) {
  if (pending) return;
  setPending(true);
  setPhase(`${phase} …`);
  try {
    await action();
  } catch (e) {
    showToast(`操作失败：${e.message || e}`, true);
  } finally {
    setPending(false);
    setPhase(null);
    try {
      await refresh();
    } catch (e) {
      showToast(`刷新状态失败：${e.message || e}`, true);
    }
  }
}

// 重启结果的一句话说明（与 cli.js 同一套文案）
function restartLine(restarted) {
  return restarted === 'restarted'
    ? ' 已重启 GitHub Desktop，现在看到的就是新界面。'
    : ' 启动 GitHub Desktop 即可看到效果。';
}

function showError(r) {
  showToast(r.hint ? `${r.error}\n${r.hint}` : r.error || '操作失败', true);
}

// 多行结果 + 重启说明：notes 各占一行，重启那句接在末尾
function notesWithRestart(r) {
  const parts = [...(r.notes || [])];
  if (r.restarted !== undefined && r.restarted !== null) parts.push(restartLine(r.restarted).trim());
  return parts.join('\n');
}

async function doPatch() {
  await withPending('正在汉化', async () => {
    const r = await window.api.patch();
    if (r.canceled) return;
    if (!r.ok) return showError(r);
    showToast(`汉化完成：命中 ${r.total} 处。${restartLine(r.restarted)}`);
  });
}

async function doRestore() {
  await withPending('正在还原', async () => {
    const r = await window.api.restore();
    if (r.canceled) return;
    if (!r.ok) return showError(r);

    let text =
      r.source === 'backup' ? '还原完成：已从备份精确还原。' : `还原完成：已按字典还原 ${r.total} 处。`;
    if (r.source === 'reverse' && (r.ambiguous > 0 || r.skipped > 0)) {
      const parts = [];
      if (r.ambiguous > 0) parts.push(`${r.ambiguous} 条译文有多个英文写法`);
      if (r.skipped > 0) parts.push(`${r.skipped} 条译文是空格/标点等通用文本，保持原样`);
      text += `\n注：${parts.join('；')}，个别词形可能与官方略有差异。`;
    }
    showToast(text + restartLine(r.restarted));
  });
}

async function doPick() {
  await withPending('正在切换安装位置', async () => {
    const r = await window.api.pickPath();
    if (!r.ok && r.error) showError(r);
  });
}

// 切换版本：确认框在主进程弹（含「同时禁止该版本自动更新」的勾选），这里只发起与展示
async function doSetVersion() {
  const version = els.versionSelect.value;
  if (!version) return;
  await withPending('正在切换版本', async () => {
    const r = await window.api.setVersion(version);
    if (!r.ok) return r.canceled ? undefined : showError(r);
    showToast(notesWithRestart(r), !!r.hasError);
  });
}

// 模式选择在主进程的对话框里做（渲染进程拿不到参数），这里只负责发起与展示结果
async function doUpdateControl() {
  await withPending('正在设置更新管控', async () => {
    const r = await window.api.updateControl();
    if (!r.ok) return r.canceled ? undefined : showError(r);
    showToast(notesWithRestart(r));
  });
}

// 「关于」里的两个动作：检查更新只查工具自身，字典同步单独走
async function doCheckUpdate() {
  await withPending('正在检查更新', async () => {
    const r = await window.api.checkToolUpdate();
    if (!r.ok) return showError(r);
    showToast(r.notes.join('\n'), !!r.hasError);
  });
}

async function doSyncDict() {
  await withPending('正在同步字典', async () => {
    const r = await window.api.syncDict();
    if (!r.ok) return showError(r);
    showToast(r.notes.join('\n'));
  });
}

// —— 关于窗口 ——
function openAbout() {
  els.aboutModal.hidden = false;
}

function closeAbout() {
  els.aboutModal.hidden = true;
}

// —— 绑定 ——
els.patch.addEventListener('click', doPatch);
els.restore.addEventListener('click', doRestore);
els.pick.addEventListener('click', doPick);
els.updateControl.addEventListener('click', doUpdateControl);
els.refresh.addEventListener('click', () => withPending('正在刷新', async () => {}));
els.versionSelect.addEventListener('change', doSetVersion);
// 勾「全部」只改列表范围：重新渲染一次，不动目标版本
els.versionAll.addEventListener('change', async () => {
  try {
    renderVersions(await window.api.state());
  } catch (e) {
    showToast(`刷新版本列表失败：${e.message || e}`, true);
  }
});

for (const t of els.tabs) t.addEventListener('click', () => showTab(t.dataset.panel));

els.about.addEventListener('click', openAbout);
els.aboutClose.addEventListener('click', closeAbout);
// 点遮罩关闭（点对话框内部不该关）
els.aboutModal.addEventListener('click', (ev) => {
  if (ev.target === els.aboutModal) closeAbout();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !els.aboutModal.hidden) closeAbout();
});

for (const [el, which] of [
  [els.aboutRepo, 'repo'],
  [els.aboutMirror, 'mirror'],
]) {
  el.addEventListener('click', async (ev) => {
    ev.preventDefault();
    const r = await window.api.openUrl(which);
    if (!r.ok) showToast(r.error || '打开链接失败', true);
  });
}

els.checkUpdate.addEventListener('click', doCheckUpdate);
els.syncDict.addEventListener('click', doSyncDict);

// 1862 条逐个过滤有开销，等输入停下来再算
let filterTimer = null;
els.search.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyFilter, 120);
});

// 主进程推送的阶段文字（如「正在同步 3.6.6 字典 …」）；task 为 null 即回到空闲
window.api.onBusy(({ task, phase }) => setPhase(task ? phase : null));

// 启动后主进程自动检查到新版本时才推（无新版不推）：提示一句就够，不打断用户手上的事——
// 想装的时候点「关于」里的「检查更新」，那边会弹确认框问要不要下载。
window.api.onToolUpdate((info) => {
  showToast(`发现新版本 v${info.latest}（当前 v${info.current}）——点「关于」里的「检查更新」可下载安装。`);
});

refresh().catch((e) => showToast(`初始化失败：${e.message || e}`, true));
