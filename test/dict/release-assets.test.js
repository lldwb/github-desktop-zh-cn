// extractLocal 的单元测试。
//
// 为什么这一段值得单测：它决定了「下载并安装某个版本」铺出来的目录对不对——前缀剥错一层、
// 把 NuGet 元数据也铺进去、或者漏掉必需文件，产出的就是一份看着像装好了、实际起不来的目录，
// 而这类问题只在真机点开应用时才暴露。
//
// 离线可跑：夹具是现造的 zip（不联网），临时目录用 mkdtemp，不碰仓库里的任何目录。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ra = require('../../scripts/dict/release-assets.js');

// 最小 zip 生成器（全部 store、不压缩）：本地头 + 中央目录 + EOCD。
// 为什么不手写几个字节的 fixture 文件：条目名与内容要能按用例参数化，生成比硬编码清楚。
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(f.content, 'utf8');
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

// 每个用例一个独立临时目录；返回 { zipPath, outDir, cleanup }
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghd-extract-'));
  const zipPath = path.join(dir, 'pkg.nupkg');
  fs.writeFileSync(zipPath, makeZip(files));
  return {
    zipPath,
    outDir: path.join(dir, 'out'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// 官方 nupkg 的真实形态：应用文件在 lib/net45/ 下，另有一堆 NuGet 元数据
const NUPKG_FILES = [
  { name: 'lib/net45/GitHubDesktop.exe', content: 'MZ-fake' },
  { name: 'lib/net45/resources.pak', content: 'pak-data' },
  { name: 'lib/net45/locales/zh-CN.pak', content: 'locale-data' },
  { name: 'lib/net45/resources/app/main.js', content: "require('./renderer')" },
  { name: 'lib/net45/resources/app/renderer.js', content: 'console.log(1)' },
  { name: 'lib/net45/resources/app/package.json', content: '{"name":"github-desktop"}' },
  { name: '[Content_Types].xml', content: '<Types/>' },
  { name: '_rels/.rels', content: '<Relationships/>' },
  { name: 'GitHubDesktop.nuspec', content: '<package/>' },
  { name: 'package/services/metadata/core-properties/a.psmdcp', content: '<core/>' },
];

test('extractLocal：剥掉前缀、只铺应用文件、内容逐字节一致', () => {
  const f = fixture(NUPKG_FILES);
  try {
    const r = ra.extractLocal(f.zipPath, { prefix: 'lib/net45/', outDir: f.outDir });
    assert.strictEqual(r.written, 6, '应只铺 lib/net45/ 下的 6 个文件');
    assert.strictEqual(r.skipped, 4, 'NuGet 元数据应被跳过');

    // 铺出来的目录形态 = app-<版本>/（三个必需文件正是 locateApp 认得的那三个）
    for (const rel of ['GitHubDesktop.exe', 'resources.pak', 'locales/zh-CN.pak',
      'resources/app/main.js', 'resources/app/renderer.js', 'resources/app/package.json']) {
      assert.ok(fs.existsSync(path.join(f.outDir, rel)), `缺 ${rel}`);
    }
    // 元数据一个都不该落地
    for (const rel of ['[Content_Types].xml', '_rels/.rels', 'GitHubDesktop.nuspec']) {
      assert.ok(!fs.existsSync(path.join(f.outDir, rel)), `${rel} 不该被铺出来`);
    }
    // 内容正确（解压不是只把文件建出来）
    assert.strictEqual(fs.readFileSync(path.join(f.outDir, 'resources/app/main.js'), 'utf8'), "require('./renderer')");
  } finally {
    f.cleanup();
  }
});

test('extractLocal：前缀不匹配时一个都不铺（不静默铺错层）', () => {
  const f = fixture(NUPKG_FILES);
  try {
    const r = ra.extractLocal(f.zipPath, { prefix: 'lib/net48/', outDir: f.outDir });
    assert.strictEqual(r.written, 0, '前缀对不上就该什么都不铺');
    assert.strictEqual(r.skipped, NUPKG_FILES.length);
    assert.ok(!fs.existsSync(f.outDir) || fs.readdirSync(f.outDir).length === 0);
  } finally {
    f.cleanup();
  }
});

test('extractLocal：不是 zip 时报错而不是铺出空目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghd-extract-'));
  try {
    const bad = path.join(dir, 'not-a-zip.nupkg');
    fs.writeFileSync(bad, 'this is not a zip at all');
    assert.throws(
      () => ra.extractLocal(bad, { prefix: 'lib/net45/', outDir: path.join(dir, 'out') }),
      /不是有效的 zip/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
