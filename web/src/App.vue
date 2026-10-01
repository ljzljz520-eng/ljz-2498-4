<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { api } from './lib/api.js';
import { predictLayout, setClientFontBias } from './lib/layout-client.js';
import EntityForm from './components/EntityForm.vue';
import PreviewPane from './components/PreviewPane.vue';
import TradeoffPanel from './components/TradeoffPanel.vue';

const PURPOSES = [
  { key: 'internal', label: '自用' },
  { key: 'apply_trusted', label: '投递-可信' },
  { key: 'apply_public', label: '投递-公开' },
  { key: 'share_link', label: '分享链接' },
];

const resume = ref(null);
const entities = ref([]);
const branches = ref([]);
const privacy = ref([]);
const activeBranch = ref('onepage');
const purpose = ref('apply_public');
const templates = ref([]);
const measure = ref(null);
const prediction = ref(null);
const exportPurpose = ref('apply_public');
const shareUrl = ref('');
const exportRecords = ref([]);
const fontBias = ref(0);
const busy = ref(false);
const notice = reactive({ kind: '', text: '' });
const measureSeq = ref(0);

const branch = computed(() => branches.value.find((b) => b.key === activeBranch.value));
const selectedIds = computed(() => new Set((branch.value?.items || []).map((i) => i.id)));
const onepageIds = computed(() => new Set((branches.value.find((b) => b.key === 'onepage')?.items || []).map((i) => i.id)));
const detailedIds = computed(() => new Set((branches.value.find((b) => b.key === 'detailed')?.items || []).map((i) => i.id)));

const groups = computed(() => ({
  experience: entities.value.filter((e) => e.kind === 'experience'),
  project: entities.value.filter((e) => e.kind === 'project'),
  education: entities.value.filter((e) => e.kind === 'education'),
}));

onMounted(async () => {
  const t = await api.templates();
  templates.value = t.templates;
  let id = location.hash.slice(1);
  if (!id) {
    const r = await api.createResume({ profile: { name: '张三', email: 'zhangsan@example.com', phone: '138 0000 0000', site: 'https://zhangsan.dev' } });
    id = r.resume.id;
    location.hash = id;
    await seed(id);
  }
  await load(id);
});

async function seed(id) {
  await api.saveEntity(id, { kind: 'experience', fields: { role: '资深前端工程师', company: '云杉科技', summary: '负责简历排版内核的设计与落地，统一服务端真实度量与前端分页预测，主导多模板版本锁定方案。推动设计与工程协作，交付被广泛复用的排版组件库，覆盖混合字体、段落保护与长链接换行。' } });
  await api.saveEntity(id, { kind: 'experience', fields: { role: '前端工程师', company: '长河网络', summary: '参与数据可视化平台建设，维护大规模表格与导出模块。' } });
  await api.saveEntity(id, { kind: 'project', fields: { name: 'ResumeForge', url: 'https://github.com/example/resumeforge/blob/main/packages/render/src/layout-engine.ts?ref=abc123#paragraph-protection', description: '多版式简历渲染引擎：版本化模板、隐私快照、原子 PDF 写入。' } });
  await api.saveEntity(id, { kind: 'education', fields: { school: '某某大学', degree: '计算机科学与技术 · 本科' } });
  const all = (await api.getResume(id)).entities;
  for (const e of all) {
    await api.setItem(id, 'onepage', { entityId: e.id, kind: e.kind, selected: true });
  }
  // phone defaults: internal + trusted only
  await api.setPrivacy(id, 'profile.phone', ['internal', 'apply_trusted']);
}

async function load(id) {
  const data = await api.getResume(id);
  resume.value = data.resume;
  entities.value = data.entities;
  branches.value = data.branches;
  privacy.value = data.privacy;
  exportRecords.value = (await api.listExports(id)).exports;
  await runMeasure();
}

function selectedTemplate() {
  const b = branch.value;
  const locked = measure.value ? null : null;
  return measure.value?.templateKey || 'classic';
}

async function runMeasure() {
  if (!resume.value) return;
  const seq = ++measureSeq.value;
  const blocks = buildBlocksForPrediction();
  const pred = predictLayout(blocks, { ...(branch.value?.page || {}), margin: activeBranch.value === 'onepage' ? 40 : 40 });
  prediction.value = pred;
  try {
    const m = await api.measure(resume.value.id, activeBranch.value, {
      purpose: purpose.value,
      clientPrediction: pred,
    });
    if (seq !== measureSeq.value) return; // stale response, ignore
    measure.value = m;
  } catch (e) {
    notice.kind = 'err'; notice.text = '度量失败: ' + e.message;
  }
}

