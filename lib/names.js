/** 名称与路径安全校验：所有写入磁盘的用户输入都要过这里。 */

const FORBIDDEN_CHARS = /[\\/:*?"<>|\u0000-\u001f]/
const RESERVED = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i
const INTERNAL_DATA_DIR = '.aidrama'

/** v0.15.10（task-131 / C-5）：错误码可被 HTTP 层映射（invalid-args 400 / forbidden 403）。 */
function pathError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 内部数据目录名（大小写不敏感；Windows 文件系统不区分大小写）。 */
function isInternalDataName(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === INTERNAL_DATA_DIR
}

/** Windows 保留设备名：按 basename（去掉扩展名）判断（CON.txt 等同样命中设备名）。 */
function isWindowsReservedName(value) {
  const base = String(value == null ? '' : value).trim().split('.')[0].trim().toUpperCase()
  return RESERVED.test(base)
}

/** 逐层 decodeURIComponent（最多 3 层；用于发现编码后的 traversal/分隔符/内部目录）。 */
function decodeVariants(value) {
  const variants = [String(value)]
  let current = String(value)
  for (let round = 0; round < 3; round += 1) {
    if (!/%[0-9a-fA-F]{2}/.test(current)) break
    let next
    try {
      next = decodeURIComponent(current)
    } catch {
      break
    }
    if (next === current) break
    variants.push(next)
    current = next
  }
  return variants
}

/**
 * v0.15.10：百分号编码 traversal 检测（C-5 / V6）。
 * 对名称/路径段做 1–3 层解码校验：解码后出现 `..`/`.` 段、路径分隔符、控制字符或内部数据目录 → 拒绝。
 * **只用于校验；落盘使用原始字符串，不解码。**
 */
export function hasEncodedPathTraversal(value) {
  const variants = decodeVariants(value)
  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index]
    if (/[\u0000-\u001f]/.test(variant)) return true
    if (variant.includes('/') || variant.includes('\\')) return true
    if (variant === '.' || variant === '..') return true
    if (variant.split(/[\\/]+/).some((segment) => segment === '.' || segment === '..')) return true
    // 原始名直接为内部数据目录交给调用方的 forbidden 分支处理；只有“编码解码后”新增的内部目录形态在此拒绝
    if (index > 0 && isInternalDataName(variant)) return true
  }
  return false
}

/** 短剧项目名（同时也是目录名）。 */
export function assertSafeTitle(title) {
  if (typeof title !== 'string') throw new Error('缺少短剧名称')
  const name = title.trim()
  if (!name) throw new Error('短剧名称不能为空')
  if (name.length > 60) throw new Error('短剧名称过长（上限 60 字）')
  if (FORBIDDEN_CHARS.test(name)) throw new Error('短剧名称不能包含 \\ / : * ? " < > | 等字符')
  if (/[. ]$/.test(name)) throw new Error('短剧名称不能以点或空格结尾')
  if (isWindowsReservedName(name)) throw new Error('短剧名称不能使用系统保留名')
  if (name === INTERNAL_DATA_DIR) throw new Error('该名称被内部数据目录保留')
  if (isInternalDataName(name)) throw pathError('forbidden', '该名称被内部数据目录保留（大小写变体）')
  return name
}

/** 项目内的相对路径（用于新建条目 / 重命名）。 */
export function assertSafeRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) throw new Error('缺少路径')
  const normalized = relPath.replace(/\\/g, '/').trim()
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error('必须是项目内相对路径')
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length) throw new Error('缺少路径')
  for (const segment of segments) {
    // v0.15.10（C-5）：先做编码变体校验（不解码落盘）；`.aidrama` 大小写不敏感
    if (hasEncodedPathTraversal(segment)) throw pathError('invalid-args', '路径包含编码后的非法字符（不允许 .. 跳转/分隔符）')
    if (segment === '.' || segment === '..') throw new Error('路径不能包含 . 或 ..')
    // 旧契约：精确 `.aidrama` 仍为普通 400 错误；v0.15.10（C-5/V3）新增大小写变体 → forbidden 403
    if (segment === INTERNAL_DATA_DIR) throw new Error('不能写入内部数据目录')
    if (isInternalDataName(segment)) throw pathError('forbidden', '不能写入内部数据目录（大小写变体）')
    if (FORBIDDEN_CHARS.test(segment)) throw new Error('路径不能包含 \\ / : * ? " < > | 等字符')
    if (segment.length > 80) throw new Error('单级名称过长（上限 80 字）')
    if (/[. ]$/.test(segment)) throw new Error('名称不能以点或空格结尾')
    if (isWindowsReservedName(segment)) throw new Error('不能使用系统保留名')
  }
  return segments.join('/')
}

/** 文件名（重命名用，不含分隔符）。 */
export function assertSafeFileName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('缺少名称')
  const value = name.trim()
  if (hasEncodedPathTraversal(value)) throw pathError('invalid-args', '名称包含编码后的非法字符（不允许 .. 跳转/分隔符）')
  if (FORBIDDEN_CHARS.test(value)) throw new Error('名称不能包含 \\ / : * ? " < > | 等字符')
  if (value === '.' || value === '..') throw new Error('名称不合法')
  if (value === INTERNAL_DATA_DIR) throw new Error('该名称被内部数据目录保留')
  if (isInternalDataName(value)) throw pathError('forbidden', '该名称被内部数据目录保留（大小写变体）')
  if (value.length > 80) throw new Error('名称过长（上限 80 字）')
  if (/[. ]$/.test(value)) throw new Error('名称不能以点或空格结尾')
  if (isWindowsReservedName(value)) throw new Error('不能使用系统保留名')
  return value
}
