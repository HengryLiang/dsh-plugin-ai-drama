/** 名称与路径安全校验：所有写入磁盘的用户输入都要过这里。 */

const FORBIDDEN_CHARS = /[\\/:*?"<>|\u0000-\u001f]/
const RESERVED = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i

/** 短剧项目名（同时也是目录名）。 */
export function assertSafeTitle(title) {
  if (typeof title !== 'string') throw new Error('缺少短剧名称')
  const name = title.trim()
  if (!name) throw new Error('短剧名称不能为空')
  if (name.length > 60) throw new Error('短剧名称过长（上限 60 字）')
  if (FORBIDDEN_CHARS.test(name)) throw new Error('短剧名称不能包含 \\ / : * ? " < > | 等字符')
  if (/[. ]$/.test(name)) throw new Error('短剧名称不能以点或空格结尾')
  if (RESERVED.test(name)) throw new Error('短剧名称不能使用系统保留名')
  if (name === '.aidrama') throw new Error('该名称被内部数据目录保留')
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
    if (segment === '.' || segment === '..') throw new Error('路径不能包含 . 或 ..')
    if (segment === '.aidrama') throw new Error('不能写入内部数据目录')
    if (FORBIDDEN_CHARS.test(segment)) throw new Error('路径不能包含 \\ / : * ? " < > | 等字符')
    if (segment.length > 80) throw new Error('单级名称过长（上限 80 字）')
    if (/[. ]$/.test(segment)) throw new Error('名称不能以点或空格结尾')
    if (RESERVED.test(segment)) throw new Error('不能使用系统保留名')
  }
  return segments.join('/')
}

/** 文件名（重命名用，不含分隔符）。 */
export function assertSafeFileName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('缺少名称')
  const value = name.trim()
  if (FORBIDDEN_CHARS.test(value)) throw new Error('名称不能包含 \\ / : * ? " < > | 等字符')
  if (value === '.' || value === '..') throw new Error('名称不合法')
  if (value === '.aidrama') throw new Error('该名称被内部数据目录保留')
  if (value.length > 80) throw new Error('名称过长（上限 80 字）')
  if (/[. ]$/.test(value)) throw new Error('名称不能以点或空格结尾')
  if (RESERVED.test(value)) throw new Error('不能使用系统保留名')
  return value
}
