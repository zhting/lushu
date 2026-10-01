let seq = 0

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
