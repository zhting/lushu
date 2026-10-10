/**
 * 自驾巡游 16:9 视频录制与导出服务
 * 基于 WebRTC 屏幕/标签页捕获 + 离屏 16:9 画幅 Canvas 重采样 + MediaRecorder 编码导出
 */

export interface StartRecordingOptions {
  targetElement: HTMLElement
  width?: number
  height?: number
  fps?: number
  onAutoStop?: (blob: Blob) => void
  onError?: (err: Error) => void
}

export interface RecordingSession {
  stop: () => Promise<Blob>
  cancel: () => void
  isRecording: () => boolean
}

/** 检查当前浏览器是否支持视频录制导出功能 */
export function isVideoRecordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!navigator?.mediaDevices?.getDisplayMedia &&
    typeof window.MediaRecorder !== 'undefined'
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
  // 都不支持时返回空串，交给浏览器选默认格式；最终格式以 recorder.mimeType 为准
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
 * 启动 16:9 视频录制会话
 */
export async function start16x9Recording(
  options: StartRecordingOptions,
): Promise<RecordingSession> {
  const { targetElement, width = 1920, height = 1080, fps = 30 } = options

  if (!isVideoRecordingSupported()) {
    throw new Error('当前浏览器不支持屏幕视频录制，请使用较新版本的 Chrome、Edge 或 Firefox 浏览器')
  }

  // 1. 请求捕获标签页画面（提示优先选择当前标签页）
  let captureStream: MediaStream
  try {
    captureStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'browser',
        frameRate: { ideal: fps, max: 60 },
      },
      audio: false,
      // @ts-ignore
      preferCurrentTab: true,
      // @ts-ignore
      selfBrowserSurface: 'include',
      // @ts-ignore
      systemAudio: 'exclude',
    })
  } catch (err: any) {
    if (err?.name === 'NotAllowedError') {
      throw new Error('已取消屏幕录制授权')
    }
    throw err
  }

  // 2. 创建隐藏 video 元素接收流像素
  const video = document.createElement('video')
  video.muted = true
  video.autoplay = true
  video.playsInline = true
  video.srcObject = captureStream

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => {
      video.play().then(resolve).catch(reject)
    }
    video.onerror = (e) => reject(new Error('视频流播放失败'))
  })

  // 3. 构建 16:9 离屏重采样 Canvas
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  if (!ctx) {
    captureStream.getTracks().forEach((t) => t.stop())
    throw new Error('无法创建 Canvas 2D 绘图上下文')
  }

  let rafId: number | null = null
  let active = true

  // 帧重采样循环：精确计算 targetElement 在捕获画面中的坐标并剪切至 16:9 画幅
  const renderFrame = () => {
    if (!active) return

    const rect = targetElement.getBoundingClientRect()
    const videoWidth = video.videoWidth || window.innerWidth
    const videoHeight = video.videoHeight || window.innerHeight

    const scaleX = videoWidth / window.innerWidth
    const scaleY = videoHeight / window.innerHeight

    const sx = Math.max(0, rect.left * scaleX)
    const sy = Math.max(0, rect.top * scaleY)
    const sw = Math.min(videoWidth - sx, rect.width * scaleX)
    const sh = Math.min(videoHeight - sy, rect.height * scaleY)

    if (sw > 0 && sh > 0) {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height)
    }

    rafId = requestAnimationFrame(renderFrame)
  }

  rafId = requestAnimationFrame(renderFrame)

  // 4. 从 Canvas 捕获高质量视频流并创建 MediaRecorder
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

  // 实际编码格式：以浏览器最终采用的 mimeType 为准（Firefox 等只能录 WebM）
  const outputType = () => containerType(recorder.mimeType || mimeType)

  recorder.onstop = () => {
    if (isCancelled) return
    const finalBlob = new Blob(chunks, { type: outputType() })
    if (stopPromiseResolve) {
      stopPromiseResolve(finalBlob)
      stopPromiseResolve = null
    } else {
      // 仅当用户在浏览器原生浮条上点击「停止共享」时，才走自动停止回调
      options.onAutoStop?.(finalBlob)
    }
  }

  recorder.start(250)

  // 监听用户点击浏览器原生浮条的「停止共享」
  const videoTrack = captureStream.getVideoTracks()[0]
  if (videoTrack) {
    videoTrack.onended = () => {
      if (active) {
        void stop()
      }
    }
  }

  const stop = (): Promise<Blob> => {
    if (!active) {
      return Promise.resolve(new Blob(chunks, { type: outputType() }))
    }
    active = false

    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }

    return new Promise<Blob>((resolve) => {
      stopPromiseResolve = resolve
      if (recorder.state !== 'inactive') {
        recorder.stop()
      }
      captureStream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    })
  }

  const cancel = () => {
    if (!active) return
    active = false
    isCancelled = true

    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }

    if (recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {}
    }
    captureStream.getTracks().forEach((t) => t.stop())
    video.srcObject = null
  }

  return {
    stop,
    cancel,
    isRecording: () => active,
  }
}

/** 触发视频文件下载：后缀与实际编码一致（MP4 或 WebM），避免 WebM 被改名成 .mp4 后播放器打不开 */
export function downloadVideoBlob(blob: Blob, filename = '自驾路线巡游-16比9'): { ext: string; label: string } {
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