// Approximate the classic template blocks for client prediction (same shapes the server uses).
function buildBlocksForPrediction() {
  const p = resume.value?.profile || {};
  const blocks = [];
  blocks.push({ type: 'heading', text: p.name || '', style: { fontSize: 15 } });
  blocks.push({ type: 'text', runs: [{ text: [p.email, p.phone, p.site].filter(Boolean).join(' · ') }], style: { fontSize: 9 } });
  const sections = [['Experience', 'experience', (e) => e.fields.role], ['Projects', 'project'], ['Education', 'education']];
  for (const [title, kind] of sections) {
    const list = entities.value.filter((e) => e.kind === kind && selectedIds.value.has(e.id));
    if (!list.length) continue;
    blocks.push({ type: 'spacer', h: 6 });
    blocks.push({ type: 'heading', text: title });
    blocks.push({ type: 'rule' });
    for (const e of list) {
      blocks.push({ type: 'item', blocks: [
        { type: 'text', text: [e.fields.role || e.fields.name || e.fields.school, e.fields.company].filter(Boolean).join(' · '), style: { fontSize: 10, bold: true } },
        { type: 'text', text: e.fields.summary || e.fields.description || '', style: { fontSize: 9.5 } },
        ...(e.fields.url ? [{ type: 'text', text: e.fields.url, style: { fontSize: 8.5, family: 'Courier' } }] : []),
      ] });
    }
  }
  return blocks;
}

watch([activeBranch, purpose, fontBias], () => { setClientFontBias(fontBias.value); runMeasure(); });
watch(entities, () => runMeasure(), { deep: true });
watch(branches, () => runMeasure(), { deep: true });

async function saveProfileField(key, value) {
  resume.value.profile[key] = value;
  await api.updateProfile(resume.value.id, { ...resume.value.profile });
  await runMeasure();
}

async function onEntitySaved(entity) {
  await load(resume.value.id);
  notice.kind = entity.version > 1 ? 'ok' : '';
  notice.text = entity.version > 1 ? `已保存：共享事实更新到 v${entity.version}，所有包含该条目的版式均可追踪到新版本` : '';
}

async function toggleItem(entity, selected) {
  const expectedVersion = branch.value.version;
  try {
    await api.setItem(resume.value.id, activeBranch.value, {
      entityId: entity.id, kind: entity.kind, selected, expectedVersion,
    });
    await load(resume.value.id);
  } catch (e) {
    if (e.status === 409) {
      notice.kind = 'err';
      notice.text = '该版式刚在另一设备被修改（版本冲突），已为你刷新；请确认后重试。';
      await load(resume.value.id);
    } else throw e;
  }
}

async function applyTradeoff(action) {
  if (action.kind === 'hideField') {
    const { entityId, field } = action.target;
    // privacy per purpose: hide for current export purpose (and weaker)
    const allowed = ['internal'];
    await api.setPrivacy(resume.value.id, `entities.${entityId}.${field}`, allowed);
  } else if (action.kind === 'deselectItem') {
    await api.setItem(resume.value.id, activeBranch.value, { entityId: action.target.itemId, selected: false });
  } else if (action.kind === 'setDetailLevel') {
    const b = branch.value;
    const items = b.items.map((i) => i.id === action.target.itemId ? { ...i, detailLevel: action.target.detailLevel } : i);
    await api.saveBranchItems(resume.value.id, activeBranch.value, items, b.version);
  } else if (action.kind === 'switchTemplate') {
    // only affects measurement preview template selection for demo
    notice.kind = 'ok'; notice.text = '可在导出时选择 compact 版式（条目全部保留）。';
  } else if (action.kind === 'allowPages') {
    // user explicitly accepts 2 pages: raise the page cap, keep every fact
    const b = branch.value;
    await api.updateBranch(resume.value.id, activeBranch.value,
      { page: { ...b.page, maxPages: action.target.maxPages } }, b.version);
    notice.kind = 'ok'; notice.text = `已接受 ${action.target.maxPages} 页输出；全部事实保留。`;
  }
  await load(resume.value.id);
}

