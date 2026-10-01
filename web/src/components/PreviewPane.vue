<script setup>
import { computed } from 'vue';

const props = defineProps({
  resume: Object, entities: Array, branch: Object, measure: Object, privacy: Array, purpose: String,
});
const emit = defineEmits(['toggle']);

// Which fields are visible under current purpose, mirroring backend privacy rules for display.
function allowed(path) {
  const rules = props.privacy.filter((r) => r.fieldPath === path);
  if (!rules.length) return true;
  return rules[rules.length - 1].purposes.includes(props.purpose);
}

const visibleEntities = computed(() => {
  const sel = new Set((props.branch?.items || []).map((i) => i.id));
  return props.entities.filter((e) => sel.has(e.id));
});

const sections = computed(() => [
  { title: 'Experience', kind: 'experience', main: (e) => e.fields.role, sub: (e) => e.fields.company },
  { title: 'Projects', kind: 'project', main: (e) => e.fields.name, sub: () => '' },
  { title: 'Education', kind: 'education', main: (e) => e.fields.school, sub: (e) => e.fields.degree },
]);
</script>

<template>
  <div class="sheet" style="width:595px;min-height:842px" v-if="resume">
    <h1 style="margin:0;font-size:18px">{{ resume.profile.name }}</h1>
    <div class="muted preview-line" style="margin:2px 0 8px">
      <span v-if="allowed('profile.email')">{{ resume.profile.email }}</span>
      <span v-if="allowed('profile.phone') && resume.profile.phone"> · {{ resume.profile.phone }}</span>
      <span v-if="allowed('profile.site') && resume.profile.site"> · <span class="url">{{ resume.profile.site }}</span></span>
      <span v-if="!allowed('profile.phone')" class="badge err" style="margin-left:6px">手机号已按用途隐藏</span>
    </div>

    <template v-for="sec in sections" :key="sec.kind">
      <template v-if="visibleEntities.filter(e=>e.kind===sec.kind).length">
        <h2 style="font-size:12px;text-transform:uppercase;border-bottom:1px solid #999;margin:12px 0 4px">{{ sec.title }}</h2>
        <div v-for="e in visibleEntities.filter(x=>x.kind===sec.kind)" :key="e.id" style="margin-bottom:7px">
          <div><strong>{{ sec.main(e) }}</strong><span v-if="sec.sub(e)"> · {{ sec.sub(e) }}</span></div>
          <div class="preview-line" v-if="e.fields.summary">{{ e.fields.summary }}</div>
          <div class="preview-line" v-if="e.fields.description">{{ e.fields.description }}</div>
          <div class="url preview-line" v-if="e.fields.url && allowed(`entities.${e.id}.url`)">{{ e.fields.url }}</div>
          <div v-if="e.fields.url && !allowed(`entities.${e.id}.url`)" class="badge err">长链接已按用途隐藏</div>
        </div>
      </template>
    </template>

    <div v-if="measure && measure.metrics.totalPages > 1" class="page-break">
      <span>超出一页（服务端 {{ measure.metrics.totalPages }} 页）— 请在右侧选择取舍，系统不会静默删内容</span>
    </div>
  </div>
</template>
