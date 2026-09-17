// gui/renderer.js — 界面逻辑
// 这里没有 Node 能力：一切数据与动作都经 window.api（preload.js 暴露的 IPC 通道）。
// 本文件只负责渲染与交互，不含任何替换/备份规则。
'use strict';

const els = {
  patch: document.getElementById('btn-patch'),
  restore: document.getElementById('btn-restore'),
  pick: document.getElementById('btn-pick'),
  update: document.getElementById('btn-update'),
  refresh: document.getElementById('btn-refresh'),
  tabLabel: document.getElementById('tab-label'),
  search: document.getElementById('search'),
  body: document.getElementById('dict-body'),
  empty: document.getElementById('table-empty'),
  rootPath: document.getElementById('root-path'),
  progress: document.getElementById('progress'),
  progressText: document.getElementById('progress-text'),
  statusbar: document.getElementById('statusbar'),
  toast: document.getElementById('toast'),
};

const BUTTONS = [els.patch, els.restore, els.pick, els.update, els.refresh];

let rows = []; // 全部字典条目（搜索在内存里过滤，不重新读盘）
let emptyHint = ''; // 字典读不到时的原因，显示在表格空态里
let pending = false; // 有操作在跑：按钮全部禁用，避免并发改同一份文件
let toastTimer = null;

// —— 界面状态 ——
function setPhase(text) {
  els.progress.classList.toggle('busy', !!text);
  els.progressText.textContent = text || '空闲';
}

function setPending(value) {
  pending = value;
  for (const b of BUTTONS) b.disabled = value;
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

function renderRows(list) {
  const frag = document.createDocumentFragment();
  for (const r of list) {
    const tr = document.createElement('tr');
    for (const [cls, text] of [['col-en', r.en], ['col-zh', r.zh], ['col-type', r.type]]) {
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
  const list = needle
    ? rows.filter((r) => r.en.toLowerCase().includes(needle) || r.zh.toLowerCase().includes(needle))
    : rows;

  renderRows(list);
  els.tabLabel.textContent = rows.length
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

async function doUpdate() {
  await withPending('正在检查更新', async () => {
    const r = await window.api.update();
    if (!r.ok) return showError(r);
    showToast(r.notes.join('\n'), !!r.hasError);
  });
}

// —— 绑定 ——
els.patch.addEventListener('click', doPatch);
els.restore.addEventListener('click', doRestore);
els.pick.addEventListener('click', doPick);
els.update.addEventListener('click', doUpdate);
els.refresh.addEventListener('click', () => withPending('正在刷新', async () => {}));

// 1862 条逐个过滤有开销，等输入停下来再算
let filterTimer = null;
els.search.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyFilter, 120);
});

// 主进程推送的阶段文字（如「正在同步 3.6.6 字典 …」）；task 为 null 即回到空闲
window.api.onBusy(({ task, phase }) => setPhase(task ? phase : null));

refresh().catch((e) => showToast(`初始化失败：${e.message || e}`, true));
