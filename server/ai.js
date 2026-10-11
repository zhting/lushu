/**
 * AI 生成路书：调用管理员配置的 OpenAI 兼容接口（/chat/completions），
 * 把攻略文字 / 截图 / 一句需求描述整理成「按天的地点列表」。
 * 只做识别与规划，不碰地图坐标——地点由前端用地图搜索逐个匹配，用户确认后才生成路书。
 */

const KINDS = ['waypoint', 'scenic', 'food', 'fuel', 'hotel']
const MAX_DAYS = 30
const MAX_STOPS_PER_DAY = 15
const MAX_TEXT = 12000
const MAX_IMAGES = 4
const MAX_IMAGE_CHARS = 3_000_000 // 单张 data URL 上限（约 2.2MB 图片）
const TIMEOUT_MS = 120_000

const SYSTEM_PROMPT = `你是自驾路书助手，负责把用户给的内容整理成按天的自驾行程。

输入可能是：
A. 现成的攻略 / 行程单 / 聊天记录 / 截图——请按原文顺序提取，不要添加原文没有的地点；
B. 一句需求（如「北京出发 5 天内蒙古自驾」）——请规划一条合理的自驾路线：每天驾驶尽量不超过 6 小时，只用真实存在、在地图上能搜到的知名景点、城市、乡镇或酒店，每天最后一个地点是当晚住宿地。

输出要求：
- 只输出一个 JSON 对象，不要任何解释、不要代码块标记。
- 格式：{"title": "行程名称", "mode": "extract" 或 "plan", "days": [{"stops": [{"name": "地点名", "city": "所在城市", "kind": "类型", "stayMinutes": 数字或 null, "note": "备注"}]}], "notes": "整体说明，可为空字符串"}
- name 必须是地图上能直接搜到的具体名称（景区、城市、乡镇、酒店、服务区名），不要写描述性文字或「午餐」「休息」这类没有地点的事项。
- city 写地点所在的城市或县，帮助地图搜索区分同名地点；不确定就写省份。
- kind 只能是：waypoint（途经）、scenic（景点）、food（餐饮）、fuel（加油/充电）、hotel（住宿）。
- stayMinutes：原文写了游玩时长就换算成分钟，没写就填 null。
- note：原文里与这个地点相关的要点（门票、开放时间、提醒等），不超过 40 个字，没有就填空字符串。
- 第一天的第一个地点是出发地（原文没写就省略）；从第二天起不要重复前一天的最后一个地点，系统会自动从前一天终点接续出发。
- 天数最多 ${MAX_DAYS} 天，每天最多 ${MAX_STOPS_PER_DAY} 个地点。
- 原文里无法识别成地点的内容，简要写进 notes。`

function clip(v, n) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
}

/** 从模型输出中取出 JSON（容忍代码块标记和前后多余文字） */
function extractJson(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('AI 没有返回有效的行程数据，请换个说法再试')
  try {
    return JSON.parse(s.slice(a, b + 1))
  } catch {
    throw new Error('AI 返回的行程格式不完整，请重试')
  }
}

/** 清洗模型输出：只保留约定字段，限制数量与长度 */
function sanitizePlan(raw) {
  const days = (Array.isArray(raw?.days) ? raw.days : []).slice(0, MAX_DAYS).map((d) => ({
    stops: (Array.isArray(d?.stops) ? d.stops : [])
      .map((st) => ({
        name: clip(st?.name, 60),
        city: clip(st?.city, 30),
        kind: KINDS.includes(st?.kind) ? st.kind : 'waypoint',
        stayMinutes: Number.isFinite(Number(st?.stayMinutes)) && st?.stayMinutes !== null
          ? Math.max(0, Math.min(1440, Math.round(Number(st.stayMinutes))))
          : null,
        note: clip(st?.note, 80),
      }))
      .filter((st) => st.name)
      .slice(0, MAX_STOPS_PER_DAY),
  }))
  const kept = days.filter((d) => d.stops.length)
  if (!kept.length) throw new Error('没有从内容里识别出地点，请补充更具体的地名再试')
  return {
    title: clip(raw?.title, 40) || 'AI 生成的路书',
    mode: raw?.mode === 'plan' ? 'plan' : 'extract',
    days: kept,
    notes: clip(raw?.notes, 300),
  }
}

