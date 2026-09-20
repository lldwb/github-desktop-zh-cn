// gui/ipc/patching.js — 汉化还原组：汉化 / 还原 / 同步字典
// 三个动作都作用于「当前目标」（config 里的 resourcesPath，否则自动探测），共用 main.js 提供的
// 目标解析与「确认框 + notifyBusy + run」骨架；业务一行不重写，全部调 scripts/ 下的既有模块。
'use strict';

const common = require('../../scripts/common.js');
const patch = require('../../scripts/cmd/patch.js');
const restore = require('../../scripts/cmd/restore.js');
const dictSync = require('../../scripts/dict/dict-sync.js');

module.exports = function createPatchingHandlers(ctx) {
  const { confirmed, requireTarget, withBusy } = ctx;

  return {
    patch: async () => {
      const t = requireTarget();
      if (t.error) return t.error;
      const { target, version } = t;

      // 本地（含内嵌）没有对应字典时不中止：交给 patch 联网取，取不到再报错（与 CLI 一致）
      const local = common.listDictVersions().includes(version);
      const tip = local ? '' : `（本地无 ${version} 字典，将联网获取）`;
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

    // 同步字典（原「检查更新」里的一半，现在独立）：拉当前版本的最新字典覆盖本地。
    // 只在用户主动点的时候走——汉化时本地缺字典由 patch 自己联网取，那条路不受影响；
    // 这里的语义是「强制拉最新」，与 CLI 菜单的「同步字典」同一套（都走 dict-sync.syncLatest）。
    syncDict: async () => {
      const t = requireTarget();
      if (t.error) return t.error;
      const { version } = t;

      return withBusy('syncDict', `正在同步 ${version} 字典 …`, async () => {
        try {
          const r = await dictSync.syncLatest(version);
          return { ok: true, notes: [r.changed ? `字典已更新：${version}` : `字典已是最新（${version}）。`] };
        } catch (e) {
          return { ok: false, error: `更新字典失败：${e.message}` };
        }
      });
    },
  };
};
