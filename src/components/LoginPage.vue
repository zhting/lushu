<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const mode = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const password2 = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  const u = username.value.trim()
  const p = password.value
  if (!u || !p) {
    error.value = '请输入用户名和密码'
    return
  }
  if (mode.value === 'register') {
    if (p.length < 4) {
      error.value = '密码至少 4 位'
      return
    }
    if (p !== password2.value) {
      error.value = '两次输入的密码不一致'
      return
    }
  }
  busy.value = true
  try {
    if (mode.value === 'login') await auth.login(u, p)
    else await auth.register(u, p)
  } catch (e: any) {
    error.value = e?.message || '操作失败'
  } finally {
    busy.value = false
  }
}

function switchMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  error.value = ''
}
</script>

<template>
  <div class="center-screen">
    <div class="gate-card">
      <h1>🚗 路书 · 自驾行程规划</h1>
      <p class="desc">{{ mode === 'login' ? '登录后管理你自己的路书。' : '注册一个账号，开始规划你的自驾路书。' }}</p>

      <form @submit.prevent="submit">
        <div class="field">
          <label>用户名</label>
          <input v-model="username" placeholder="2-20 位字母 / 数字 / 中文" autocomplete="username" />
        </div>
        <div class="field">
          <label>密码</label>
          <input v-model="password" type="password" placeholder="至少 4 位" autocomplete="current-password" />
        </div>
        <div v-if="mode === 'register'" class="field">
          <label>确认密码</label>
          <input v-model="password2" type="password" placeholder="再输入一次" autocomplete="new-password" />
        </div>
        <p v-if="error" class="error-text" style="margin: 0 0 8px">{{ error }}</p>
        <button class="btn btn-primary" type="submit" :disabled="busy">
          {{ busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并进入' }}
        </button>
      </form>

      <p class="auth-switch">
        <template v-if="mode === 'login'">还没有账号？<a href="#" @click.prevent="switchMode">注册一个</a></template>
        <template v-else>已有账号？<a href="#" @click.prevent="switchMode">直接登录</a></template>
      </p>

      <p v-if="mode === 'register'" class="muted" style="margin: 10px 0 0">
        💡 第一个注册的用户将自动成为管理员，可在后台配置地图 API。
      </p>
    </div>
  </div>
</template>
