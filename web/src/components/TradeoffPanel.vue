<script setup>
defineProps({ actions: Array });
defineEmits(['choose']);
</script>
<template>
  <div>
    <div v-for="a in actions" :key="a.id" class="tradeoff">
      <div>{{ a.label }}</div>
      <div class="row" style="justify-content:space-between;margin-top:4px">
        <span class="saved" v-if="a.savedPt>0">预计节省 {{ a.savedPt }}pt 高度</span>
        <span class="muted" v-else>不改变高度</span>
        <button class="small" @click="$emit('choose', a)">采用</button>
      </div>
    </div>
    <div class="muted">所有操作都只改变“可见性/选择/分页”，底层事实始终保留，可在详细版或撤销后恢复。</div>
  </div>
</template>
