<script setup>
import { ref } from 'vue';
import { api } from '../lib/api.js';

const props = defineProps({
  kind: String,
  entities: Array,
  resumeId: String,
  selectedIds: Set,
  branch: String,
});
const emit = defineEmits(['saved']);
const adding = ref(false);
const draft = ref({});
const editing = ref(null);
const conflict = ref(null);

const TITLES = { experience: ['经历', { role: '职位', company: '公司', summary: '描述' }],
  project: ['项目', { name: '名称', url: '链接', description: '描述' }],
  education: ['教育', { school: '学校', degree: '专业/学历' }] };

function emptyDraft() {
  const fields = {};
  for (const k of Object.keys(TITLES[props.kind][1])) fields[k] = '';
  draft.value = { fields };
  adding.value = true;
}

async function save() {
  conflict.value = null;
  try {
    const body = { kind: props.kind, fields: draft.value.fields };
    if (draft.value.id) { body.entityId = draft.value.id; body.expectedVersion = draft.value.version; }
    const r = await api.saveEntity(props.resumeId, body);
    adding.value = false; editing.value = null;
    emit('saved', r.entity);
  } catch (e) {
    if (e.status === 409) {
      conflict.value = '该经历刚在另一设备被修改（版本冲突）。已放弃覆盖；请刷新查看最新版本后再编辑。';
    } else throw e;
  }
}

function edit(e) { draft.value = JSON.parse(JSON.stringify(e)); adding.value = true; editing.value = e.id; }
async function removeFromBranch(e) {
  await api.setItem(props.resumeId, props.branch, { entityId: e.id, kind: props.kind, selected: false });
  emit('saved', e);
}
async function addToBranch(e) {
  await api.setItem(props.resumeId, props.branch, { entityId: e.id, kind: props.kind, selected: true });
  emit('saved', e);
}
</script>

<template>
  <div style="margin-top:10px">
    <h2 style="display:flex;justify-content:space-between;align-items:center">
      {{ TITLES[kind][0] }}
      <button class="small ghost" @click="emptyDraft">+ 新增</button>
    </h2>
    <div v-if="conflict" class="banner err">{{ conflict }}</div>
    <div v-for="e in entities" :key="e.id" class="card" :class="{ 'strike-fact': selectedIds && !selectedIds.has(e.id) }">
      <h3>
        <span>{{ e.fields.role || e.fields.name || e.fields.school }} <span class="badge">v{{ e.version }}</span></span>
        <span>
          <span v-if="selectedIds?.has(e.id)" class="badge ok">本版式已选</span>
          <span v-else class="badge warn">本版式未选（事实仍保留）</span>
        </span>
      </h3>
      <div class="muted">{{ e.fields.company || e.fields.degree || '' }}</div>
      <div class="row" style="margin-top:6px">
        <button class="small ghost" @click="edit(e)">编辑共享事实</button>
        <button v-if="!selectedIds?.has(e.id)" class="small" @click="addToBranch(e)">加入{{ branch === 'onepage' ? '一页版' : '详细版' }}</button>
        <button v-else class="small danger" @click="removeFromBranch(e)">从本版式移除（不删除）</button>
      </div>
    </div>

    <div v-if="adding" class="card" style="border-color:#3057d5">
      <h3>{{ editing ? '编辑共享事实（版本号保护）' : '新增' + TITLES[kind][0] }}</h3>
      <div v-for="(label, key) in TITLES[kind][1]" :key="key">
        <label>{{ label }}</label>
        <textarea v-if="key==='summary'||key==='description'" v-model="draft.fields[key]"></textarea>
        <input v-else v-model="draft.fields[key]" />
      </div>
      <div class="row" style="margin-top:8px">
        <button class="small" @click="save">保存（所有版式共享）</button>
        <button class="small ghost" @click="adding=false">取消</button>
      </div>
    </div>
  </div>
</template>