/** 管理员配置的公开部分（不含 Key） */
export function aiPublicInfo(cfg) {
  return { hasAi: !!(cfg.aiBaseUrl && cfg.aiApiKey && cfg.aiModel), aiVision: !!cfg.aiVision }
}

/** 管理后台看到的配置：Key 只显示末四位 */
export function aiAdminInfo(cfg) {
  const k = cfg.aiApiKey || ''
  return {
    baseUrl: cfg.aiBaseUrl || '',
    model: cfg.aiModel || '',
    vision: !!cfg.aiVision,
    hasKey: !!k,
    keyHint: k ? `••••${k.slice(-4)}` : '',
  }
}

/** 校验管理员填写的接口地址 */
export function normalizeBaseUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  if (!s) return ''
  let url
  try {
    url = new URL(s)
  } catch {
    throw new Error('接口地址格式不正确')
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('接口地址必须以 http:// 或 https:// 开头')
  return s
}

/**
 * 调用模型。input: { text, images: dataURL[], startDate, hints }
 */
export async function parseTrip(cfg, input) {
  const text = clip(input?.text, MAX_TEXT)
  const images = (Array.isArray(input?.images) ? input.images : [])
    .filter((x) => typeof x === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(x) && x.length <= MAX_IMAGE_CHARS)
    .slice(0, MAX_IMAGES)
  if (!text && !images.length) throw new Error('请粘贴攻略文字、描述你的需求，或上传截图')
  if (images.length && !cfg.aiVision) throw new Error('当前 AI 模型不支持识别图片，请改为粘贴文字')

  const today = new Date().toISOString().slice(0, 10)
  const ctx = [
    `今天是 ${today}。`,
    input?.startDate ? `计划出发日期：${clip(input.startDate, 10)}。` : '',
    input?.hints ? `补充要求：${clip(input.hints, 300)}` : '',
  ].filter(Boolean).join('\n')
  const userText = `${ctx}\n\n以下是用户提供的内容：\n${text || '（见图片）'}`

  const userContent = images.length
    ? [{ type: 'text', text: userText }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : userText

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let res
  try {
    res = await fetch(`${cfg.aiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.aiApiKey}` },
      body: JSON.stringify({
        model: cfg.aiModel,
        temperature: 0.2,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
      signal: ctrl.signal,
    })
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? 'AI 响应超时，请精简内容后重试' : 'AI 服务连接失败，请检查后台的接口地址')
  } finally {
    clearTimeout(timer)
  }

  let data = null
  try {
    data = await res.json()
  } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || ''
    if (res.status === 401 || res.status === 403) throw new Error('AI 服务拒绝访问：请检查后台填写的 API Key')
    if (res.status === 429) throw new Error('AI 服务调用太频繁或额度不足，请稍后再试')
    throw new Error(`AI 服务返回错误（HTTP ${res.status}）${msg ? '：' + clip(msg, 120) : ''}`)
  }
  const content = data?.choices?.[0]?.message?.content
  const textOut = Array.isArray(content) ? content.map((c) => c?.text || '').join('') : content
  return sanitizePlan(extractJson(textOut))
}

/** 简单的按用户限流：每小时最多 n 次 */
const hits = new Map()
export function allowAiCall(username, perHour = 20) {
  const now = Date.now()
  const list = (hits.get(username) || []).filter((t) => now - t < 3600_000)
  if (list.length >= perHour) {
    hits.set(username, list)
    return false
  }
  list.push(now)
  hits.set(username, list)
  return true
}
