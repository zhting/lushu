/**
 * 自驾巡游 16:9 视频录制与导出服务
 * 直接基于离屏 16:9 Canvas 实时合成地图瓦片、规划路线、地点标记、巡游小车与 HUD，
 * 通过 canvas.captureStream + MediaRecorder 零弹窗直接导出视频（无需浏览器屏幕共享授权弹窗）
 */

export interface StartRecordingOptions {
  width?: number
  height?: number
  fps?: number
  onRenderFrame: (ctx: CanvasRenderingContext2D, width: number, height: number) => void
}

export interface RecordingSession {
  renderNow: () => void
  stop: () => Promise<Blob>
  cancel: () => void
  isRecording: () => boolean
}

/** 检查当前浏览器是否支持 Canvas 视频录制导出功能 */
export function isVideoRecordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  )
}

/** 获取浏览器最优支持的视频导出 MIME 格式（优先选用通用 MP4 容器） */
export function getSupportedMimeType(): string {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return 'video/mp4'
  const types = [
    'video/mp4;codecs=avc1',
    'video/mp4;codecs=h264',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || ''
}

/** 去掉 codecs 参数，只保留容器类型（如 video/webm） */
function containerType(mime: string): string {
  return (mime || '').split(';')[0].trim() || 'video/webm'
}

/** 视频 Blob 对应的文件后缀与展示名（按实际编码格式，不做伪装） */
export function videoFormatOf(blob: Blob): { ext: 'mp4' | 'webm'; label: string } {
  return blob.type.includes('mp4') ? { ext: 'mp4', label: 'MP4' } : { ext: 'webm', label: 'WebM' }
}

/**
 * 启动零弹窗 16:9 Canvas 视频录制会话
 */
export async function start16x9Recording(
  options: StartRecordingOptions,
): Promise<RecordingSession> {
  const { width = 1920, height = 1080, fps = 30, onRenderFrame } = options

  if (!isVideoRecordingSupported()) {
    throw new Error('当前浏览器不支持视频录制导出，请使用 Chrome、Edge 或 Firefox 浏览器')
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) {
    throw new Error('无法创建 Canvas 2D 绘图上下文')
  }

  let active = true

  const renderNow = () => {
    if (!active) return
    try {
      onRenderFrame(ctx, width, height)
    } catch {
      // 忽略单帧绘制异常，保证录制流不中断
    }
  }

  // 立即绘制首帧
  renderNow()

  // 定时刷新保证即使在到站停留帧也有稳定的帧率输出
  const timerId = window.setInterval(renderNow, Math.round(1000 / fps))

  const canvasStream = canvas.captureStream(fps)
  const mimeType = getSupportedMimeType()
  const chunks: Blob[] = []

  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(canvasStream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 8_500_000, // 8.5 Mbps 超清码率
    })
  } catch {
    recorder = new MediaRecorder(canvasStream)
  }

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data)
    }
  }

  let stopPromiseResolve: ((blob: Blob) => void) | null = null
  let isCancelled = false

  const outputType = () => containerType(recorder.mimeType || mimeType)

  recorder.onstop = () => {
    if (isCancelled) return
    const finalBlob = new Blob(chunks, { type: outputType() })
    if (stopPromiseResolve) {
      stopPromiseResolve(finalBlob)
      stopPromiseResolve = null
    }
  }

  recorder.start(200)

  const stop = (): Promise<Blob> => {
    if (!active) {
      return Promise.resolve(new Blob(chunks, { type: outputType() }))
    }
    renderNow()
    active = false
    window.clearInterval(timerId)

    return new Promise<Blob>((resolve) => {
      stopPromiseResolve = resolve
      if (recorder.state !== 'inactive') {
        recorder.stop()
      } else {
        resolve(new Blob(chunks, { type: outputType() }))
      }
      canvasStream.getTracks().forEach((t) => t.stop())
    })
  }

  const cancel = () => {
    if (!active) return
    active = false
    isCancelled = true
    window.clearInterval(timerId)

    if (recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {}
    }
    canvasStream.getTracks().forEach((t) => t.stop())
  }

  return {
    renderNow,
    stop,
    cancel,
    isRecording: () => active,
  }
}

/** 触发视频文件下载：后缀与实际编码一致（MP4 或 WebM） */
export function downloadVideoBlob(blob: Blob, filename = '自驾路线巡游'): { ext: string; label: string } {
  const fmt = videoFormatOf(blob)
  const cleanName = filename.replace(/\.(webm|mp4)$/i, '')
  const finalName = `${cleanName}.${fmt.ext}`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = finalName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return fmt
}
