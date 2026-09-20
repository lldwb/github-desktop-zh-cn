// gui/ipc/versions.js — 版本切换组：切换目标版本 / 列可下载版本 / 下载并安装
// 「切换版本」写的是 config 的 resourcesPath（与「选择」同一字段，SSOT 是 common.setTargetVersion），
// 此后汉化 / 还原 / 更新管控 / 字典表格全都跟着它走，这里不另立一套目标解析。
'use strict';

const common = require('../../scripts/common.js');
const patch = require('../../scripts/cmd/patch.js');
const installer = require('../../scripts/cmd/install-version.js');

module.exports = function createVersionHandlers(ctx) {
  const { ask, confirmed, notifyBusy, withBusy } = ctx;

  return {
    // 切换要处理的 GitHub Desktop 版本。本机可能并存多个（官方升级后旧的 app-<版本> 目录会留着），
    // 选中的那个写进 config 的 resourcesPath——与「选择」按钮同一个字段，所以此后汉化 / 还原 /
    // 更新管控 / 字典表格全都跟着走，这里不另立一套目标解析。
    // 默认连「禁止自动更新」一起做：版本是使用者自己挑的，不该被官方更新悄悄换走。
    setVersion: async (version) => {
      const hit = common.listInstalledVersions().find((x) => x.version === version);
      if (!hit) return { ok: false, error: `本机没有 ${version} 的安装目录，请点「选择」手动指定。` };

      const cur = common.resolveTarget();
      // 选中的就是当前目标（列表里那一项本来就标着「当前」且点不动）：不必弹框，直接当作取消
      if (!cur.error && cur.app.resourcesDir === hit.resourcesDir) return { ok: false, canceled: true };

      const blocked = common.getPatchGroups(version).includes('updateControl');
      return confirmed({
        askOptions: {
          buttons: ['切换', '取消'],
          defaultId: 0,
          cancelId: 1,
          message: `切换到 GitHub Desktop ${version}`,
          detail:
            `之后的汉化 / 还原 / 更新管控都作用于：\n${hit.resourcesDir}\n\n`
            + '「禁止自动更新」会把该版本钉住——版本是你选定的，就不该被官方更新悄悄换走。',
          checkboxLabel: blocked ? '禁止自动更新（该版本已开启，不会重复注入）' : '同时禁止该版本自动更新',
          checkboxChecked: true,
        },
        // 忙碌消息只在真要注入更新管控时发（见下），故不由骨架包
        task: null,
        run: async (choice) => {
          common.setTargetVersion(version); // 与 CLI 菜单的「切换版本」走同一个入口（SSOT 在 common.js）
          const notes = [`已切换到 GitHub Desktop ${version}。`];
          let hasError = false;
          let restarted = 'skipped';

          if (choice.checkboxChecked && !blocked) {
            try {
              // patch 会顺带跑一遍汉化（i18n 是它的主体）——对已汉化的版本是幂等的重复替换，
              // 对没汉化的版本则正好把它汉化掉，两者都是「切过去就能用」的意思。
              const r = await withBusy(
                'setVersion',
                `正在为 ${version} 注入更新管控 …`,
                () => patch.run({ explicitPath: hit.resourcesDir, version, quiet: true, updateControl: 'off' })
              );
              restarted = r.restarted;
              notes.push('已禁止该版本自动更新。');
            } catch (e) {
              notes.push(`禁止自动更新失败：${e.message}`);
              hasError = true;
            }
          }
          return { ok: true, version, notes, hasError, restarted };
        },
      });
    },

    // 可下载的版本（官方 Release）。只在「切换版本」窗口打开时取一次——进工具就联网会拖慢启动。
    // 本机已装的不列在这里（它们在「本机已安装」那一组）。
    downloadable: async () => {
      try {
        const r = await installer.listDownloadable();
        return {
          ok: true,
          platform: r.platform,
          installable: r.installable,
          versions: r.versions.filter((v) => !v.installed),
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    // 下载并安装一个本机没有的版本，装完切过去——与 CLI 菜单 4) 里的 d) 同一套（都走 installer）。
    // 会往官方安装根写一个新目录（与现有版本并存），故确认框里把体积与后果说清楚。
    installVersion: async (version) => {
      if (process.platform !== 'win32') {
        return { ok: false, error: '在线安装目前只支持 Windows，请到 GitHub Releases 手动下载本平台安装包。' };
      }
      const choice = await ask({
        buttons: ['下载并安装', '取消'],
        defaultId: 0,
        cancelId: 1,
        message: `下载并安装 GitHub Desktop ${version}`,
        detail:
          '安装包约 300 MB，装到与官方安装相同的位置——与现有版本**并存**，不会替换它们。\n'
          + '国内直连较慢，下载会自动走系统代理（若已配置）。',
      });
      if (choice.response !== 0) return { ok: false, canceled: true };

      const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
      return withBusy('installVersion', `正在准备 ${version} …`, async () => {
        await installer.install(version, {
          log: () => notifyBusy('installVersion', `正在解压 ${version} …`),
          onProgress: (got, total) => {
            const pct = total ? Math.round((got / total) * 100) : 0;
            const of = total ? ` / ${mb(total)}` : '';
            notifyBusy('installVersion', `正在下载 ${version} … ${pct}%（${mb(got)}${of}）`);
          },
        });
        notifyBusy('installVersion', `正在切换到 ${version} …`);
        common.setTargetVersion(version);
        return {
          ok: true,
          version,
          notes: [`已安装 GitHub Desktop ${version} 并切换过去。`],
          restarted: 'skipped',
        };
      });
    },
  };
};
