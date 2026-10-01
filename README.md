# ResumeForge — 从零实现的简历排版产品

共享经历/项目/教育实体，多个内容分支（一页版、详细版）**只做选择不复制事实**；
后端负责多版式真实渲染与度量；PostgreSQL 保存内容分支、字段级可见性与导出记录。

## 需求对照

| 需求 | 实现位置 |
|---|---|
| Vue 表单共享经历/项目/教育实体 | `web/src/App.vue`、`web/src/components/EntityForm.vue` |
| 后端多版式渲染 | `server/src/render/templates.js`（版本化模板注册表） |
| PG 保存分支/可见字段/导出记录 | `server/src/db/schema.sql`、`server/src/db/pg-store.js`（生产）；`memory-store.js`（同语义，本地/测试） |
| 一页版/详细版可选不同条目，共同字段更新可追踪 | `entities.version` + `branches.items[]` 选择模型；更新返回 `changed/prevVersion`（乐观锁 409） |
| 不为塞进一页静默删事实 | 取舍动作只有 hideField / setDetailLevel / deselectItem / switchTemplate / allowPages；事实永不删除，仅改可见性/选择 |
| 长链接、混合字体、段落保护影响高度 | `server/src/render/fonts.js`（回退链）、`layout.js`（URL break-all、CJK 换行、keep-with-first-line、段落跨页流） |
| 输出超限给出可执行取舍由用户选择 | `domain/measure.js#planTradeoffs`（含每个动作预计节省 pt） |
| 隐私字段按导出用途选择 | `domain/privacy.js`（internal/apply_trusted/apply_public/share_link） |
| 分享链接只返回快照允许内容、不藏 JSON | `domain/shares.js`：存储前过滤；读取时再按**当前**隐私规则过滤（撤销即时生效） |
| 前端分页预测 vs 服务端真实度量、差异提示 | `web/src/lib/layout-client.js` ↔ `server/src/render/layout.js`；`/measure` 返回 `clientDiff` |
| 版本锁定 | 首次成功导出锁定 `templateKey@version`，模板升级后默认仍用锁定版，旧版模板永不删除 |
| 缺字回退 | Helvetica/Times/Courier (WinAnsi) → STSong-Light (Type0/UniGB-UCS2-H) → `?` + `GLYPH_MISSING` 警告 |
| 两设备改同一经历 | 实体 `expectedVersion` 乐观锁，冲突 409，刷新合并重试 |
| 撤销公开手机号 | 字段用途规则更新后，旧分享链接立即失权（测试 3） |
| 旧任务迟到 | `render_jobs` CAS：queued→running→done/failed/superseded，旧版本任务作废、不覆盖（测试 4） |
| PDF 写入失败、文件保持可读 | `writePdfAtomic`：tmp + rename；失败清理 tmp，旧目标文件字节不变（测试 5） |
| 更新模板后恢复认可排版 | 版本化注册表 + `templates_locked`（测试 6） |

## 运行

```bash
# 后端（默认内存库，零依赖启动）
npm install
npm run dev:server            # http://localhost:4000

# PostgreSQL 生产模式
USE_PG=1 DATABASE_URL=postgres://user:pass@localhost:5432/resumeforge node server/src/index.js
# schema 在首次连接时自动幂等执行（server/src/db/schema.sql）

# 前端
npm run web:install
npm run web:dev               # http://localhost:5173 （/api 代理到 4000）
```

## 测试

```bash
npm test
```

覆盖：缺字回退、两设备并发编辑、撤销手机号与旧链接、旧任务迟到、PDF 写入失败原子性、
模板版本锁定恢复、溢出取舍与长链接换行（共 11 个用例）。

## 关键设计

- **事实与视图分离**：`entities` 是唯一事实源（带 version）；`branches.items` 是有序选择列表。
  从一页版移除条目不触碰事实，详细版与事实库保留。
- **服务端是度量唯一真相**：PDF 与 API 使用同一个确定性排版引擎（pt 单位、自带 AFM 平均字宽），
  浏览器预测器只用于即时反馈；二者不一致时 UI 明确提示并以服务端为准。
- **PDF**：无第三方依赖的 PDF 1.4 生成器，支持多 Base-14 字体 + 一个 Type0 CID 中文字体，
  ToUnicode 仅嵌入文档实际用到的 CJK 码位（复制/可读）。