async function doExport() {
  busy.value = true;
  try {
    const r = await api.export(resume.value.id, { branchKey: activeBranch.value, purpose: exportPurpose.value, format: 'pdf' });
    if (r.run.state === 'superseded') {
      notice.kind = 'warn'; notice.text = '检测到内容已变化，该导出任务已被作废，未覆盖任何结果。请重新导出。';
    } else if (r.export.status === 'failed') {
      notice.kind = 'err'; notice.text = '导出失败: ' + (r.export.error || '未知错误');
    } else {
      notice.kind = 'ok';
      notice.text = `导出成功（${r.export.templateKey}@${r.export.templateVer}，${r.export.byteSize} 字节）；该版式版本已锁定，模板升级后仍可恢复。`;
    }
    exportRecords.value = (await api.listExports(resume.value.id)).exports;
  } finally { busy.value = false; }
}

async function createShare() {
  const r = await api.createShare(resume.value.id, { branchKey: activeBranch.value });
  shareUrl.value = location.origin + r.share.url;
  notice.kind = 'ok'; notice.text = '分享链接已生成，仅含该用途允许的字段；撤销手机号权限会即时影响旧链接。';
}

async function revokeShare() {
  if (!shareUrl.value) return;
  const token = shareUrl.value.split('/').pop();
  await api.revokeShare(token);
  notice.kind = 'warn'; notice.text = '链接已吊销。';
  shareUrl.value = '';
}

function isAllowed(fieldPath) {
  const rules = privacy.value.filter((r) => r.fieldPath === fieldPath);
  if (!rules.length) return true;
  return rules[rules.length - 1].purposes.includes(purpose.value);
}

async function togglePrivacy(fieldPath, purp, on) {
  const rules = privacy.value.filter((r) => r.fieldPath === fieldPath);
  const current = rules.length ? rules[rules.length - 1].purposes : PURPOSES.map((p) => p.key);
  const next = on ? [...new Set([...current, purp])] : current.filter((x) => x !== purp);
  await api.setPrivacy(resume.value.id, fieldPath, next);
  await load(resume.value.id);
  if (!on && purp === 'share_link') notice.kind = 'warn', notice.text = '已撤销该字段的分享权限；所有既有分享链接立即不再返回它。';
}
</script>

