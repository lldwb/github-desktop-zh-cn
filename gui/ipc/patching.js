// gui/ipc/patching.js — 汉化还原组：汉化 / 还原 / 同步字典
// 三个动作都作用于「当前目标」（config 里的 resourcesPath，否则自动探测），共用 main.js 提供的
// 目标解析与「确认框 + notifyBusy + run」骨架；业务一行不重写，全部调 scripts/ 下的既有模块。
'use strict';

const common = require('../../scripts/common.js');
const versionProfile = require('../../scripts/version-profile.js');
const patch = require('../../scripts/cmd/patch.js');
const restore = require('../../scripts/cmd/restore.js');
const dictSync = require('../../scripts/dict/dict-sync.js');

module.exports = function createPatchingHandlers(ctx) {
  const { confirmed, requireTarget, withBusy } = ctx;

  // 本地成对状态 → 确认框里的一句提示。成对完整（字典 + 替换逻辑档案都在）时不提示；
  // 缺哪份就说哪份——「只有字典、缺档案」是老用户数据根最常见的情形，不能笼统说成「本地无字典」。
  function localTip(version) {
    const pair = versionProfile.pairStatus(version);
    if (pair.paired) return '';
    const missing = [];
    if (!pair.dict) missing.push('字典');
    if (!pair.profile) missing.push('替换逻辑档案');
    return `（本地缺${missing.join('与')}，将联网成对获取；也可在「关于」里点「同步字典」）`;
  }

  return {
    patch: async () => {
      const t = requireTarget();
      if (t.error) return t.error;
      const { target, version } = t;

      // 本地不成对时不中止：交给 patch 联网成对获取（字典 + 档案都要），取不到再报错（与 CLI 一致）
      const tip = localTip(version);
      return confirmed({
        askOptions: {
          buttons: ['开始汉化', '取消'],
          defaultId: 0,
          cancelId: 1,
          message: `即将汉化 GitHub Desktop ${version}${tip}`,
          detail: '原文件会先自动备份，之后随时可以还原。汉化完成会重启 GitHub Desktop。',
        },
        task: 'patch',
        phase: `正在汉化 ${version} …`,
        run: async () => {
          const r = await patch.run({ explicitPath: target.explicitPath, version, quiet: true });
          return { ok: true, version, total: r.total, restarted: r.restarted };
        },
      });
    },

    restore: async () => {
      const t = requireTarget();
      if (t.error) return t.error;
      const { target, version } = t;

      // 没有备份也能还原：按字典逆向替换（中文 → 英文），只是少数词形可能与官方略有差异
      const tip = common.backupExists(version) ? '（从备份精确还原）' : '（没有备份，将按字典还原为英文）';
      return confirmed({
        askOptions: {
          buttons: ['开始还原', '取消'],
          defaultId: 0,
          cancelId: 1,
          message: `即将把 GitHub Desktop ${version} 还原为官方原版${tip}`,
          detail: '还原完成会重启 GitHub Desktop。',
        },
        task: 'restore',
        phase: `正在还原 ${version} …`,
        run: async () => {
          const r = await restore.run({ explicitPath: target.explicitPath, version, quiet: true });
          return {
            ok: true,
            version,
            source: r.source,
            total: r.total,
            ambiguous: r.ambiguous,
            skipped: r.skipped,
            restarted: r.restarted,
          };
        },
      });
    },

    // 同步字典与替换逻辑档案（成对）：拉当前版本的最新资源覆盖本地。只在用户主动点的时候走——
    // 汉化时本地缺资源由 patch 自己联网成对取，那条路不受影响；这里的语义是「强制拉最新」，
    // 与 CLI 菜单的「同步字典」同一套（都走 dict-sync.syncLatest）。
    syncDict: async () => {
      const t = requireTarget();
      if (t.error) return t.error;
      const { version } = t;

      return withBusy('syncDict', `正在同步 ${version} 字典与替换逻辑档案 …`, async () => {
        try {
          const r = await dictSync.syncLatest(version);
          return {
            ok: true,
            notes: [
              r.changed
                ? `字典与替换逻辑档案已更新：${version}`
                : `字典与替换逻辑档案已是最新（${version}）。`,
            ],
          };
        } catch (e) {
          return { ok: false, error: `同步字典与替换逻辑档案失败：${e.message}` };
        }
      });
    },
  };
};