<template>
  <div class="app">
    <!-- LEFT: shared facts -->
    <div class="panel">
      <h2>共享事实库 <span class="badge">{{ entities.length }} 条</span></h2>
      <div v-if="resume" class="card">
        <h3>个人信息</h3>
        <label>姓名</label><input :value="resume.profile.name" @change="(e) => saveProfileField('name', e.target.value)" />
        <label>邮箱</label><input :value="resume.profile.email" @change="(e) => saveProfileField('email', e.target.value)" />
        <label>手机号 <span :class="['badge', isAllowed('profile.phone') ? 'ok' : 'err']">{{ isAllowed('profile.phone') ? '当前用途可见' : '当前用途隐藏' }}</span></label>
        <input :value="resume.profile.phone" @change="(e) => saveProfileField('phone', e.target.value)" />
        <label>站点 / 长链接</label><input :value="resume.profile.site" @change="(e) => saveProfileField('site', e.target.value)" />
        <div class="purpose-pills" style="margin-top:6px">
          <span v-for="p in PURPOSES" :key="p.key">
            <span class="pill" :class="{ on: resume.profile.phone && (privacy.find(r=>r.fieldPath==='profile.phone')?.purposes || PURPOSES.map(x=>x.key)).includes(p.key) }"
              @click="togglePrivacy('profile.phone', p.key, !(privacy.find(r=>r.fieldPath==='profile.phone')?.purposes || PURPOSES.map(x=>x.key)).includes(p.key))">
              {{ p.label }}
            </span>
          </span>
        </div>
        <div class="muted" style="margin-top:4px">手机号可见用途（点击切换）</div>
      </div>

      <EntityForm v-for="g in ['experience','project','education']" :key="g"
        :kind="g" :entities="groups[g]" :resume-id="resume?.id"
        :selected-ids="selectedIds" :branch="activeBranch"
        @saved="onEntitySaved" />
    </div>

    <!-- CENTER: preview -->
    <div class="panel">
      <div class="tabs">
        <button v-for="b in branches" :key="b.key" :class="{ active: activeBranch === b.key }" @click="activeBranch = b.key">
          {{ b.name }} <span class="badge">{{ b.items.length }}</span>
        </button>
      </div>
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <div class="row">
          <span class="muted">导出用途</span>
          <select v-model="purpose" style="width:auto">
            <option v-for="p in PURPOSES" :key="p.key" :value="p.key">{{ p.label }}</option>
          </select>
        </div>
        <div class="row">
          <span class="muted">前端字宽偏差模拟</span>
          <input type="range" min="-10" max="20" v-model.number="fontBias" style="width:120px" />
          <span class="badge">{{ fontBias }}%</span>
        </div>
      </div>

      <div v-if="notice.text" :class="['banner', notice.kind]">{{ notice.text }}</div>

      <div v-if="measure?.clientDiff?.significant" class="banner warn">
        <strong>前端分页预测与服务端真实度量不一致：</strong>
        前端 {{ measure.clientDiff.clientPages }} 页 / {{ measure.clientDiff.clientHeight }}pt，
        服务端 {{ measure.clientDiff.serverPages }} 页 / {{ measure.clientDiff.serverHeight }}pt，
        偏差 {{ measure.clientDiff.heightDriftPt }}pt。
        导出以服务端为准；建议<span class="badge ok" style="margin:0 4px">锁定模板版本</span>避免更新后错位。
      </div>
      <div v-else-if="measure" class="banner ok">前端预测与服务端度量一致（差 {{ measure.clientDiff?.heightDriftPt ?? 0 }}pt）。</div>

      <PreviewPane :resume="resume" :entities="entities" :branch="branch" :measure="measure"
        :privacy="privacy" :purpose="purpose" @toggle="toggleItem" />
    </div>

    <!-- RIGHT: measure / tradeoffs / export / share -->
    <div class="panel">
      <h2>真实度量</h2>
      <div v-if="measure" class="card">
        <div class="row" style="justify-content:space-between">
          <span>服务端页数</span><strong>{{ measure.metrics.totalPages }}</strong>
        </div>
        <div class="row" style="justify-content:space-between">
          <span>内容高度</span><strong>{{ measure.metrics.totalHeight }}pt</strong>
        </div>
        <div class="row" style="justify-content:space-between">
          <span>模板</span>
          <span><span class="badge">{{ measure.templateKey }}@{{ measure.templateVersion }}</span>
            <span v-if="measure.templateOutdated" class="badge warn">有新版本</span>
            <span v-if="measure.locked" class="badge ok">已锁定</span></span>
        </div>
        <div v-if="measure.stripped.length" class="muted" style="margin-top:6px">
          本用途已隐藏字段：{{ measure.stripped.join('，') }}
        </div>
        <div v-if="measure.metrics.warnings.filter(w=>w.type.startsWith('FONT')||w.type==='GLYPH_MISSING').length" class="muted">
          字体回退 {{ measure.metrics.warnings.filter(w=>w.type==='FONT_FALLBACK').length }} 处；
          缺字 {{ measure.metrics.warnings.filter(w=>w.type==='GLYPH_MISSING').length }} 字（以 ? 保留，不删内容）
        </div>
      </div>

      <h2 v-if="measure?.overflow" style="color:#b35900">超一页：可执行取舍（请你选择）</h2>
      <TradeoffPanel v-if="measure?.overflow" :actions="measure.tradeoffs" @choose="applyTradeoff" />
      <div v-else-if="measure" class="banner ok">当前选择可容纳在一页内；没有为了排版静默删除任何事实。</div>

      <h2>导出</h2>
      <div class="card">
        <label>用途</label>
        <select v-model="exportPurpose">
          <option v-for="p in PURPOSES.slice(1)" :key="p.key" :value="p.key">{{ p.label }}</option>
        </select>
        <div class="row" style="margin-top:8px">
          <button @click="doExport" :disabled="busy">导出 PDF</button>
          <button class="ghost" @click="createShare">生成分享链接</button>
        </div>
        <div v-if="shareUrl" class="card" style="margin-top:8px">
          <div class="share-link">{{ shareUrl }}</div>
          <button class="danger small" style="margin-top:6px" @click="revokeShare">吊销链接</button>
        </div>
      </div>

      <h2>导出记录</h2>
      <div v-for="x in exportRecords" :key="x.id" class="card" style="padding:8px">
        <div class="row" style="justify-content:space-between">
          <span class="badge" :class="x.status==='ok'?'ok':x.status==='failed'?'err':'warn'">{{ x.status }}</span>
          <span class="muted">{{ x.branchKey }} · {{ x.format }} · {{ x.purpose }}</span>
        </div>
        <div class="muted">{{ x.templateKey }}@{{ x.templateVer }} · {{ x.byteSize || 0 }} B</div>
        <div v-if="x.error" class="muted" style="color:#b3261e">{{ x.error }}</div>
      </div>
    </div>
  </div>
</template>
