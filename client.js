/**
 * AI 短剧工作区 —— 客户端半（Web Client half）
 *
 * 只做两件事：
 *   1. 在 `sidebar.panellist`(list/root) 注册侧栏入口图标，id = 'ai-drama'
 *   2. 在 `main`(keyed/root) 用同一个 key 注册中央面板
 *
 * 数据一律通过宿主半的精确路由 `/api/ai-drama/<method>` 获取（POST + 自定义请求头）。
 * 不使用任何 @deepseek-ai/dsh-client-* 运行时依赖；React 由浏览器模块表提供。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-ai-drama',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'ai-drama'
    const API_PATH = '/api/ai-drama/'

    const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写', '大特写']
    const ROLES = ['主角', '反派', '配角', '龙套']

    /* ------------------------------------------------------ 多数据源基础（P2-1） */

    // 当前数据源（工作区根目录）：由面板「数据源选择器」设置，api() 统一注入 cwd。
    // 空字符串 = 不注入（旧宿主 / 未选择数据源时保持 0.4.x 原行为，向后兼容）。
    let currentSourceCwd = ''
    const SOURCE_STORAGE_KEY = 'ai-drama:source'
    const SOURCE_TYPE_LABELS = { workspace: '工作区', session: '短剧会话目录', manual: '手动添加' }

    function sourceTypeLabel(type) {
      return SOURCE_TYPE_LABELS[String(type || '')] || '数据源'
    }

    function shortSourcePath(pathValue) {
      const text = String(pathValue || '')
      if (!text) return ''
      const parts = text.split(/[\\/]+/).filter(Boolean)
      return parts.slice(-2).join('/') || text
    }

    function readSavedSource() {
      try {
        return window.localStorage.getItem(SOURCE_STORAGE_KEY) || ''
      } catch {
        return ''
      }
    }

    function saveSourceSelection(pathValue) {
      try {
        if (pathValue) window.localStorage.setItem(SOURCE_STORAGE_KEY, pathValue)
        else window.localStorage.removeItem(SOURCE_STORAGE_KEY)
      } catch {
        /* 忽略：隐私模式等场景不阻断主流程 */
      }
    }

    /* ------------------------------------------------------------ 宿主调用 */

    async function api(method, payload) {
      const request = { ...(payload || {}) }
      // P2-1 多数据源：统一注入当前数据源 root（cwd）。旧宿主按 resolveWorkspaceRoot 优先级解析；
      // 未选择数据源时不注入，保持与 0.4.x 完全一致（向后兼容）。
      if (currentSourceCwd && request.cwd == null && request.sessionId == null) request.cwd = currentSourceCwd
      const response = await fetch(API_PATH + method, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
        body: JSON.stringify(request),
      })
      let data
      try {
        data = await response.json()
      } catch {
        throw new Error('短剧服务尚未就绪，请刷新后重试')
      }
      if (!response.ok || !data || data.ok === false) {
        const error = new Error((data && data.error) || '短剧操作失败')
        error.code = (data && data.code) || 'failed'
        // T7/E1：冲突（HTTP 409）等场景需要读取响应附加字段（如 currentHash）
        error.detail = data || null
        throw error
      }
      return data
    }

    /* ------------------------------------------------------------ 宿主能力探测 */

    // P1 新增能力（H-1 批量草稿 / H-2 设置扩字段 / H-3 videoPrompt）随 v0.4.0 发布。
    // 对更早的宿主保持旧交互（隐藏批量/恢复、videoPrompt 只读），不请求未支持的语义。
    const MIN_P1_HOST = '0.4.0'

    function versionAtLeast(current, want) {
      const parse = (value) =>
        String(value || '')
          .split('.')
          .map((part) => {
            const n = Number.parseInt(part, 10)
            return Number.isFinite(n) ? n : 0
          })
      const a = parse(current)
      const b = parse(want)
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const x = a[i] || 0
        const y = b[i] || 0
        if (x !== y) return x > y
      }
      return true
    }

    /* ------------------------------------------------------ 剧本场次解析（只读） */

    // 与宿主 store.parseScenes 的约定保持一致：`## 场景 N：内景 - 地点 - 夜`。
    // P1 只做「只读分块渲染」降级（N-9：本轮不开场次级写接口）。
    const SCENE_RE = /^##\s*场景\s*(\d*)\s*[：:]\s*(.*)$/
    const DIALOGUE_RE = /^\s*([\u4e00-\u9fa5A-Za-z0-9_·]{1,12})\s*[：:]\s*(\S.*)$/
    const NON_CHARACTER = ['动作', '转场', '旁白', '画面', '场景', '音效']

    function parseEpisodeScenes(text) {
      const source = String(text || '')
      // P2-8 性能：场次解析结果按文本缓存（面板每次渲染都会调用，100 集/长剧本避免重复解析）。
      if (source === sceneCache.text) return sceneCache.scenes
      const scenes = []
      let current = null
      for (const raw of source.split(/\r?\n/)) {
        const line = raw.trim()
        const match = line.match(SCENE_RE)
        if (match) {
          const slug = (match[2] || '').trim() || '未命名场次'
          const parts = slug.split(/\s*[-－—]\s*/)
          current = {
            no: match[1] || String(scenes.length + 1),
            slug,
            interior: /^内景/.test(parts[0] || ''),
            location: (parts[1] || parts[0] || '').trim(),
            time: (parts[2] || '').trim(),
            lines: [],
            characters: [],
            dialogueCount: 0,
          }
          scenes.push(current)
          continue
        }
        if (!current || !line) continue
        current.lines.push(raw)
        const dialogue = line.match(DIALOGUE_RE)
        if (dialogue && !NON_CHARACTER.includes(dialogue[1])) {
          current.dialogueCount += 1
          if (!current.characters.includes(dialogue[1])) current.characters.push(dialogue[1])
        }
      }
      sceneCache.text = source
      sceneCache.scenes = scenes
      return scenes
    }
    const sceneCache = { text: null, scenes: [] }

    /* --------- v0.10（task-84）：分镜保存合并（保留 host 未返回的未知/add-only 字段） */
    // host 返回为权威：只把 prev 中存在、host 结果**缺失**的键补回；
    // - shotNumber 统一转字符串匹配（兼容 Number/字符串混用；重复/缺失回退下标）；
    // - 不复活 host 已删除的镜头（输出长度恒等于 host 返回长度）；
    // - 已存在于返回对象的键（含用户修改后的已知字段）一律以 host 返回为准，不回滚。
    function mergeShotsPreservingExtraFields(prevShots, nextShots) {
      if (!Array.isArray(nextShots)) return Array.isArray(prevShots) ? prevShots : []
      const previous = Array.isArray(prevShots) ? prevShots : []
      const shotKeyOf = (shot) => {
        if (!shot || typeof shot !== 'object') return ''
        const raw = shot.shotNumber
        return raw == null ? '' : String(raw).trim()
      }
      const previousByKey = new Map()
      for (const shot of previous) {
        const key = shotKeyOf(shot)
        if (key && !previousByKey.has(key)) previousByKey.set(key, shot)
      }
      return nextShots.map((shot, index) => {
        if (!shot || typeof shot !== 'object') return shot
        const key = shotKeyOf(shot)
        const before = (key && previousByKey.get(key)) || (previous[index] && typeof previous[index] === 'object' ? previous[index] : null)
        if (!before) return shot
        const merged = { ...shot }
        for (const field of Object.keys(before)) {
          if (!Object.prototype.hasOwnProperty.call(merged, field) && before[field] !== undefined) {
            merged[field] = before[field]
          }
        }
        return merged
      })
    }

    /* --------- v0.10.4（task-91）：分镜 add-only 字段只读展示 helper（纯展示、无副作用） */
    // 10 个 v0.10.0 per-shot 可选字段；空值/缺失/畸形类型一律不产出（缺字段隐藏不报错）。
    const SHOT_EXTRA_FIELDS = [
      ['emotion', '情绪'],
      ['light', '光影'],
      ['ambientSound', '环境声'],
      ['constraints', '约束'],
      ['poses', '姿态'],
      ['transitionToNext', '转场'],
      ['naturalLanguagePrompt', '语言段'],
      ['lens', '镜头'],
      ['subject', '主体'],
      ['groupId', '分组 id'],
    ]

    function shotExtraText(raw) {
      if (raw == null) return ''
      if (typeof raw === 'string') return raw.trim()
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
      if (Array.isArray(raw)) {
        return raw.map((item) => (item == null ? '' : String(item).trim())).filter(Boolean).join('；')
      }
      return ''
    }

    /** 收集单镜的只读高级字段键值（顺序固定；仅含实际有值的字段）。 */
    function storyboardExtraEntries(shot) {
      if (!shot || typeof shot !== 'object') return []
      const entries = []
      for (const [key, label] of SHOT_EXTRA_FIELDS) {
        const value = shot[key]
        let text = ''
        if (key === 'emotion') {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const parts = []
            if (typeof value.label === 'string' && value.label.trim()) parts.push(value.label.trim())
            const intensity = Number(value.intensity)
            if (Number.isFinite(intensity)) parts.push(`强度 ${Math.round(intensity)}`)
            text = parts.join('，')
          } else {
            text = shotExtraText(value)
          }
        } else if (key === 'poses') {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const start = shotExtraText(value.startPose)
            const end = shotExtraText(value.endPose)
            const parts = []
            if (start) parts.push(`起：${start}`)
            if (end) parts.push(`止：${end}`)
            text = parts.join(' / ')
          } else {
            text = shotExtraText(value)
          }
        } else {
          text = shotExtraText(value)
        }
        if (text) entries.push([label, text])
      }
      return entries
    }

    function storyboardHasExtraFields(shot) {
      return storyboardExtraEntries(shot).length > 0
    }

    /* --------- v0.11.2（task-99）：分镜分组 groups add-only 只读展示 helper（纯展示、无副作用） */
    const GROUP_EMOTION_CUE_MAX = 200
    const GROUP_PROMPT_MAX = 2000

    /** emotionCue 防御式转文本：host 派生字符串为主；兼容 {curve[],intensity} / {label,intensity} / 数字（超长截断 200 字）。 */
    function groupEmotionCueText(raw) {
      if (raw == null) return ''
      if (typeof raw === 'string') return raw.trim().slice(0, GROUP_EMOTION_CUE_MAX)
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
      if (typeof raw === 'object' && !Array.isArray(raw)) {
        const parts = []
        if (Array.isArray(raw.curve)) {
          const curve = raw.curve.map((item) => (item == null ? '' : String(item).trim())).filter(Boolean)
          if (curve.length) parts.push(curve.join('→'))
        }
        if (typeof raw.label === 'string' && raw.label.trim()) parts.push(raw.label.trim())
        const intensity = Number(raw.intensity)
        if (Number.isFinite(intensity)) parts.push(`强度 ${Math.round(intensity)}`)
        return parts.join('，').slice(0, GROUP_EMOTION_CUE_MAX)
      }
      return ''
    }

    /** 防御式归一化 storyboard-get 响应 add-only groups：跳过畸形项/未知结构；无有效组返回 null（零新显示）。 */
    function normalizeStoryboardGroups(raw) {
      if (!Array.isArray(raw)) return null
      const groups = []
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const groupId = typeof item.groupId === 'string'
          ? item.groupId.trim()
          : item.groupId != null
            ? String(item.groupId).trim()
            : item.id != null
              ? String(item.id).trim()
              : ''
        const name = typeof item.name === 'string' ? item.name.trim() : ''
        const shotNumbers = Array.isArray(item.shotNumbers)
          ? item.shotNumbers.map((shotNumber) => String(shotNumber).trim()).filter(Boolean)
          : []
        const groupPrompt = typeof item.groupPrompt === 'string' ? item.groupPrompt.trim().slice(0, GROUP_PROMPT_MAX) : ''
        const emotionCue = groupEmotionCueText(item.emotionCue != null ? item.emotionCue : item.emotion)
        if (!groupId && !name && !shotNumbers.length && !groupPrompt && !emotionCue) continue
        groups.push({ groupId, name, emotionCue, shotNumbers, groupPrompt })
      }
      return groups.length ? groups : null
    }

    /* ------------------------------------------------------ 设置对象归一化（C-2） */

    // H-2 冻结口径：设置只增字段；旧宿主响应缺字段时用这里的默认值渲染（降级）。
    // v0.16.0 A-C1：历史字段保留（设置默认值仍透传；相关 UI 已随去线性进度移除，旧数据零改动）。
    const DEFAULT_SETTINGS = {
      defaultPlatform: '',
      defaultEpisodeDurationSec: [60, 180],
      defaultOrientation: 'portrait',
      defaultTargetEpisodes: 0,
      retrievalTopK: 5,
      defaultModel: '',
      promptTemplates: {},
      retrievalEnabled: true,
      storageLocation: '',
      strictMode: false,
      // P2-6（Q2，只增字段）：按任务类型的模型参数映射；未配置 = 跟随宿主默认（回退链）。
      taskModels: {},
    }

    // promptTemplates 为 Record<string, string>；以下为约定键（未知键原样保留）。
    const PROMPT_TEMPLATE_KEYS = [
      ['outline', '分集大纲'],
      ['episode', '分集剧本'],
      ['storyboard', '分镜表'],
      ['review', '审读 / 检查'],
      ['polish', '润色'],
    ]

    /* ---------------------------------- P2-6 任务级模型参数（settings.taskModels） */

    // 预留任务键（v0.6.1 仅 audit 被宿主消费；其余键保留但不渲染输入框）。
    const TASK_MODEL_KEYS = ['audit', 'review', 'outline', 'characters', 'episode', 'storyboard']
    const TASK_MODEL_MAX_TOKENS = 60000
    const TASK_MODEL_MAX_TEMPERATURE = 2
    const TASK_MODEL_MIN_TIMEOUT_MS = 1000
    const TASK_MODEL_MAX_TIMEOUT_MS = 60000

    /* ------------------- v0.9.2（P3-E）：成本档位 costTier（可选 enum，只增字段） */
    // 宿主 task-65 口径（待最终确认）：settings.taskModels.<task>.costTier = fast|standard|strong（可选）。
    const COST_TIER_KEYS = ['fast', 'standard', 'strong']
    const COST_TIER_OPTIONS = [
      ['', '使用宿主默认（不指定）'],
      ['fast', 'fast · 低成本'],
      ['standard', 'standard · 标准'],
      ['strong', 'strong · 强模型'],
    ]
    // 宿主 >= 0.9.2 才支持 costTier；旧宿主 SKIP（不发送该字段，避免 400）
    const COST_TIER_MIN_HOST_VERSION = '0.9.2'

    function normalizeCostTier(value) {
      const key = String(value == null ? '' : value).trim().toLowerCase()
      return COST_TIER_KEYS.includes(key) ? key : ''
    }

    function costTierLabel(value) {
      const key = normalizeCostTier(value)
      const hit = COST_TIER_OPTIONS.find(([optionKey]) => optionKey === key)
      return hit ? hit[1] : COST_TIER_OPTIONS[0][1]
    }

    /** 从 settings-save 响应 / 审读报告 meta 的只增字段提取成本档位回退提示（字段名以 host task-65 为准，容错读取）。 */
    function costTierFallbackFrom(payload) {
      const source = payload && typeof payload === 'object' ? payload : {}
      const meta = source.meta && typeof source.meta === 'object' ? source.meta : {}
      const costTier = normalizeCostTier(source.costTier != null ? source.costTier : meta.costTier)
      const requested = normalizeCostTier(source.costTierRequested != null ? source.costTierRequested : meta.costTierRequested)
      const fallback = source.costTierFallback === true || meta.costTierFallback === true
      const reason = typeof source.costTierFallbackReason === 'string'
        ? source.costTierFallbackReason
        : typeof meta.costTierFallbackReason === 'string' ? meta.costTierFallbackReason : ''
      if (!costTier && !requested && !fallback && !reason) return ''
      let text = costTier ? `成本档位：${costTierLabel(costTier)}` : ''
      if (fallback) {
        text += `${text ? ' · ' : ''}请求 ${requested || '—'} 不可用，已回退默认${reason ? '（' + reason + '）' : ''}`
      }
      return text
    }

    /** 归一化单个任务模型配置；非法/越界字段丢弃（不写坏 settings，不做强校验报错）。
     *  P2-6 增强（v0.6.2）：timeoutMs（1000~60000 整数）原样保留/透传，避免面板读→改→保存把它丢掉。
     *  v0.9.2（P3-E）：costTier（fast/standard/strong）可选保留，非法值丢弃。 */
    function normalizeTaskModelEntry(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
      const normalized = {}
      if (typeof entry.provider === 'string') {
        const provider = entry.provider.trim()
        if (provider) normalized.provider = provider.slice(0, 80)
      }
      if (typeof entry.model === 'string') {
        const model = entry.model.trim()
        if (model) normalized.model = model.slice(0, 120)
      }
      const temperature = Number(entry.temperature)
      if (entry.temperature != null && entry.temperature !== '' && Number.isFinite(temperature) && temperature >= 0 && temperature <= TASK_MODEL_MAX_TEMPERATURE) {
        normalized.temperature = Math.round(temperature * 100) / 100
      }
      const maxTokens = Number(entry.maxTokens)
      if (entry.maxTokens != null && entry.maxTokens !== '' && Number.isFinite(maxTokens) && maxTokens >= 1 && maxTokens <= TASK_MODEL_MAX_TOKENS) {
        normalized.maxTokens = Math.round(maxTokens)
      }
      const timeoutMs = Number(entry.timeoutMs)
      if (
        entry.timeoutMs != null && entry.timeoutMs !== '' && Number.isFinite(timeoutMs) && Number.isInteger(timeoutMs) &&
        timeoutMs >= TASK_MODEL_MIN_TIMEOUT_MS && timeoutMs <= TASK_MODEL_MAX_TIMEOUT_MS
      ) {
        normalized.timeoutMs = timeoutMs
      }
      const costTier = normalizeCostTier(entry.costTier)
      if (costTier) normalized.costTier = costTier
      // v0.9.2（P3-E）：costTierModels 属 host 侧高级映射配置，客户端不渲染但必须原样透传（避免读→改→保存丢字段）
      if (entry.costTierModels && typeof entry.costTierModels === 'object' && !Array.isArray(entry.costTierModels)) {
        normalized.costTierModels = entry.costTierModels
      }
      return Object.keys(normalized).length ? normalized : null
    }

    /** 归一化 settings.taskModels：保留已知 + 未知任务键（只过滤非法项），缺省为空对象。 */
    function normalizeTaskModels(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const models = {}
      for (const [key, entry] of Object.entries(raw)) {
        const task = String(key || '').trim().slice(0, 40)
        if (!task) continue
        const normalized = normalizeTaskModelEntry(entry)
        if (normalized) models[task] = normalized
      }
      return models
    }

    function normalizeSettings(raw) {
      const value = raw && typeof raw === 'object' ? raw : {}
      const templates = value.promptTemplates
      const promptTemplates = {}
      if (templates && typeof templates === 'object' && !Array.isArray(templates)) {
        for (const [key, text] of Object.entries(templates)) {
          if (typeof text === 'string') promptTemplates[key] = text
        }
      }
      const duration = Array.isArray(value.defaultEpisodeDurationSec)
        ? value.defaultEpisodeDurationSec
        : DEFAULT_SETTINGS.defaultEpisodeDurationSec
      return {
        ...DEFAULT_SETTINGS,
        ...value,
        defaultEpisodeDurationSec: [Number(duration[0]) || 60, Number(duration[1]) || 180],
        retrievalEnabled: value.retrievalEnabled == null ? true : Boolean(value.retrievalEnabled),
        strictMode: value.strictMode === true,
        taskModels: normalizeTaskModels(value.taskModels),
        promptTemplates,
      }
    }

    /* ------------------------------------- v0.13.0（task-31 / M6-0a）：列表页卡片化纯函数 helper */
    // 首字水印：取首个字符（emoji/代理对安全）；空名回退「剧」
    function projectInitialOf(title) {
      const chars = Array.from(String(title == null ? '' : title).trim())
      return chars.length ? chars[0] : '剧'
    }

    // 封面 3 变体：按标题字符码稳定哈希（同一项目不抖动）
    function projectCoverVariant(title) {
      const text = String(title == null ? '' : title)
      let hash = 0
      for (const ch of text) {
        const code = ch.codePointAt(0) || 0
        hash = (hash * 31 + code) % 9973
      }
      return ['a', 'b', 'c'][hash % 3]
    }

    // 最近修改：mtimeMs / ISO 字符串 / null → 相对时间（null 显示「未知」，不伪造时间）
    function formatProjectUpdatedAt(updatedAt) {
      if (updatedAt == null || updatedAt === '') return '未知'
      const time = typeof updatedAt === 'number' ? updatedAt : new Date(updatedAt).getTime()
      if (!Number.isFinite(time)) return '未知'
      const diff = Date.now() - time
      if (!Number.isFinite(diff)) return '未知'
      if (diff < 60 * 1000) return '刚刚'
      if (diff < 60 * 60 * 1000) return Math.max(1, Math.floor(diff / 60000)) + ' 分钟前'
      if (diff < 24 * 60 * 60 * 1000) return Math.max(1, Math.floor(diff / 3600000)) + ' 小时前'
      if (diff < 30 * 24 * 60 * 60 * 1000) return Math.max(1, Math.floor(diff / 86400000)) + ' 天前'
      return new Date(time).toISOString().slice(0, 10)
    }

    // 状态徽标：客户端按集数推导（非权威流程状态；tooltip 已注明）
    function projectStatusOf(project, targetEpisodes) {
      const count = Number(project && project.episodeCount) || 0
      const goal = Number(targetEpisodes) || 0
      if (count === 0) {
        return { key: 'idle', label: '未开工', hint: '尚未创建分集（客户端按集数推导，非权威流程状态）' }
      }
      if (goal > 0 && count >= goal) {
        return { key: 'ready', label: '待交付', hint: '已完成 ' + count + ' 集 ≥ 默认目标 ' + goal + ' 集（客户端按集数推导，非权威流程状态）' }
      }
      return {
        key: 'making',
        label: '制作中',
        hint: goal > 0
          ? '已完成 ' + count + ' 集 / 默认目标 ' + goal + ' 集（客户端按集数推导，非权威流程状态）'
          : '已完成 ' + count + ' 集（客户端按集数推导，非权威流程状态）',
      }
    }

    /* ------------------------------------------- T8：工具卡片渲染器（A–H 分组） */

    // 失败码表与宿主 lib/tools.js `TOOL_FAILURE_CODES` 对齐（12 类：10 业务码 + aborted/approval-stale，label/next）。
    const FAILURE_CODES = {
      'not-found': { label: '未找到', next: '检查标题 / 路径 / 集数是否存在' },
      'invalid-args': { label: '参数不合法', next: '按工具参数约定修正后重试' },
      conflict: { label: '状态冲突', next: '刷新后重试；必要时先处理草稿或冲突文件' },
      permission: { label: '权限不足', next: '确认工作区目录可写、目标文件未被占用' },
      'budget-exceeded': { label: '预算超限', next: '调整预算上限或减少生成项' },
      'upstream-unavailable': { label: '上游不可用', next: '检查外部 CLI / 画布状态后重试' },
      'io-error': { label: '读写失败', next: '检查磁盘空间与文件占用后重试' },
      timeout: { label: '超时', next: '稍后重试或拆小批量' },
      unsupported: { label: '不支持', next: '换用已支持的后端 / 格式，或升级插件' },
      unknown: { label: '未知错误', next: '查看会话日志定位原因；可重试一次' },
      aborted: { label: '操作已中止', next: '确认后重新发起操作' },
      'approval-stale': { label: '审批已过期', next: '重新发起操作并按提示重新审批' },
    }

    function failureInfo(code) {
      return FAILURE_CODES[String(code || 'unknown')] || FAILURE_CODES.unknown
    }

    /* ------------------------------------- P2-8：错误可读化 / 空态统一组件 */

    // 10 类失败码 → 用户可读文案 +「下一步」+ 恢复动作（retry / reload / refresh / back）。
    // 与宿主 `TOOL_FAILURE_CODES` 对齐；HTTP 层补充 code（failed / host-missing）单独映射。
    const FAILURE_RECOVERY = {
      'not-found': 'reload',
      'invalid-args': 'retry',
      conflict: 'reload',
      permission: 'reload',
      'budget-exceeded': 'retry',
      'upstream-unavailable': 'retry',
      'io-error': 'retry',
      timeout: 'retry',
      unsupported: 'refresh',
      unknown: 'retry',
      aborted: 'retry',
      'approval-stale': 'retry',
      failed: 'retry',
      'host-missing': 'refresh',
    }

    function friendlyErrorInfo(error) {
      const code = String((error && error.code) || 'unknown')
      const base = FAILURE_CODES[code] || FAILURE_CODES.unknown
      const isHttpFailed = code === 'failed'
      const isHostMissing = code === 'host-missing'
      return {
        code,
        label: isHttpFailed ? '操作失败' : isHostMissing ? '宿主能力未就绪' : base.label,
        next: isHttpFailed
          ? '可重试一次；仍失败请查看会话日志（详情见上）'
          : isHostMissing
            ? '升级 / 重启宿主后重试（当前已自动降级，不影响旧功能）'
            : base.next,
        recovery: FAILURE_RECOVERY[code] || 'retry',
        message: String((error && error.message) || ''),
      }
    }

    // 空态统一组件：标题 + 说明 +「下一步」引导 + 可操作按钮（不出现空白屏）。
    function emptyState(options) {
      const actions = Array.isArray(options.actions) ? options.actions.filter(Boolean) : []
      return h('div', { className: 'ad-empty-state', key: options.key, role: 'status' },
        h('div', { className: 'ad-empty-title' }, options.title || '暂无数据'),
        options.description ? h('div', null, options.description) : null,
        options.next ? h('div', { className: 'ad-hint-next' }, `下一步：${options.next}`) : null,
        actions.length
          ? h('div', { className: 'ad-row', style: { marginTop: 8 } },
              actions.map((action, i) => h('button', {
                className: 'ad-btn ad-sm',
                key: i,
                onClick: action.onClick,
                disabled: Boolean(action.disabled),
              }, action.label)))
          : null)
    }

    // 34 个 drama_* 工具 → A–H 卡片分组（依据 `对标-scriptor/工具映射表-v1.md` §三/§四）。
    const TOOL_GROUPS = [
      { id: 'A', label: '项目 / 上下文', renderer: '列表卡 / 详情卡', tools: [
        ['drama_list_projects', '短剧项目列表'], ['drama_create_project', '新建短剧项目'], ['drama_get_project', '项目上下文'],
      ] },
      { id: 'B', label: '内容保存回执', renderer: '保存回执卡', tools: [
        ['drama_save_contract', '保存剧集契约'], ['drama_save_outline', '保存分集大纲'], ['drama_save_characters', '保存人物设定卡'],
        ['drama_save_memory', '保存本剧记忆'], ['drama_save_world', '保存世界观'],
      ] },
      { id: 'C', label: '剧本 / 草稿', renderer: '正文卡 / 列表卡', tools: [
        ['drama_read_episode', '读取剧集剧本'], ['drama_save_draft', '草稿入库'],
        ['drama_list_drafts', '待处理草稿'], ['drama_resolve_draft', '采纳 / 丢弃草稿'],
      ] },
      { id: 'D', label: '检索 / 进度 / 检查', renderer: '命中列表卡 / 进度卡 / 问题卡', tools: [
        ['drama_search_context', '项目上下文检索'], ['drama_get_progress', '创作进度'], ['drama_check_consistency', '一致性检查'],
      ] },
      { id: 'E', label: '台词 / 素材 / 定稿', renderer: '列表卡 / 版本卡 / 统计卡', tools: [
        ['drama_get_dialogue', '台词按角色归集'], ['drama_export_voice_script', '导出配音稿'], ['drama_list_assets', '素材列表'],
        ['drama_add_asset', '素材登记'], ['drama_finalize_episode', '定稿本集'], ['drama_list_finalized', '定稿版本列表'], ['drama_get_ledger', '拍摄账本'],
      ] },
      { id: 'F', label: '导入 / 导出', renderer: '交付卡', tools: [
        ['drama_import_script', '导入剧本'], ['drama_export', '导出交付物'],
      ] },
      { id: 'G', label: '生成编排 / 成本', renderer: '任务卡 / 预算卡 / 批次卡', tools: [
        ['drama_plan_generation', '规划生成任务'], ['drama_record_generation', '记录生成结果'], ['drama_intake_artifact', '产物回流'],
        ['drama_budget', '预算台账'], ['drama_plan_batch', '规划生成批次'], ['drama_submit_batch', '提交生成批次'], ['drama_collect_batch', '收敛生成批次'],
      ] },
      { id: 'H', label: '画布', renderer: '状态卡 / 差异卡', tools: [
        ['drama_canvas_status', '画布绑定状态'], ['drama_bind_canvas', '绑定画布'], ['drama_reconcile_canvas', '画布对账'],
      ] },
    ]

    function toolCard(options) {
      const fields = options.fields || []
      return h('div', { className: 'ad-box ad-toolcard', key: options.key, 'data-tone': options.tone || 'default' },
        h('div', { className: 'ad-toolcard-head' },
          h('strong', null, options.title),
          options.badge ? h('span', { className: 'ad-count' }, options.badge) : null),
        options.subtitle ? h('div', { className: 'ad-sub', style: { marginBottom: 6 } }, options.subtitle) : null,
        fields.length
          ? h('div', null, fields.map(([label, value], i) =>
              h('div', { className: 'ad-kv-row', key: i },
                h('span', { className: 'ad-kv-key' }, label),
                h('span', null, value == null || value === '' ? '—' : String(value)))))
          : null,
        options.children || null,
        options.note ? h('div', { className: 'ad-path' }, options.note) : null,
      )
    }

    function listCard(options) {
      const rows = options.rows || []
      return toolCard({
        key: options.key,
        title: options.title,
        badge: options.badge || (rows.length ? `${rows.length} 条` : '空'),
        tone: rows.length ? 'default' : 'warn',
        subtitle: options.subtitle,
        children: rows.length
          ? h('div', { className: 'ad-hits' }, rows.slice(0, options.limit || 8).map((line, i) => h('div', { className: 'ad-hit', key: i }, line)))
          : h('div', { className: 'ad-hint-next' }, options.empty || '（无数据）'),
        note: options.note,
      })
    }

    function receiptCard(options) {
      return toolCard({
        key: options.key,
        title: options.title,
        badge: options.ok === false ? '失败' : '成功',
        tone: options.ok === false ? 'error' : 'default',
        fields: options.fields,
        note: options.note,
      })
    }

    function issueCard(options) {
      const issues = options.issues || []
      const groups = [
        ['error', '错误'], ['warn', '警告'], ['info', '提示'],
      ]
      return toolCard({
        key: options.key,
        title: options.title,
        badge: issues.length ? `${issues.length} 项` : '通过',
        tone: issues.length ? 'warn' : 'default',
        subtitle: options.subtitle,
        children: issues.length
          ? h('div', null, groups.map(([level, label]) => {
              const list = issues.filter((issue) => issue.severity === level)
              if (!list.length) return null
              return h('div', { key: level, style: { marginBottom: 4 } },
                h('div', { className: 'ad-count' }, `${label} · ${list.length}`),
                h('div', { className: 'ad-hits' }, list.slice(0, 6).map((issue, i) =>
                  h('div', { className: 'ad-hit', key: i },
                    h('div', { className: 'ad-hit-path' }, `${issue.code}${issue.where ? ' · ' + issue.where : ''}`),
                    h('div', null, issue.message)))))
            }))
          : h('div', { className: 'ad-hint-next' }, options.empty || '未发现问题。'),
        note: options.note,
      })
    }

    function failureCodesCard() {
      const codes = Object.keys(FAILURE_CODES)
      return toolCard({
        key: 'failure-codes',
        title: '失败码参考（toolview 兜底）',
        badge: `${codes.length} 类`,
        subtitle: '工具失败统一返回 { ok:false, code, reason, next }；卡片按此显示标题 / 原因 / 下一步。',
        children: h('div', null, codes.map((code) =>
          h('div', { className: 'ad-kv-row', key: code },
            h('span', { className: 'ad-kv-key' }, code),
            h('span', null, `${FAILURE_CODES[code].label} → ${FAILURE_CODES[code].next}`)))),
      })
    }

    // v0.12.0（task-7）：15 页签 4 组（创作 / 资料 / 交付 / 高级）——键不重不漏，草稿计数在渲染时拼
    const TAB_GROUPS = [
      { id: 'create', label: '创作', tabs: ['world', 'outline', 'characters', 'episode', 'storyboard'] },
      { id: 'assets', label: '资料', tabs: ['assets', 'memory', 'drafts', 'ledger'] },
      { id: 'deliver', label: '交付', tabs: ['generate', 'check'] },
      { id: 'advanced', label: '高级', tabs: ['tree', 'toolcards'] },
    ]
    // v0.14.0（task-38 / M6-1）：页签键→静态标签（交接指令/弹窗范围使用；不依赖渲染期局部 Map）
    const TAB_LABEL_MAP = {
      contract: '剧集契约', outline: '总纲', characters: '人物', world: '世界观', episode: '剧本',
      storyboard: '分镜', dialogue: '台词与音效', assets: '素材库', memory: '本剧记忆', drafts: '草稿',
      ledger: '账本', generate: '生成', check: '检查 / 导出', tree: '目录', toolcards: '工具卡片',
    }
    function tabLabelOfKey(key) {
      return TAB_LABEL_MAP[key] || String(key == null ? '' : key)
    }

    // v0.15.2（task-112）：旧「台词与音效」页签（dialogue）并入「剧本」页台词视图。
    // 代码中无 URL query/hash 等外部深链机制；保留 legacy tab-key 兼容，命中时重定向到剧本页 + 台词视图 + 提示。
    const LEGACY_TAB_ALIASES = { dialogue: 'episode' }
    function normalizeTabKey(key) {
      const text = String(key == null ? '' : key)
      return LEGACY_TAB_ALIASES[text] || text
    }
    function isLegacyDialogueTab(key) {
      return String(key == null ? '' : key) === 'dialogue'
    }

    /* ------------------------------- P2-3 AI 审读（展示 / 跳转 / 裁决 / 降级） */

    // 宿主写 <项目>/.aidrama/reviews/<episode>-<ts>.json，并原子更新「最新报告」指针文件；
    // 面板只读（走既有 doc-read，零新增 route/METHOD/调用点；触发由 Agent 工具 drama_check_consistency deep:true 完成）。
    const REVIEW_LATEST_PATH = '.aidrama/reviews/latest.json'
    const REVIEW_FEEDBACK_KEY_PREFIX = 'ai-drama:review-feedback:'
    const REVIEW_SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']
    const REVIEW_SEVERITY_LABELS = {
      critical: '严重', error: '严重', high: '高', warn: '中', warning: '中', medium: '中', low: '低', info: '提示',
    }
    const REVIEW_DIMENSION_LABELS = {
      hook_pacing: '钩子/节奏', hook: '钩子/节奏', pacing: '节奏', character: '人设一致性',
      shootability: '可拍性', dialogue: '台词', platform_redline: '平台红线',
      memory_foreshadow: '记忆/伏笔', memory: '记忆/伏笔', timeline: '时间线/支线',
      format: '格式合规', consistency: '一致性', other: '其他',
    }

    function reviewSeverity(severity) {
      const key = String(severity || 'info').toLowerCase()
      return { key, label: REVIEW_SEVERITY_LABELS[key] || key }
    }

    // 严重度配色：high/error/critical 红，medium/warn 黄，low/info 灰
    function reviewSeverityTone(severity) {
      const key = String(severity || 'info').toLowerCase()
      return ['critical', 'error', 'high'].includes(key) ? 'error' : ['warn', 'warning', 'medium'].includes(key) ? 'warn' : 'info'
    }

    function reviewDimension(dimension) {
      const key = String(dimension || 'other').toLowerCase()
      return { key, label: REVIEW_DIMENSION_LABELS[key] || String(dimension || '其他') }
    }

    /** 定位文案：集 / 场 / 镜（缺失字段不显示，容错）。 */
    function reviewLocationText(location) {
      const loc = location && typeof location === 'object' ? location : {}
      const parts = []
      if (loc.episode != null && String(loc.episode) !== '') parts.push(`第 ${loc.episode} 集`)
      if (loc.scene != null && String(loc.scene) !== '') parts.push(`第 ${loc.scene} 场`)
      if (loc.shot != null && String(loc.shot) !== '') parts.push(`镜 ${loc.shot}`)
      return parts.length ? parts.join(' · ') : '未标注定位'
    }

    /** 容错归一化审读报告（宿主 JSON 缺字段/多写法均不抛错）。 */
    function normalizeReviewReport(raw) {
      const value = raw && typeof raw === 'object' ? raw : {}
      const findingsInput = Array.isArray(value.findings) ? value.findings : []
      const findings = findingsInput
        .filter((item) => item && typeof item === 'object')
        .map((item, index) => {
          const severity = reviewSeverity(item.severity)
          const dimension = reviewDimension(item.dimension)
          return {
            id: String(item.id || `f-${index + 1}`),
            severity: severity.key,
            severityLabel: severity.label,
            dimension: dimension.key,
            dimensionLabel: dimension.label,
            location: item.location && typeof item.location === 'object' ? item.location : {},
            evidence: typeof item.evidence === 'string' ? item.evidence : '',
            suggestion: typeof item.suggestion === 'string' ? item.suggestion : '',
            confidence: typeof item.confidence === 'number' ? item.confidence : null,
            raw: item,
          }
        })
      const degraded = value.degraded === true || (value.meta && value.meta.degraded === true)
      const summaryValue = value.summary
      const summaryText = typeof summaryValue === 'string'
        ? summaryValue
        : summaryValue && typeof summaryValue === 'object'
          ? String(summaryValue.text || summaryValue.summary || '')
          : ''
      // P2-6（v0.6.2）：报告实际使用模型来源 / 回退信息（host 可能放在 meta 或顶层）
      const meta = value.meta && typeof value.meta === 'object' ? value.meta : {}
      const modelSource = typeof meta.modelSource === 'string'
        ? meta.modelSource
        : typeof value.modelSource === 'string' ? value.modelSource : ''
      const modelFallback = meta.modelFallback === true || value.modelFallback === true
      const modelFallbackReason = typeof meta.modelFallbackReason === 'string'
        ? meta.modelFallbackReason
        : typeof value.modelFallbackReason === 'string' ? value.modelFallbackReason : ''
      // v0.9.2（P3-E）：成本档位 + 回退标记（host 只增字段，meta 或顶层）
      const costTier = normalizeCostTier(meta.costTier != null ? meta.costTier : value.costTier)
      const costTierRequested = normalizeCostTier(meta.costTierRequested != null ? meta.costTierRequested : value.costTierRequested)
      const costTierFallback = meta.costTierFallback === true || value.costTierFallback === true
      const costTierFallbackReason = typeof meta.costTierFallbackReason === 'string'
        ? meta.costTierFallbackReason
        : typeof value.costTierFallbackReason === 'string' ? value.costTierFallbackReason : ''
      return {
        episode: value.episode == null ? null : Number(value.episode) || value.episode,
        generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
        degraded,
        degradedReason: typeof value.degradedReason === 'string'
          ? value.degradedReason
          : typeof value.degradeReason === 'string'
            ? value.degradeReason
            : (value.meta && (value.meta.degradedReason || value.meta.degradeReason)) || '',
        modelSource,
        modelFallback,
        modelFallbackReason,
        costTier,
        costTierRequested,
        costTierFallback,
        costTierFallbackReason,
        findings,
        summaryText,
        meta,
        raw: value,
      }
    }

    /* ------------------------- P2-6 增强（v0.6.2）：审读「本次使用模型」标注辅助 */

    const REVIEW_MODEL_SOURCE_LABELS = {
      'task-model': '任务模型',
      'settings-default': '默认模型',
      'agent-default': '宿主默认模型',
      none: '无模型（未实际调用）',
    }

    /** 报告头部标注文案：「本次使用：任务模型（model）（已回退：原因）」。 */
    function reviewModelUsageText(report) {
      if (!report) return ''
      const source = String(report.modelSource || '')
      const model = report.meta && typeof report.meta.model === 'string' ? report.meta.model : ''
      const label = REVIEW_MODEL_SOURCE_LABELS[source] || (source ? source : '未知来源')
      let text = `本次使用：${label}${model ? `（${model}）` : ''}`
      if (report.modelFallback === true) {
        text += `（已回退${report.modelFallbackReason ? '：' + report.modelFallbackReason : ''}）`
      }
      return text
    }

    /* ---------------- v0.6.3：审读展示细化（维度筛选 / 排序 / 摘要 / 证据高亮） */

    const REVIEW_SORT_OPTIONS = [
      ['severity', '按严重度'],
      ['location', '按定位（集/场/镜）'],
      ['confidence', '按置信度'],
    ]

    function reviewSeverityRank(severity) {
      const index = REVIEW_SEVERITY_ORDER.indexOf(String(severity || ''))
      return index < 0 ? REVIEW_SEVERITY_ORDER.length : index
    }

    /** 排序：severity（默认，严重→轻，组内按置信度）/ location（集/场/镜）/ confidence（高→低）。 */
    function sortReviewFindings(list, sortKey) {
      const findings = Array.isArray(list) ? list.slice() : []
      const locationValue = (finding) => {
        const location = (finding && finding.location) || {}
        return [Number(location.episode) || 0, Number(location.scene) || 0, String(location.shot || '').padStart(20, '0')]
      }
      findings.sort((a, b) => {
        if (sortKey === 'location') {
          const left = locationValue(a)
          const right = locationValue(b)
          for (let index = 0; index < 3; index += 1) {
            if (left[index] < right[index]) return -1
            if (left[index] > right[index]) return 1
          }
          return reviewSeverityRank(a.severity) - reviewSeverityRank(b.severity)
        }
        if (sortKey === 'confidence') return (Number(b.confidence) || 0) - (Number(a.confidence) || 0)
        return reviewSeverityRank(a.severity) - reviewSeverityRank(b.severity) || (Number(b.confidence) || 0) - (Number(a.confidence) || 0)
      })
      return findings
    }

    // evidence 高亮：引号内原文片段 / 集场镜定位 / 数量词加 <mark>，便于快速定位证据。
    const REVIEW_EVIDENCE_HIGHLIGHT_RE = /(「[^」]{1,80}」|"[^"]{1,80}"|『[^』]{1,80}』|第\s*\d+\s*[集场镜][^\s，。；]*|\d+(?:\.\d+)?\s*(?:秒|分钟|ms|字|集|场|镜))/g

    function renderReviewEvidence(text) {
      const source = String(text || '')
      if (!source) return null
      const parts = []
      let lastIndex = 0
      REVIEW_EVIDENCE_HIGHLIGHT_RE.lastIndex = 0
      let match
      while ((match = REVIEW_EVIDENCE_HIGHLIGHT_RE.exec(source)) !== null) {
        if (match.index > lastIndex) parts.push(source.slice(lastIndex, match.index))
        parts.push(h('mark', { className: 'ad-evidence-mark', key: `ev-${parts.length}` }, match[0]))
        lastIndex = match.index + match[0].length
      }
      if (lastIndex < source.length) parts.push(source.slice(lastIndex))
      return h('div', { className: 'ad-review-evidence ad-evidence-highlight' }, '证据：', parts)
    }

    /* ---------------- v0.6.3：任务模型「最近使用」（仅 client localStorage 本地记录） */

    const TASK_MODEL_RECENT_KEY = 'ai-drama:task-model-recent'
    const TASK_MODEL_RECENT_LIMIT = 8

    function loadRecentTaskModels() {
      try {
        const raw = window.localStorage.getItem(TASK_MODEL_RECENT_KEY)
        const parsed = raw ? JSON.parse(raw) : null
        if (!Array.isArray(parsed)) return []
        return parsed
          .filter((item) => item && typeof item === 'object' && typeof item.model === 'string' && item.model.trim())
          .map((item) => ({ provider: typeof item.provider === 'string' ? item.provider : '', model: String(item.model).trim() }))
          .slice(0, TASK_MODEL_RECENT_LIMIT)
      } catch {
        return []
      }
    }

    function saveRecentTaskModels(list) {
      try {
        window.localStorage.setItem(TASK_MODEL_RECENT_KEY, JSON.stringify((Array.isArray(list) ? list : []).slice(0, TASK_MODEL_RECENT_LIMIT)))
      } catch {
        /* 隐私模式等场景不阻断 */
      }
    }

    function mergeRecentTaskModel(list, entry) {
      const model = entry && typeof entry.model === 'string' ? entry.model.trim() : ''
      if (!model) return Array.isArray(list) ? list : []
      const provider = entry && typeof entry.provider === 'string' ? entry.provider.trim() : ''
      const rest = (Array.isArray(list) ? list : []).filter((item) => !(item.model === model && item.provider === provider))
      return [{ provider, model }, ...rest].slice(0, TASK_MODEL_RECENT_LIMIT)
    }

    /* ---------------------------------------------------------------- 样式 */

    const CSS = `
body{
  /* ================= 主题派生层（v0.12.0 · task-6；v0.13.1 task-33 根因修复） =================
   * v0.13.1（task-33）根因：宿主 alias token（dsw-alias 系列）定义在 body（dsh-client-ui-theme
   * design_platform_css_default 的 body 规则；深色为 body[data-ds-dark-theme]），而派生层原写在
   * :root（html，body 的父级）→ 在 :root 解析不到子级 body 的 --dsw-* → 17 个 --ad-* 全部 computed
   * invalid → 运行期所有颜色/背景/边框/阴影/渐变失效（仅结构 CSS 生效；v0.12.1 g2 浮层透明同根因）。
   * 修复：派生块改挂 body（对插件全部自渲染子树生效，浅/深主题随 body[data-ds-dark-theme] 自动翻转）。
   * 合规口径：业务规则一律引用 --ad-*；本 body 块是插件内唯一定义 --ad-* / 唯一出现 dsw 主题变量的位置
   * （业务 CSS 不直连 --dsw-*；v0.13.1 按 qa/visual 规范以 base（无 color-mix）+ @supports 增强双写）。
   * 官方白名单 14 项 = 13 个 dsw-alias 变量 + 1 个 dsw-specific-sidebar-fill（浅/深双套）；
   * 来源：证据/UI评审-框架能力-2026-10-19.md §5（Client Inspect live 实测）。
   * 语义色/弱底/边框由官方 token + color-mix 派生，自动跟随浅/深主题。 */
  --ad-bg-base:var(--dsw-alias-bg-base);
  --ad-label-primary:var(--dsw-alias-label-primary);
  --ad-label-secondary:var(--dsw-alias-label-secondary);
  --ad-brand:var(--dsw-alias-brand-primary);
  /* 主按钮反色：底=brand-primary（浅#0f1115/深#f9fafb），字=bg-base（浅#fff/深#151517）→ 18.90 / 17.45 */
  --ad-on-brand:var(--dsw-alias-bg-base);
  /* 主按钮 hover：brand 88% + bg-base 12%（浅≈#2c2e31/深≈#dedfe0）→ 13.62 / 13.67 */
  --ad-primary-hover-bg:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,var(--dsw-alias-bg-base));
  /* 语义文字：纯 state-*-primary 在浅色正文不达标（warn 2.15 / success 2.28 / error 4.50，错误底约 4.3），
   * 与随主题翻转的 label-primary 混合后，浅/深均 ≥4.5（计算见交付报告） */
  --ad-error:color-mix(in srgb,var(--dsw-alias-state-error-primary) 75%,var(--dsw-alias-label-primary));
  --ad-warn:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-label-primary));
  --ad-success:color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,var(--dsw-alias-label-primary));
  /* 语义弱底/边框：官方语义色低透明度叠加（浅/深自动适配） */
  --ad-error-bg:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);
  --ad-warning-bg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);
  --ad-error-border:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);
  --ad-warning-border:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent);
  /* 弱底/边框/分隔：由 label-primary 低透明度派生（bg-layer-1/2 在浅色=页面底色 #fff，用其会失去层级） */
  --ad-subtle-bg:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);
  --ad-hover-bg:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);
  --ad-border:var(--dsw-alias-border-l2);
  --ad-divider:var(--dsw-alias-border-l1);
}
.ad-shell{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--ad-label-primary);background:var(--ad-bg-base)}
/* v0.12.4（task-25 / M5-B）：视觉隐藏但可被读屏读取（表格 caption 等；不占布局、0 视觉变化） */
.ad-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.ad-head{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--ad-border);flex:none}
.ad-title{font-size:16px;font-weight:600}
.ad-sub{font-size:12px;color:var(--ad-label-secondary)}
.ad-body{flex:1;min-height:0;overflow:auto;padding:16px 18px}
.ad-btn{border:1px solid var(--ad-border);background:transparent;color:inherit;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;white-space:nowrap}
.ad-btn:not(.ad-primary):hover{background:var(--ad-hover-bg)}
.ad-btn[disabled]{opacity:.5;cursor:default}
.ad-primary{border-color:transparent;background:var(--ad-brand);color:var(--ad-on-brand)}
.ad-primary:hover{background:var(--ad-primary-hover-bg)}
.ad-sm{padding:4px 10px;font-size:12px}
.ad-card{border:1px solid var(--ad-border);border-radius:10px;padding:12px 14px;margin-bottom:10px;display:flex;align-items:center;gap:12px}
.ad-card-main{flex:1;min-width:0}
.ad-card-title{font-size:14px;font-weight:600;margin-bottom:2px}
.ad-card-meta{font-size:12px;color:var(--ad-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ad-empty{color:var(--ad-label-secondary);font-size:13px;line-height:1.9}
.ad-err{color:var(--ad-error);font-size:13px;line-height:1.8}.ad-warn{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--ad-warning-bg);color:var(--ad-warn);border:1px solid var(--ad-warning-border)}
.ad-row{display:flex;align-items:center;gap:8px}
.ad-input,.ad-select,.ad-area{padding:6px 10px;font-size:13px;border-radius:8px;border:1px solid var(--ad-border);background:transparent;color:inherit;font-family:inherit;box-sizing:border-box}
.ad-input{flex:1;min-width:0}
.ad-area{width:100%;resize:vertical;line-height:1.7}
.ad-tabs{display:flex;align-items:flex-start;gap:8px;border-bottom:1px solid var(--ad-border);margin-bottom:12px;flex:none}
.ad-tab{border:0;background:transparent;color:inherit;padding:7px 12px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;opacity:.7}
.ad-tab[data-on="1"]{opacity:1;font-weight:600;color:var(--ad-label-primary);border-bottom-color:var(--ad-brand)}
.ad-field{display:flex;gap:10px;align-items:flex-start;margin-bottom:8px}
.ad-field > label{width:110px;flex:none;font-size:13px;padding-top:7px;color:var(--ad-label-secondary)}
.ad-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.ad-box{border:1px solid var(--ad-border);border-radius:10px;padding:12px}
.ad-table{width:100%;border-collapse:collapse;font-size:12px}
.ad-table th,.ad-table td{border:1px solid var(--ad-border);padding:4px 6px;text-align:left;vertical-align:top}
.ad-table th{background:var(--ad-subtle-bg);font-weight:600;white-space:nowrap}
.ad-table input,.ad-table textarea{width:100%;border:0;background:transparent;color:inherit;font:inherit;padding:2px;box-sizing:border-box;resize:vertical}
.ad-table input:focus,.ad-table textarea:focus{outline:1px solid var(--ad-brand);border-radius:3px}
.ad-node{display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0}
.ad-count{font-size:12px;color:var(--ad-label-secondary)}
.ad-path{font-size:12px;color:var(--ad-label-secondary);margin-top:14px;word-break:break-all;line-height:1.7}
.ad-flash{font-size:12px;color:var(--ad-success)}
.ad-hits{font-size:12px;line-height:1.7}
.ad-hit{padding:5px 0;border-bottom:1px dotted var(--ad-border)}
.ad-hit-path{color:var(--ad-label-secondary);font-size:12px}
.ad-sec{font-size:14px;font-weight:600;margin:12px 0 8px}
.ad-pre{margin:0;padding:8px 10px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;border-radius:6px;background:var(--ad-subtle-bg);font-family:Consolas,Menlo,monospace}
.ad-dirty{font-size:12px;color:var(--ad-warn)}
.ad-ok{font-size:12px;color:var(--ad-success)}
.ad-scenes{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:10px;margin-top:10px}
.ad-scene{border:1px solid var(--ad-border);border-radius:10px;padding:10px 12px;background:var(--ad-subtle-bg)}
.ad-scene-head{font-size:13px;font-weight:600;margin-bottom:3px;word-break:break-word}
.ad-scene-meta{font-size:12px;color:var(--ad-label-secondary);margin-bottom:6px}
.ad-scene-line{font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:140px;overflow:auto}
.ad-check{width:14px;height:14px;cursor:pointer;accent-color:var(--ad-brand);flex:none}
.ad-node-ops{display:flex;align-items:center;gap:4px;margin-left:auto}
.ad-toolcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;margin-top:8px}
.ad-toolcard{display:flex;flex-direction:column;gap:2px}
.ad-toolcard[data-tone="warn"]{border-color:var(--ad-warning-border)}
.ad-toolcard[data-tone="error"]{border-color:var(--ad-error-border)}
.ad-toolcard-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ad-kv-row{display:flex;gap:8px;font-size:12px;line-height:1.8;word-break:break-word}
.ad-kv-key{color:var(--ad-label-secondary);min-width:92px;flex:none}
.ad-tool-title{font-size:12px;font-weight:600;margin:14px 0 6px}
.ad-fold{margin-top:6px;font-size:12px;color:var(--ad-label-secondary)}
.ad-fold summary{cursor:pointer}
.ad-shell-row{flex:1;min-height:0;display:flex;align-items:stretch}
.ad-main-col{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
.ad-doc{width:40%;min-width:320px;max-width:620px;border-left:1px solid var(--ad-border);display:flex;flex-direction:column;min-height:0;background:var(--ad-bg-base)}
.ad-doc-head{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-bottom:1px solid var(--ad-border);flex:none}
.ad-doc-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
.ad-doc-meta{font-size:12px;color:var(--ad-label-secondary);line-height:1.7;word-break:break-all}
.ad-doc-area{flex:1;min-height:160px;width:100%;box-sizing:border-box;padding:10px 12px;border:0;resize:none;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:1.8;color:inherit;background:transparent}
.ad-doc-area:focus{outline:1px solid var(--ad-brand);outline-offset:-1px}
.ad-doc-foot{padding:6px 12px 12px;flex:none;display:flex;flex-direction:column;gap:6px}
.ad-doc-conflict{margin:8px 12px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--ad-warning-bg);color:var(--ad-warn);border:1px solid var(--ad-warning-border)}
.ad-doc-note{margin:8px 12px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--ad-subtle-bg);color:var(--ad-label-secondary)}
.ad-doc-err{margin:8px 12px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--ad-error-bg);color:var(--ad-error);border:1px solid var(--ad-error-border)}
.ad-flow-hint{font-size:12px;color:var(--ad-label-secondary)}
.ad-flow-stale{margin:0 0 10px;padding:7px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--ad-warning-bg);color:var(--ad-warn);border:1px solid var(--ad-warning-border)}
.ad-err-box{margin:0 0 12px;padding:10px 12px;border-radius:10px;border:1px solid var(--ad-error-border);background:var(--ad-error-bg);display:flex;flex-direction:column;gap:4px}
.ad-err-head{font-size:12px;font-weight:600;color:var(--ad-error)}
.ad-err-next{font-size:12px;line-height:1.8;color:var(--ad-warn)}
.ad-err-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.ad-empty-state{padding:14px 16px;border:1px dashed var(--ad-border);border-radius:10px;line-height:1.9;font-size:13px;color:var(--ad-label-secondary)}
.ad-empty-title{font-size:13px;font-weight:600;color:var(--ad-label-primary);margin-bottom:4px}
.ad-hint-next{font-size:12px;line-height:1.8;color:var(--ad-label-secondary);margin-top:4px}
.ad-review-finding{margin-bottom:10px}
.ad-review-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.ad-sev{font-size:12px;padding:1px 7px;border-radius:999px;border:1px solid var(--ad-border)}
.ad-sev[data-tone="error"]{background:var(--ad-error-bg);color:var(--ad-error);border-color:var(--ad-error-border)}
.ad-sev[data-tone="warn"]{background:var(--ad-warning-bg);color:var(--ad-warn);border-color:var(--ad-warning-border)}
.ad-sev[data-tone="info"]{background:var(--ad-subtle-bg);color:var(--ad-label-secondary)}
.ad-review-evidence{margin:4px 0;padding:6px 8px;border-left:2px solid var(--ad-brand);background:var(--ad-subtle-bg);font-size:12px;line-height:1.8;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}
.ad-review-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.ad-shot-extras{padding:8px 10px;border-radius:8px;background:var(--ad-subtle-bg);font-size:12px;line-height:1.9;color:var(--ad-label-secondary);white-space:pre-wrap;word-break:break-word}
.ad-shot-extra{max-height:120px;overflow:auto}
.ad-shot-extra strong{color:var(--ad-label-primary);margin-right:4px}
.ad-groups{margin-top:10px;padding:8px 10px;border-radius:8px;background:var(--ad-subtle-bg)}
.ad-group{padding:6px 0;border-top:1px solid var(--ad-divider);font-size:12px;line-height:1.8}
.ad-group:first-child{border-top:none;padding-top:0}
.ad-group-prompt{margin-top:4px;padding:6px 8px;border-radius:6px;background:var(--ad-bg-base);white-space:pre-wrap;word-break:break-word;max-height:140px;overflow:auto;font-size:12px;line-height:1.8;color:var(--ad-label-secondary)}
.ad-evidence-highlight .ad-evidence-mark,mark.ad-evidence-mark{background:var(--ad-warning-bg);color:inherit;padding:0 2px;border-radius:2px;border-bottom:1px solid var(--ad-warning-border)}
.ad-skeleton{display:flex;flex-direction:column;gap:10px;padding:6px 2px}
.ad-skeleton-line{height:14px;border-radius:6px;background:var(--ad-subtle-bg);animation:ad-skeleton-pulse 1.2s ease-in-out infinite}
.ad-skeleton-line.w40{width:40%}.ad-skeleton-line.w60{width:60%}.ad-skeleton-line.w80{width:80%}.ad-skeleton-line.w90{width:90%}
@keyframes ad-skeleton-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.ad-review-status{font-size:12px;color:var(--ad-success)}
/* v0.11.5（task-4）：未保存离开守卫对话框 + 保存态（仅新增类，不改既有类） */
.ad-save-state{font-size:12px;white-space:nowrap}
.ad-tab-dirty{font-size:12px;margin-left:4px}
.ad-modal-backdrop{position:fixed;inset:0;z-index:9999;isolation:isolate;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.4)}
.ad-modal{width:100%;max-width:460px;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:16px 18px;border-radius:12px;border:1px solid var(--ad-border);background-color:var(--ad-bg-base);background-clip:padding-box;color:var(--ad-label-primary);box-shadow:0 12px 40px rgba(0,0,0,.28);word-break:break-word}
.ad-modal-title{font-size:14px;font-weight:600}
.ad-modal-desc{font-size:12px;line-height:1.8;color:var(--ad-label-secondary)}
.ad-modal-desc strong{color:var(--ad-label-primary)}
.ad-modal-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
/* v0.12.0（task-7）：宽屏版式 + IA（内容宽度/控件定宽/页签分组/危险按钮/表格空态/表单分组） */
.ad-content{width:100%;max-width:1200px;margin:0 auto}
.ad-list-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.ad-list-toolbar .ad-input{flex:1 1 320px;max-width:520px}
.ad-cta{padding:7px 18px;font-weight:600}
.ad-tab-groups{display:flex;align-items:center;flex-wrap:wrap;gap:6px 16px;flex:1;min-width:0}
.ad-tab-group{display:flex;align-items:center;gap:2px;padding-right:12px;border-right:1px solid var(--ad-divider)}
.ad-tab-group:last-child{border-right:0;padding-right:0}
.ad-tab-group-label{font-size:12px;color:var(--ad-label-secondary);padding-right:4px;white-space:nowrap}
.ad-tabs-more{display:none;position:relative;flex:none}
.ad-tabs-more-panel{position:absolute;z-index:50;top:calc(100% + 4px);right:0;min-width:240px;max-width:min(560px,90vw);padding:8px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-bg-base);box-shadow:0 12px 40px rgba(0,0,0,.22);display:flex;flex-wrap:wrap;gap:6px}
.ad-tabpanel{min-width:0}
.ad-btn-danger{border-color:var(--ad-error-border);color:var(--ad-error)}
.ad-btn-danger:hover{background:var(--ad-error-bg)}
.ad-table-empty{color:var(--ad-label-secondary);font-size:12px;padding:10px 6px;text-align:center}
.ad-form-group{margin-bottom:16px;padding-bottom:4px;border-bottom:1px solid var(--ad-divider)}
.ad-form-group:last-of-type{border-bottom:0;margin-bottom:0;padding-bottom:0}
.ad-form-group > .ad-sec{margin:0 0 10px}
.ad-field > .ad-area{max-width:760px}
.ad-field > .ad-input{max-width:480px}
.ad-field > .ad-input[type="number"]{max-width:120px}
.ad-select{max-width:220px}
@media (max-width:900px){
  .ad-tab-groups{display:none}
  .ad-tabs-more{display:block}
  .ad-content{max-width:none}
  /* v0.12.4（task-25 / M5-B）：窄窗间距/密度细节（仅 --ad-*） */
  .ad-settings-grid{grid-template-columns:1fr}
  .ad-field{flex-wrap:wrap}
  .ad-field > label{width:auto;flex-basis:100%;padding-top:0}
  .ad-modal-backdrop{padding:12px}
}
/* v0.12.1（task-8）：独立设置页 / 项目页设置浮层（复用同一 SettingsSection 组件；仅 --ad-*） */
.ad-settings-page{display:flex;flex-direction:column;gap:12px;max-width:920px;min-width:0;color:var(--ad-label-primary)}
.ad-settings-head{display:flex;flex-direction:column;gap:4px}
.ad-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px 12px}
.ad-settings-overlay-panel{max-width:920px;max-height:85vh;overflow:auto;align-items:stretch;background-color:var(--ad-bg-base);isolation:isolate;z-index:1}
.ad-settings-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}
.ad-settings-diag{display:flex;flex-direction:column;gap:4px}
/* v0.12.1（task-17）：会话内 drama_check_consistency 工具卡（只读；仅 --ad-*） */
.ad-toolview{display:flex;flex-direction:column;gap:6px;margin:4px 0;padding:8px 12px;box-sizing:border-box;max-width:100%;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-bg-base);color:var(--ad-label-primary);font-size:12px;line-height:1.8}
.ad-toolview-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ad-toolview-title{font-weight:600}
.ad-toolview-tool{font-size:12px;color:var(--ad-label-secondary)}
.ad-toolview-badge{font-size:12px;padding:0 7px;border-radius:999px;border:1px solid var(--ad-border);color:var(--ad-label-secondary)}
.ad-toolview-badge[data-state="preparing"],.ad-toolview-badge[data-state="running"]{color:var(--ad-warn);border-color:var(--ad-warning-border);background:var(--ad-warning-bg)}
.ad-toolview-badge[data-state="ok"]{color:var(--ad-success);background:var(--ad-subtle-bg)}
.ad-toolview-badge[data-state="error"],.ad-toolview-badge[data-state="stopped"]{color:var(--ad-error);border-color:var(--ad-error-border);background:var(--ad-error-bg)}
.ad-toolview-args{font-size:12px;color:var(--ad-label-secondary)}
.ad-toolview-hint{font-size:12px;color:var(--ad-label-secondary)}
.ad-toolview-summary{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ad-toolview-chip{font-size:12px;padding:0 7px;border-radius:999px;background:var(--ad-subtle-bg);border:1px solid var(--ad-border);color:var(--ad-label-secondary)}
.ad-toolview-chip[data-tone="error"]{color:var(--ad-error);background:var(--ad-error-bg);border-color:var(--ad-error-border)}
.ad-toolview-chip[data-tone="warn"]{color:var(--ad-warn);background:var(--ad-warning-bg);border-color:var(--ad-warning-border)}
.ad-toolview-sev{font-size:12px;padding:0 6px;border-radius:6px;border:1px solid var(--ad-border);color:var(--ad-label-secondary)}
.ad-toolview-sev[data-tone="error"]{color:var(--ad-error);border-color:var(--ad-error-border)}
.ad-toolview-sev[data-tone="warn"]{color:var(--ad-warn);border-color:var(--ad-warning-border)}
.ad-toolview-list{display:flex;flex-direction:column;gap:4px}
.ad-toolview-issue{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:12px}
.ad-toolview-issue-msg{word-break:break-word}
.ad-toolview-where{font-size:12px;color:var(--ad-label-secondary)}
.ad-toolview-deep{margin-top:2px;padding-top:6px;border-top:1px dashed var(--ad-divider);display:flex;flex-direction:column;gap:4px}
.ad-toolview-sub{font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ad-toolview-conclusion{font-size:12px}
.ad-toolview-finding{display:flex;flex-direction:column;gap:2px;padding-left:8px;border-left:2px solid var(--ad-border);font-size:12px}
.ad-toolview-finding-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.ad-toolview-dim{color:var(--ad-label-secondary)}
.ad-toolview-evidence,.ad-toolview-suggestion{word-break:break-word;color:var(--ad-label-secondary)}
.ad-toolview-next{font-size:12px;color:var(--ad-warn)}
.ad-toolview-ok{color:var(--ad-success);font-size:12px}
.ad-toolview-error-title{font-weight:600;color:var(--ad-error)}
.ad-toolview-error-body,.ad-toolview-pre{white-space:pre-wrap;word-break:break-word;background:var(--ad-subtle-bg);border-radius:6px;padding:6px 8px;font-size:12px;line-height:1.8;max-height:160px;overflow:auto;color:var(--ad-label-secondary)}
.ad-toolview-foot{border-top:1px solid var(--ad-divider);padding-top:6px;font-size:12px;color:var(--ad-label-secondary)}
/* v0.12.4（task-24 / M5-A）：键盘可见焦点（仅 --ad-*；outline 不占布局，不影响既有像素断言） */
.ad-shell :focus-visible,.ad-btn:focus-visible,.ad-tab:focus-visible,.ad-input:focus-visible,.ad-select:focus-visible,.ad-area:focus-visible,.ad-check:focus-visible{outline:2px solid var(--ad-brand);outline-offset:2px}
.ad-tab:focus-visible{outline-offset:-2px}
/* v0.13.1（task-33）：A 根因（token 块 body）+ B 视觉增强 v2 —— base 纯 token（必生效）+ enhanced 混色增强叠加 */
/* 卡片：base = subtle 表面 + 官方边框 + ::after 描边环 + ::before 投影层（均不依赖混色） */
.ad-list-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:16px 0 10px;border-bottom:1px solid var(--ad-divider)}
.ad-source-row{padding-bottom:10px;border-bottom:1px solid var(--ad-divider)}
.ad-list-toolbar{background:var(--ad-subtle-bg);border:1px solid var(--ad-border);border-radius:12px;padding:12px 14px;margin-bottom:12px}
.ad-create-hero{background:var(--ad-subtle-bg);border:1px solid var(--ad-border);box-shadow:0 2px 8px var(--ad-border);border-radius:12px;padding:12px 14px}
.ad-project-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(272px,1fr));gap:18px;margin-top:4px}
.ad-project-card{position:relative;display:flex;flex-direction:column;min-width:0;background:var(--ad-subtle-bg);border:1px solid var(--ad-border);border-radius:12px;color:var(--ad-label-primary);transition:transform 160ms ease,border-color 160ms ease}
.ad-project-card::before{content:"";position:absolute;inset:0;border-radius:12px;box-shadow:0 8px 20px var(--ad-label-primary);opacity:.1;z-index:-1;pointer-events:none}
.ad-project-card::after{content:"";position:absolute;inset:0;border:1px solid var(--ad-label-primary);border-radius:12px;opacity:.2;pointer-events:none}
.ad-project-card:hover{transform:translateY(-2px);border-color:var(--ad-brand)}
.ad-project-card:active{transform:translateY(0)}
.ad-project-card:focus-within{border-color:var(--ad-brand)}
.ad-project-cover{position:relative;display:block;width:100%;height:162px;padding:0;border:0;border-radius:12px 12px 0 0;overflow:hidden;cursor:pointer;text-align:left;color:inherit;font:inherit;-webkit-appearance:none;appearance:none;background:var(--ad-bg-base)}
@supports (aspect-ratio:16/9){.ad-project-cover{height:auto;aspect-ratio:16/9}}
.ad-project-cover[data-cover="a"]{background:linear-gradient(135deg,var(--ad-brand) 0%,var(--ad-bg-base) 92%)}
.ad-project-cover[data-cover="b"]{background:linear-gradient(135deg,var(--ad-warn) 0%,var(--ad-bg-base) 92%)}
.ad-project-cover[data-cover="c"]{background:linear-gradient(135deg,var(--ad-error) 0%,var(--ad-bg-base) 92%)}
.ad-project-cover::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(95% 75% at 18% 0%,var(--ad-bg-base),transparent 62%),linear-gradient(to top,var(--ad-label-primary),transparent 58%);opacity:.4}
.ad-project-cover::after{content:attr(data-initial);position:absolute;left:16px;bottom:12px;font-size:44px;line-height:1;font-weight:800;color:var(--ad-bg-base);pointer-events:none}
.ad-project-cover:disabled{opacity:.6;cursor:default}
.ad-project-badge{position:absolute;top:10px;right:10px;display:inline-flex;align-items:center;height:22px;padding:2px 9px;border-radius:999px;border:1px solid var(--ad-border);background:var(--ad-bg-base);color:var(--ad-label-secondary);font-size:12px;font-weight:600;line-height:1;white-space:nowrap}
.ad-project-badge::before{content:"";display:inline-block;width:6px;height:6px;border-radius:999px;margin-right:6px;background:var(--ad-label-secondary)}
.ad-project-badge[data-state="making"]{color:var(--ad-label-primary);border-color:var(--ad-warning-border)}
.ad-project-badge[data-state="making"]::before{background:var(--ad-warn)}
.ad-project-badge[data-state="ready"]{color:var(--ad-label-primary);border-color:var(--ad-success)}
.ad-project-badge[data-state="ready"]::before{background:var(--ad-success)}
.ad-project-chip{position:absolute;right:10px;bottom:10px;padding:2px 8px;border-radius:999px;border:1px solid var(--ad-border);background:var(--ad-bg-base);color:var(--ad-label-primary);font-size:12px;line-height:1.4;white-space:nowrap}
.ad-project-body{display:flex;flex-direction:column;gap:8px;padding:14px 16px 16px;min-width:0}
.ad-project-title{font-size:14px;font-weight:600;line-height:22px;color:var(--ad-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ad-project-meta{font-size:12px;line-height:18px;color:var(--ad-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ad-project-progress-wrap{display:flex;align-items:center;gap:8px;min-width:0}
.ad-project-progress{flex:1;height:6px;min-width:40px;border-radius:999px;background:var(--ad-border);overflow:hidden}
.ad-project-progress-bar{height:100%;border-radius:999px;background:var(--ad-brand);transition:width 160ms ease}
.ad-project-progress-label{font-size:12px;color:var(--ad-label-secondary);white-space:nowrap}
.ad-project-actions{display:flex;align-items:center;gap:8px;margin-top:2px}
.ad-project-more{position:relative;margin-left:auto}
.ad-project-more>summary{list-style:none;cursor:pointer}
.ad-project-more>summary::-webkit-details-marker{display:none}
.ad-project-more-panel{position:absolute;right:0;top:calc(100% + 6px);z-index:50;display:flex;flex-direction:column;gap:2px;min-width:170px;padding:6px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-bg-base);box-shadow:0 2px 8px var(--ad-border)}
.ad-project-more-item{display:block;width:100%;padding:6px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font-size:12px;text-align:left;cursor:pointer}
.ad-project-more-item:hover{background:var(--ad-hover-bg)}
.ad-project-more-danger{color:var(--ad-error)}
.ad-project-more-danger:hover{background:var(--ad-error-bg)}
.ad-project-more-path{margin-top:2px;padding:4px 10px 2px;border-top:1px solid var(--ad-divider);color:var(--ad-label-secondary);font-size:12px;word-break:break-all}
.ad-empty-poster{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid var(--ad-border);border-radius:12px;background:var(--ad-subtle-bg)}
.ad-empty-poster::before{content:"";flex:none;width:64px;height:44px;border-radius:8px;border:1px solid var(--ad-border);background:linear-gradient(135deg,var(--ad-brand),var(--ad-subtle-bg))}
.ad-empty-poster>*{flex:1;min-width:0}
.ad-empty-poster .ad-empty-state{border:0;padding:0;background:none;line-height:inherit}
.ad-shared-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
.ad-shared-card{display:flex;align-items:center;gap:6px;padding:10px 12px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-bg-base);color:var(--ad-label-primary);font-size:13px;text-align:left;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.ad-shared-card:hover{background:var(--ad-hover-bg);border-color:var(--ad-brand)}
.ad-shared-empty{display:flex;align-items:center;gap:12px}
.ad-shared-empty::before{content:"";flex:none;width:44px;height:34px;border-radius:6px;border:1px solid var(--ad-border);background:linear-gradient(135deg,var(--ad-brand),var(--ad-subtle-bg))}
.ad-shared-empty>*{flex:1;min-width:0}
.ad-project-skeleton-card{display:flex;flex-direction:column;gap:8px;padding:0 0 12px;border:1px solid var(--ad-border);border-radius:12px;overflow:hidden}
.ad-project-skeleton-cover{height:162px;background:var(--ad-subtle-bg);animation:ad-skeleton-pulse 1.2s ease-in-out infinite}
.ad-project-skeleton-card .ad-skeleton-line{margin:0 14px}
/* 共享资料区独立表面（区块层次 V4） */
#ad-shared-surface{background:var(--ad-subtle-bg);border:1px solid var(--ad-border);border-radius:12px;padding:14px 16px;margin-top:14px}
@media (prefers-reduced-motion: reduce){.ad-project-card,.ad-project-cover,.ad-project-progress-bar{transition:none}.ad-project-card:hover,.ad-project-card:active{transform:none}}
@media (max-width:560px){.ad-project-grid{grid-template-columns:1fr}}
/* enhanced：仅当宿主支持混色时叠加（base 已保证降级场景可见） */
@supports (color: color-mix(in srgb, red 1%, blue)){
  .ad-project-card{background:color-mix(in srgb,var(--ad-label-primary) 6%,var(--ad-bg-base));border-color:color-mix(in srgb,var(--ad-brand) 22%,var(--ad-border));box-shadow:0 1px 2px color-mix(in srgb,var(--ad-label-primary) 8%,transparent),0 10px 26px color-mix(in srgb,var(--ad-label-primary) 12%,transparent)}
  .ad-project-card::after{opacity:.16}
  .ad-project-card:hover{border-color:color-mix(in srgb,var(--ad-brand) 34%,var(--ad-border));box-shadow:0 14px 32px color-mix(in srgb,var(--ad-label-primary) 16%,transparent)}
  .ad-project-cover[data-cover="a"]{background:linear-gradient(135deg,color-mix(in srgb,var(--ad-brand) 78%,var(--ad-bg-base)) 0%,color-mix(in srgb,var(--ad-brand) 42%,var(--ad-bg-base)) 55%,var(--ad-bg-base) 100%)}
  .ad-project-cover[data-cover="b"]{background:linear-gradient(135deg,color-mix(in srgb,var(--ad-warn) 72%,var(--ad-bg-base)) 0%,color-mix(in srgb,var(--ad-warn) 30%,var(--ad-bg-base)) 60%,var(--ad-bg-base) 100%)}
  .ad-project-cover[data-cover="c"]{background:linear-gradient(135deg,color-mix(in srgb,var(--ad-error) 68%,var(--ad-bg-base)) 0%,color-mix(in srgb,var(--ad-error) 26%,var(--ad-bg-base)) 60%,var(--ad-bg-base) 100%)}
  .ad-project-cover::before{opacity:.34;background:radial-gradient(95% 75% at 18% 0%,color-mix(in srgb,var(--ad-bg-base) 55%,transparent),transparent 62%),linear-gradient(to top,color-mix(in srgb,var(--ad-label-primary) 42%,transparent),transparent 58%)}
  .ad-project-cover::after{text-shadow:0 2px 8px color-mix(in srgb,var(--ad-label-primary) 45%,transparent)}
  .ad-project-badge[data-state="making"]{background:color-mix(in srgb,var(--ad-warn) 16%,var(--ad-bg-base))}
  .ad-project-badge[data-state="ready"]{background:color-mix(in srgb,var(--ad-success) 14%,var(--ad-bg-base))}
  .ad-project-progress{background:color-mix(in srgb,var(--ad-label-primary) 14%,transparent)}
  .ad-project-progress-bar{box-shadow:0 0 6px color-mix(in srgb,var(--ad-brand) 35%,transparent)}
  .ad-create-hero{background:color-mix(in srgb,var(--ad-brand) 6%,var(--ad-bg-base));box-shadow:0 2px 10px color-mix(in srgb,var(--ad-label-primary) 10%,transparent)}
  #ad-shared-surface{background:color-mix(in srgb,var(--ad-label-primary) 4%,var(--ad-bg-base))}
  .ad-empty-poster::before{background:linear-gradient(135deg,color-mix(in srgb,var(--ad-brand) 34%,var(--ad-subtle-bg)),var(--ad-subtle-bg))}
}/* v0.13.2（task-34 / M6-0b）：项目页/设置页视觉层级（base 纯 token + @supports 混色 enhanced；0 hex / 0 新 token / 业务 dsw=0） */
/* 1) 项目页页头 */
.ad-head{background:var(--ad-bg-base);border-bottom:1px solid var(--ad-divider);padding:11px 18px;gap:10px}
.ad-head .ad-title{font-size:16px;font-weight:600}
.ad-head .ad-sub{font-size:12px;color:var(--ad-label-secondary)}
.ad-flow-hint{font-size:12px;color:var(--ad-label-secondary);margin-left:4px}
/* 2) 页签组（4 组 15 页签；roving tabindex/aria 不动） */
.ad-tabs{border-bottom:1px solid var(--ad-divider);gap:8px;margin:2px 0 12px}
.ad-tab{padding:8px 12px;border-radius:8px 8px 0 0;opacity:.72;transition:background 160ms ease,opacity 160ms ease}
.ad-tab:hover{background:var(--ad-hover-bg);opacity:1}
.ad-tab[data-on="1"]{opacity:1;font-weight:600;color:var(--ad-label-primary);border-bottom:2px solid var(--ad-brand)}
.ad-tab-group{gap:4px}
.ad-tab-group-label{font-size:12px;color:var(--ad-label-secondary)}
/* 3) 分区卡（契约/总览/人物/世界观/剧本/分镜/审读等页内区块） */
.ad-sec{font-size:14px;font-weight:600;margin:14px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--ad-divider)}
.ad-sec:first-child{margin-top:0}
.ad-box{background:var(--ad-subtle-bg);border:1px solid var(--ad-border);border-radius:12px;padding:14px 16px;box-shadow:0 1px 2px var(--ad-border)}
.ad-box .ad-box{background:var(--ad-bg-base)}
.ad-toolcards{gap:14px}
.ad-toolcard{background:var(--ad-subtle-bg);border:1px solid var(--ad-border);border-radius:12px;padding:14px 16px;box-shadow:0 1px 2px var(--ad-border)}
.ad-toolcard[data-tone="warn"]{border-color:var(--ad-warning-border)}
.ad-toolcard[data-tone="error"]{border-color:var(--ad-error-border)}
.ad-review-finding{margin-bottom:10px;background:var(--ad-bg-base);border:1px solid var(--ad-border);border-left:2px solid var(--ad-border);border-radius:12px;padding:14px 16px;box-shadow:0 1px 2px var(--ad-border)}
.ad-review-finding[data-severity="error"]{border-left-color:var(--ad-error)}
.ad-review-finding[data-severity="warn"]{border-left-color:var(--ad-warn)}
.ad-review-finding[data-severity="info"]{border-left-color:var(--ad-brand)}
/* 4) 表格：表头层次 / 行 hover / 分隔线 / 粘性表头（滚动容器内） */
.ad-table th,.ad-table td{border-color:var(--ad-divider);padding:5px 8px}
.ad-table th{background:var(--ad-subtle-bg);font-weight:600}
.ad-table thead th{position:sticky;top:0;z-index:1}
.ad-table tbody tr:hover{background:var(--ad-hover-bg)}
.ad-table caption{font-size:12px;color:var(--ad-label-secondary)}
.ad-table-empty{padding:18px 8px;font-size:12px;color:var(--ad-label-secondary)}
/* 5) 设置页：分组卡 / 表单对齐 / sticky footer / 诊断折叠 */
.ad-settings-page{gap:14px;padding-bottom:72px}
.ad-form-group{background:var(--ad-subtle-bg);border:1px solid var(--ad-border);border-radius:12px;padding:14px 16px;margin-bottom:14px;box-shadow:0 1px 2px var(--ad-border)}
.ad-form-group:last-of-type{margin-bottom:0}
.ad-form-group > .ad-sec{margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid var(--ad-divider)}
.ad-form-group > .ad-sec:first-child{margin-top:0}
.ad-settings-grid{gap:10px 14px;margin-bottom:8px}
.ad-field > label{font-size:13px;color:var(--ad-label-secondary)}
.ad-input,.ad-select,.ad-area{background:var(--ad-bg-base);border:1px solid var(--ad-border);border-radius:8px}
.ad-input:focus,.ad-select:focus,.ad-area:focus{outline:2px solid var(--ad-brand);outline-offset:1px;border-color:var(--ad-brand)}
.ad-settings-footer{position:sticky;bottom:0;z-index:20;display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;background:var(--ad-bg-base);border-top:1px solid var(--ad-divider);padding:12px 16px;margin-top:8px}
.ad-settings-footer > .ad-sub{order:2;flex:1 1 100%;font-size:12px;color:var(--ad-label-secondary);margin:0}
.ad-form-group.ad-settings-diag{display:block;padding:0;overflow:hidden}
.ad-form-group.ad-settings-diag > .ad-sec{margin:0;padding:0;border:0}
.ad-settings-diag-summary{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--ad-label-primary);cursor:pointer;padding:12px 16px;list-style:none;margin:0}
.ad-settings-diag-summary::-webkit-details-marker{display:none}
.ad-settings-diag-summary::before{content:"▸";color:var(--ad-label-secondary);font-size:12px;line-height:1}
.ad-settings-diag[open] .ad-settings-diag-summary::before{content:"▾"}
.ad-settings-diag[open] .ad-settings-diag-summary{border-bottom:1px solid var(--ad-divider)}
.ad-settings-diag-body{padding:4px 16px 14px}
.ad-settings-diag-body > .ad-sec:first-child{margin-top:4px}
.ad-settings-diag-rows{display:flex;flex-direction:column;gap:4px}
@media (max-width:900px){
  .ad-settings-footer{padding:10px 12px}
  .ad-settings-page{padding-bottom:84px}
  .ad-table th,.ad-table td{padding:4px 6px}
}
@media (max-width:560px){
  .ad-settings-footer{justify-content:flex-start}
  .ad-section-card,.ad-form-group{padding:12px}
}
@media (prefers-reduced-motion: reduce){.ad-tab{transition:none}}
/* enhanced：仅支持混色时叠加（base 已保证降级可见） */
@supports (color: color-mix(in srgb, red 1%, blue)){
  .ad-tab[data-on="1"]{background:color-mix(in srgb,var(--ad-brand) 6%,transparent)}
  .ad-box,.ad-toolcard,.ad-review-finding,.ad-form-group{box-shadow:0 1px 2px color-mix(in srgb,var(--ad-label-primary) 8%,transparent),0 4px 12px color-mix(in srgb,var(--ad-label-primary) 5%,transparent)}
  .ad-input:focus,.ad-select:focus,.ad-area:focus{outline:2px solid color-mix(in srgb,var(--ad-brand) 60%,transparent)}
  .ad-settings-footer{box-shadow:0 -6px 16px color-mix(in srgb,var(--ad-label-primary) 6%,transparent)}
}
/* DEF-DARK-SELECT-01（task-34 追加，P1）：原生控件浅/深可读 —— select/option/date/number/checkbox/radio/textarea；0 hex / 0 新 token / 业务 dsw=0 */
select.ad-select{color:var(--ad-label-primary);background-color:var(--ad-bg-base)}
select.ad-select option,select.ad-select optgroup{color:var(--ad-label-primary);background-color:var(--ad-bg-base)}
select.ad-select option:checked,select.ad-select option:hover{color:var(--ad-label-primary);background-color:var(--ad-hover-bg)}
.ad-input[type="date"],.ad-input[type="time"],.ad-input[type="number"],.ad-input[type="search"],.ad-input[type="url"],.ad-input[type="email"],.ad-input[type="password"],.ad-input[type="checkbox"],.ad-input[type="radio"],.ad-area{color:var(--ad-label-primary);background-color:var(--ad-bg-base)}
.ad-input[type="checkbox"],.ad-input[type="radio"],.ad-check{accent-color:var(--ad-brand)}
.ad-shell,.ad-settings-page,.ad-settings-overlay-panel,.ad-toolview{color-scheme:light}
body[data-ds-dark-theme] .ad-shell,body[data-ds-dark-theme] .ad-settings-page,body[data-ds-dark-theme] .ad-settings-overlay-panel,body[data-ds-dark-theme] .ad-toolview,body[data-ds-dark-theme] select.ad-select,body[data-ds-dark-theme] .ad-input,body[data-ds-dark-theme] .ad-area{color-scheme:dark}
body[data-ds-dark-theme] select.ad-select option,body[data-ds-dark-theme] select.ad-select optgroup{color:var(--ad-label-primary);background-color:var(--ad-bg-base)}
.ad-select{color:var(--ad-label-primary);background-color:var(--ad-bg-base);color-scheme:light}
.ad-select option,.ad-select optgroup{color:var(--ad-label-primary);background-color:var(--ad-bg-base)}
.ad-select option:checked,.ad-select option:hover{color:var(--ad-label-primary);background-color:var(--ad-hover-bg)}
body[data-ds-dark-theme] .ad-select{color-scheme:dark}
/* DEF-DARK-SELECT-01 覆盖补强：全部 20 处 select 全覆盖（含无 class 的 7 处；作用域按插件容器） */
.ad-shell select,.ad-settings-page select,.ad-settings-overlay-panel select,.ad-toolview select{color:var(--ad-label-primary);background-color:var(--ad-bg-base);color-scheme:light}
.ad-shell select option,.ad-shell select optgroup,.ad-settings-page select option,.ad-settings-page select optgroup,.ad-settings-overlay-panel select option,.ad-settings-overlay-panel select optgroup,.ad-toolview select option,.ad-toolview select optgroup{color:var(--ad-label-primary);background-color:var(--ad-bg-base)}
.ad-shell select option:checked,.ad-settings-page select option:checked,.ad-settings-overlay-panel select option:checked,.ad-toolview select option:checked{background-color:var(--ad-hover-bg)}
body[data-ds-dark-theme] .ad-shell select,body[data-ds-dark-theme] .ad-settings-page select,body[data-ds-dark-theme] .ad-settings-overlay-panel select,body[data-ds-dark-theme] .ad-toolview select{color-scheme:dark}
/* P2（task-34 并入）：人物卡删除文字按钮 → 图标按钮（.ad-icon-btn；0 hex/0 新 token） */
.ad-icon-btn{min-width:28px;min-height:28px;padding:4px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;background:transparent;border:0;color:var(--ad-label-secondary);cursor:pointer}
.ad-icon-btn:hover{color:var(--ad-error);background:var(--ad-error-bg)}
.ad-icon-btn:focus-visible{outline:2px solid var(--ad-brand);outline-offset:2px}
.ad-icon-btn:disabled{opacity:.5;cursor:default}/* v0.13.3（task-35 / M6-0c）：统一图标按钮 + DEV-ICON-HOVER-BG 修复 + 空态图形 + 微交互（纯追加；0 hex / 0 新 token / 业务 dsw=0） */
/* 2) 图标按钮：DEV-ICON-HOVER-BG 修复（danger (0,4,0) 压过 .ad-btn:not(.ad-primary):hover (0,3,0)） */
.ad-btn.ad-icon-btn:hover{color:var(--ad-label-primary);background:var(--ad-hover-bg)}
.ad-btn.ad-icon-btn[data-tone="danger"]:hover,.ad-btn.ad-icon-btn[data-tone="danger"]:focus-visible{color:var(--ad-error);background:var(--ad-error-bg)}
.ad-btn.ad-icon-btn:disabled:hover{color:var(--ad-label-secondary);background:transparent}
.ad-icon-btn{transition:color 120ms ease,background-color 120ms ease}
.ad-icon-btn.ad-icon-btn-sm{min-width:24px;min-height:24px;padding:2px}
.ad-btn.ad-icon-btn:focus-visible,.ad-btn.ad-icon-btn.ad-icon-btn-sm:focus-visible{outline:2px solid var(--ad-brand);outline-offset:2px}
.ad-icon-btn>svg,.ad-btn>svg{flex:none;vertical-align:middle}
.ad-project-more>summary{display:inline-flex;align-items:center;justify-content:center}
.ad-project-more-item{display:flex;align-items:center;gap:6px}
.ad-project-more-path{display:flex;align-items:center;gap:6px}
/* 3) 空态图形（CSS-only；emptyState 源码/文案/14 调用点不动；token 绘制，无图片/emoji 依赖） */
.ad-empty-graphic{flex:none;width:52px;height:52px;position:relative;box-sizing:border-box;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-subtle-bg);pointer-events:none}
.ad-empty-graphic::before,.ad-empty-graphic::after{content:"";position:absolute;border-radius:3px;background:var(--ad-label-secondary);opacity:.3}
.ad-empty-graphic::before{left:8px;right:8px;top:12px;height:2px}
.ad-empty-graphic::after{left:12px;right:12px;bottom:12px;height:14px;border:1px solid var(--ad-label-secondary);background:transparent}
.ad-empty-graphic[data-graphic="film"]::after{left:10px;right:10px;height:20px;border-width:2px}
.ad-empty-graphic[data-graphic="table"]::before{top:12px;height:1px;box-shadow:0 7px 0 var(--ad-label-secondary),0 14px 0 var(--ad-label-secondary)}
.ad-empty-graphic[data-graphic="table"]::after{display:none}
.ad-empty-poster::before{width:52px;height:52px;border-radius:10px;border:1px solid var(--ad-border);background:linear-gradient(135deg,var(--ad-brand),var(--ad-subtle-bg));pointer-events:none}
.ad-shared-empty::before{width:52px;height:52px;border-radius:10px;border:1px solid var(--ad-border);background:linear-gradient(135deg,var(--ad-brand),var(--ad-subtle-bg));pointer-events:none}
.ad-table-empty::before{content:"";display:block;width:52px;height:52px;margin:2px auto 8px;box-sizing:border-box;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-subtle-bg);pointer-events:none;vertical-align:middle}
.ad-table-empty::after{display:none}
/* 4) 微交互：仅颜色/背景/边框/阴影，无布局位移 */
.ad-btn{transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease}
.ad-table tbody tr{transition:background-color 120ms ease}
.ad-project-more-item,.ad-project-more-path{transition:background-color 120ms ease,color 120ms ease}
@media (prefers-reduced-motion: reduce){
  .ad-btn,.ad-icon-btn,.ad-table tbody tr,.ad-project-more-item,.ad-project-more-path{transition:none}
}
/* enhanced：仅支持混色时叠加空态图形细节（base 已可见） */
@supports (color: color-mix(in srgb, red 1%, blue)){
  .ad-empty-graphic{background:color-mix(in srgb,var(--ad-label-primary) 4%,var(--ad-bg-base))}
  .ad-empty-poster::before,.ad-shared-empty::before,.ad-table-empty::before{background:linear-gradient(135deg,color-mix(in srgb,var(--ad-brand) 22%,var(--ad-subtle-bg)),var(--ad-subtle-bg))}
  .ad-empty-graphic::before{background:color-mix(in srgb,var(--ad-label-secondary) 55%,transparent)}
}
/* V16 空态图形形状语言细化（visual 预检建议；纯追加/0 hex/0 新 token/不改 DOM/emptyState；CSS-only） */
.ad-table-empty::before{background-image:repeating-linear-gradient(to bottom,color-mix(in srgb,var(--ad-label-secondary) 45%,transparent) 0 1px,transparent 1px 7px);background-size:24px 21px;background-position:14px 16px;background-repeat:no-repeat}
.ad-empty-poster::before{background-image:repeating-linear-gradient(to right,var(--ad-bg-base) 0 3px,transparent 3px 9px),linear-gradient(135deg,var(--ad-brand),var(--ad-subtle-bg));background-size:auto 44px,auto;background-position:4px 4px,0 0;background-repeat:no-repeat;box-shadow:inset 0 0 0 1px var(--ad-border)}
.ad-shared-empty::before{background-image:linear-gradient(to right,var(--ad-label-secondary) 0 40%,transparent 40%),linear-gradient(135deg,var(--ad-brand),var(--ad-subtle-bg));background-size:18px 6px,auto;background-position:6px 5px,0 0;background-repeat:no-repeat}/* v0.14.0（task-38 / M6-1 C 路径）：交给 Agent 入口 + 交接弹窗指令预览（纯追加；0 hex / 0 新 token / 业务 dsw=0） */
.ad-tabs-agent{display:flex;align-items:center;margin-left:auto;flex:none;padding-left:8px}
.ad-tabs-agent .ad-btn{display:inline-flex;align-items:center;gap:6px}
.ad-agent-label{white-space:nowrap}
.ad-agent-entry{display:inline-flex;align-items:center;gap:6px}
.ad-agent-instr{display:flex;flex-direction:column;gap:4px}
.ad-agent-instr .ad-area{width:100%;min-height:96px;max-height:200px;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:1.7;overflow:auto;resize:vertical;box-sizing:border-box}
@media (max-width:560px){
  .ad-tabs-agent .ad-agent-label{display:none}
  .ad-agent-instr .ad-area{max-height:160px}
}
.ad-asset-toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
.ad-asset-chip{padding:3px 10px;border-radius:999px;border:1px solid var(--ad-border);background:var(--ad-bg-base);color:var(--ad-label-secondary);font-size:12px;cursor:pointer}
.ad-asset-chip[aria-pressed='true']{background:var(--ad-brand);border-color:var(--ad-brand);color:var(--ad-on-brand)}
.ad-asset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.ad-asset-card{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-bg-base);cursor:pointer;text-align:left;color:inherit}
.ad-asset-card[aria-pressed='true']{border-color:var(--ad-brand)}
.ad-asset-thumb{display:flex;align-items:center;justify-content:center;width:100%;height:96px;border-radius:8px;background:var(--ad-subtle-bg);overflow:hidden}
.ad-asset-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.ad-asset-placeholder{display:flex;align-items:center;justify-content:center;width:100%;height:96px;border-radius:8px;background:var(--ad-subtle-bg);color:var(--ad-label-secondary);font-size:12px;text-align:center;padding:4px;box-sizing:border-box}
.ad-asset-badge{align-self:flex-start;padding:1px 8px;border-radius:999px;background:var(--ad-subtle-bg);color:var(--ad-label-secondary);font-size:12px}
.ad-asset-badge-warn{background:var(--ad-warning-bg);color:var(--ad-warn);border:1px solid var(--ad-warning-border)}
.ad-legacy-warn{color:var(--ad-warn)}
.ad-asset-card-meta{display:flex;flex-direction:column;gap:2px}
.ad-asset-card-id{font-size:12px;color:var(--ad-label-secondary)}
.ad-asset-card-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad-asset-detail{margin-top:10px;padding:10px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-bg-base)}
.ad-asset-detail-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.ad-asset-detail-main{display:flex;justify-content:center;margin-bottom:8px}
.ad-asset-detail-img{max-width:100%;max-height:320px;border-radius:8px;object-fit:contain;background:var(--ad-subtle-bg)}
.ad-asset-detail-thumbs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.ad-asset-detail-thumb{padding:0;border:2px solid transparent;border-radius:6px;background:none;cursor:pointer;overflow:hidden}
.ad-asset-detail-thumb[aria-pressed='true']{border-color:var(--ad-brand)}
.ad-asset-detail-thumb-img{width:48px;height:48px;object-fit:cover;display:block}
.ad-asset-detail-empty{padding:16px;text-align:center;color:var(--ad-label-secondary);font-size:12px}
.ad-asset-audio{margin-top:8px}
.ad-asset-audio-el{width:100%;max-width:420px}
.ad-episode-dialogue{margin-top:4px}
.ad-episode-viewtabs{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ad-visual-bible{margin-top:4px}
.ad-visual-toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
.ad-visual-section{margin-bottom:14px}
.ad-visual-style{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;padding:10px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-bg-base)}
.ad-visual-style-head{max-width:180px;flex-shrink:0}
.ad-visual-style-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;flex:1;min-width:220px}
.ad-visual-style-dim{padding:6px 8px;border-radius:8px;background:var(--ad-subtle-bg)}
.ad-visual-style-label{font-size:12px;color:var(--ad-label-secondary);margin-bottom:2px}
.ad-visual-style-text{font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:96px;overflow:auto}
.ad-visual-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.ad-visual-card{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-bg-base);min-width:0}
.ad-visual-thumb-wrap{display:flex;align-items:center;justify-content:center;width:100%;height:104px;border-radius:8px;background:var(--ad-subtle-bg);overflow:hidden}
.ad-visual-thumb{display:flex;width:100%;height:100%;align-items:center;justify-content:center;padding:0;border:none;background:none;cursor:zoom-in;overflow:hidden;border-radius:8px}
.ad-visual-thumb-img{width:100%;height:100%;object-fit:cover;display:block}
.ad-visual-placeholder{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:var(--ad-label-secondary);font-size:12px;background:var(--ad-subtle-bg)}
.ad-visual-card-body{display:flex;flex-direction:column;gap:3px;min-width:0;font-size:12px;line-height:1.7}
.ad-visual-meta{color:var(--ad-label-secondary);font-size:12px;overflow-wrap:anywhere}
.ad-visual-audio-box{margin-top:2px;display:flex;flex-direction:column;gap:4px}
.ad-visual-audio{width:100%;max-width:260px}
.ad-visual-audio-switches{display:flex;gap:4px;flex-wrap:wrap}
.ad-visual-empty{padding:10px;border-radius:8px;background:var(--ad-subtle-bg);color:var(--ad-label-secondary);font-size:12px}
.ad-visual-wall{display:flex;flex-wrap:wrap;gap:8px}
.ad-visual-wall .ad-visual-thumb{width:108px;height:108px;flex:0 0 auto}
.ad-visual-groups{display:flex;flex-direction:column;gap:8px}
.ad-visual-group{border:1px solid var(--ad-border);border-radius:10px;overflow:hidden;background:var(--ad-bg-base)}
.ad-visual-group-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:none;background:var(--ad-subtle-bg);color:var(--ad-label-primary);font-size:13px;font-weight:600;line-height:1.8;cursor:pointer;text-align:left}
.ad-visual-group-title{flex:none}
.ad-visual-group-count{color:var(--ad-label-secondary);font-weight:400}
.ad-visual-group-symbol{margin-left:auto;flex:none;color:var(--ad-label-secondary)}
.ad-visual-wall-group{padding:8px 10px;border:none;border-radius:0}
.ad-visual-guidance{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.ad-visual-guidance-text{line-height:1.8}
.ad-visual-guidance-actions{display:flex;flex-wrap:wrap;gap:8px}
.ad-visual-lightbox{position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:72px 16px 24px;background:color-mix(in srgb, var(--ad-label-primary) 55%, transparent);overflow:auto}
.ad-visual-lightbox-close{position:fixed;top:16px;right:16px;z-index:2;min-width:96px;min-height:40px;box-shadow:0 2px 10px rgba(0,0,0,.35)}
.ad-visual-lightbox-hint{position:relative;z-index:1;color:var(--ad-bg-base);font-size:12px;line-height:18px;opacity:.9;text-align:center;flex:0 0 auto}
.ad-visual-lightbox-img{position:relative;z-index:1;max-width:min(90vw,calc(100vw - 32px));max-height:calc(100vh - 160px);border-radius:10px;background:var(--ad-bg-base);flex:0 1 auto}
.ad-legacy-view{margin-top:2px}
.ad-legacy-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.ad-legacy-card{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-bg-base);min-width:0}
.ad-legacy-thumb-wrap{display:flex;align-items:center;justify-content:center;width:100%;height:104px;border-radius:8px;background:var(--ad-subtle-bg);overflow:hidden}
.ad-legacy-thumb{display:flex;width:100%;height:100%;align-items:center;justify-content:center;padding:0;border:none;background:none;cursor:zoom-in;overflow:hidden;border-radius:8px}
.ad-legacy-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.ad-legacy-placeholder{display:flex;align-items:center;justify-content:center;width:100%;height:100%;padding:4px;box-sizing:border-box;color:var(--ad-label-secondary);font-size:12px;text-align:center;background:var(--ad-subtle-bg)}
.ad-legacy-missing{color:var(--ad-warn)}
.ad-legacy-body{display:flex;flex-direction:column;gap:3px;min-width:0;font-size:12px;line-height:1.7}
.ad-legacy-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad-legacy-meta{color:var(--ad-label-secondary);font-size:12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;overflow-wrap:anywhere}
.ad-legacy-note{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ad-registration{margin-top:12px;padding-top:10px;border-top:1px dashed var(--ad-divider)}
.ad-registration-body{margin-top:8px}
.ad-scan-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px;padding-top:10px;border-top:1px dashed var(--ad-divider)}
.ad-scan-panel{margin-top:8px;padding:10px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-bg-base)}
.ad-scan-selectall{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--ad-label-secondary);cursor:pointer}
.ad-scan-list{max-height:300px;overflow:auto;border:1px solid var(--ad-border);border-radius:8px;padding:4px 6px;background:var(--ad-subtle-bg);margin-bottom:8px}
.ad-scan-row{display:flex;align-items:center;gap:8px;padding:3px 2px;font-size:12px;line-height:1.8;cursor:pointer;min-width:0}
.ad-scan-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Consolas,Menlo,monospace}
.ad-scan-size{flex:none;color:var(--ad-label-secondary)}
.ad-scan-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ad-warn-inline{font-size:12px;line-height:1.8;color:var(--ad-warn)}
.ad-registry-warning{margin:0 0 10px;padding:10px 12px;border:1px solid var(--ad-warning-border);border-radius:10px;background:var(--ad-warning-bg);color:var(--ad-warn);font-size:12px;line-height:1.8}
.ad-registry-warning-title{font-weight:600}
.ad-registry-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.ad-registry-notice{margin:0 0 10px;padding:8px 10px;border-radius:8px;background:var(--ad-subtle-bg);color:var(--ad-success);font-size:12px;line-height:1.8}
.ad-scan-progress{margin-top:6px;font-size:12px;color:var(--ad-label-secondary)}
.ad-scan-summary{margin-top:8px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--ad-subtle-bg)}
.ad-scan-fail-list{margin-top:4px;max-height:140px;overflow:auto}
.ad-scan-fail-item{color:var(--ad-warn);overflow-wrap:anywhere}
.ad-import-panel{margin-top:8px;padding:10px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-bg-base)}
.ad-import-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
.ad-import-category{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ad-label-secondary)}
.ad-import-drop{margin-bottom:8px;padding:14px 10px;border:1px dashed var(--ad-border);border-radius:8px;background:var(--ad-subtle-bg);font-size:12px;line-height:1.8;color:var(--ad-label-secondary);text-align:center}
.ad-import-list{max-height:220px;overflow:auto;border:1px solid var(--ad-border);border-radius:8px;padding:4px 6px;background:var(--ad-subtle-bg);margin-bottom:8px}
.ad-import-row{display:flex;align-items:center;gap:8px;padding:3px 2px;font-size:12px;line-height:1.8;min-width:0}
.ad-import-row-bad .ad-import-name,.ad-import-row-bad .ad-import-status{color:var(--ad-warn)}
.ad-import-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Consolas,Menlo,monospace}
.ad-import-size{flex:none;color:var(--ad-label-secondary)}
.ad-import-status{flex:none;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ad-label-secondary)}
.ad-import-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ad-import-progress{margin-top:6px;font-size:12px;color:var(--ad-label-secondary)}
.ad-import-summary{margin-top:8px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--ad-subtle-bg)}
.ad-cross-import-panel{margin-top:8px}
.ad-cross-import-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
.ad-cross-import-toolbar .ad-input{max-width:240px}
.ad-cross-import-list{display:flex;flex-direction:column;gap:4px;max-height:260px;overflow:auto;padding:6px;border:1px solid var(--ad-border);border-radius:8px;background:var(--ad-bg-base)}
.ad-cross-import-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;font-size:12px;line-height:1.8}
.ad-cross-import-row:hover{background:var(--ad-subtle-bg)}
.ad-cross-import-id{flex:none;font-family:Consolas,Menlo,monospace;color:var(--ad-label-secondary)}
.ad-cross-import-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad-cross-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.ad-cross-tab{padding:3px 10px;border:1px solid var(--ad-border);border-radius:999px;background:var(--ad-bg-base);color:var(--ad-label-primary);font-size:12px;line-height:1.8;cursor:pointer}
.ad-cross-tab[aria-pressed="true"]{border-color:var(--ad-brand);color:var(--ad-brand)}
.ad-cross-switches{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0;font-size:12px;line-height:1.8}
.ad-cross-switch{display:flex;align-items:center;gap:6px;cursor:pointer}
.ad-cross-conflict{margin:6px 0;padding:6px 8px;border-radius:6px;background:var(--ad-subtle-bg);color:var(--ad-label-secondary);font-size:12px;line-height:1.8}
.ad-cross-warning{margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--ad-subtle-bg);color:var(--ad-warn);font-size:12px;line-height:1.8}
.ad-cross-style-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:6px;margin:8px 0}
.ad-cross-style-dim{display:flex;gap:8px;padding:4px 6px;border:1px solid var(--ad-border);border-radius:6px;font-size:12px;line-height:1.8}
.ad-cross-idmap{margin-top:4px;color:var(--ad-label-secondary);font-size:12px;line-height:1.8;font-family:Consolas,Menlo,monospace}
.ad-cross-import-empty{padding:10px;border-radius:8px;background:var(--ad-subtle-bg);color:var(--ad-label-secondary);font-size:12px}
.ad-artifact-file{display:inline-flex;align-items:center;gap:6px;max-width:320px;padding:2px 8px;border:1px solid var(--ad-border);border-radius:999px;background:var(--ad-subtle-bg);font-size:12px;line-height:1.8}
.ad-artifact-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Consolas,Menlo,monospace}
.ad-artifact-file-size{flex:none;color:var(--ad-label-secondary)}
.ad-artifact-category{margin-top:2px}
.ad-asset-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px 14px;margin:0}

.ad-asset-field{display:flex;gap:6px;font-size:12px;line-height:1.7;min-width:0}
.ad-asset-field-label{color:var(--ad-label-secondary);flex-shrink:0}
.ad-asset-field-value{color:var(--ad-label-primary);overflow-wrap:anywhere}

/* v0.16.2（C1-C）：契约页「八大设定（可选）」折叠组（默认收起；token-only，0 hex / 0 新 token） */
.ad-contract-world-summary{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--ad-label-primary);cursor:pointer;padding:2px 0;list-style:none}
.ad-contract-world-summary::-webkit-details-marker{display:none}
.ad-contract-world-summary::before{content:"▸";color:var(--ad-label-secondary);font-size:12px;line-height:1}
.ad-contract-world[open] .ad-contract-world-summary::before{content:"▾"}
.ad-contract-world-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px 14px;margin-top:10px}
.ad-contract-world .ad-area{width:100%}
.ad-contract-world .ad-count[data-over="1"]{color:var(--ad-warn)}/* v0.16.5（task-45）：剧集契约页头入口 + 契约页底部操作卡（token-only；0 hex / 0 新 token） */
.ad-head-entry[data-on="1"]{background:var(--ad-subtle-bg);border-color:var(--ad-brand);color:var(--ad-label-primary);font-weight:600}
.ad-head-entry-short{display:none}
.ad-contract-footer{margin-top:14px}
@media (max-width:900px){.ad-head-entry-full{display:none}.ad-head-entry-short{display:inline}}/* v0.16.6（C2-C / E15+H-7）：视觉圣经风格定向/冻结编辑区（token-only；0 hex / 0 新 token） */
.ad-style-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--ad-label-secondary);margin:2px 0 10px}
.ad-style-status .ad-style-state{font-size:13px;font-weight:600;color:var(--ad-label-primary)}
.ad-style-badge{padding:2px 8px;border-radius:999px;border:1px solid var(--ad-border);background:var(--ad-subtle-bg);color:var(--ad-label-secondary)}
.ad-style-frozen{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:0 0 10px;padding:8px 10px;border:1px solid var(--ad-warning-border);border-radius:8px;background:var(--ad-warning-bg);color:var(--ad-warn);font-size:12px}
.ad-style-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px 14px}
.ad-style-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.ad-style-field .ad-area{width:100%;box-sizing:border-box}
.ad-style-count{font-size:12px;color:var(--ad-label-secondary);font-weight:400}
.ad-style-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
/* v0.16.9（C3-C / E16+H-8）：资产/场景卡多轮审核工作台（token-only；0 hex / 0 新 token） */
.ad-review{display:flex;flex-direction:column;gap:10px}
.ad-review-kind{display:flex;gap:8px;flex-wrap:wrap}
.ad-review-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ad-review-body{display:grid;grid-template-columns:minmax(240px,320px) minmax(0,1fr);gap:12px;align-items:start}
.ad-review-list{display:flex;flex-direction:column;gap:6px;max-height:560px;overflow:auto;border:1px solid var(--ad-border);border-radius:10px;padding:8px;background:var(--ad-subtle-bg)}
.ad-review-item{display:flex;flex-direction:column;gap:2px;text-align:left;padding:6px 8px;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;font:inherit}
.ad-review-item:hover{border-color:var(--ad-border)}
.ad-review-item[aria-pressed="true"]{border-color:var(--ad-brand);background:var(--ad-bg-base)}
.ad-review-item-title{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;color:var(--ad-label-primary);flex-wrap:wrap}
.ad-review-item-meta{font-size:12px;color:var(--ad-label-secondary);overflow-wrap:anywhere}
.ad-review-badge{font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--ad-border);color:var(--ad-label-secondary);background:var(--ad-bg-base);white-space:nowrap}
.ad-review-badge[data-status="pending"]{color:var(--ad-warn);border-color:var(--ad-warning-border);background:var(--ad-warning-bg)}
.ad-review-badge[data-status="rejected"]{color:var(--ad-error);border-color:var(--ad-error-border);background:var(--ad-error-bg)}
.ad-review-badge[data-status="approved"]{color:var(--ad-brand);border-color:var(--ad-brand)}
.ad-review-badge[data-status="final"]{color:var(--ad-label-primary);border-color:var(--ad-label-primary);font-weight:600}
.ad-review-detail{display:flex;flex-direction:column;gap:8px;min-width:0}
.ad-review-detail-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--ad-label-secondary)}
.ad-review-detail-head strong{color:var(--ad-label-primary)}
.ad-review-frozen{padding:7px 10px;border-radius:8px;border:1px solid var(--ad-warning-border);background:var(--ad-warning-bg);color:var(--ad-warn);font-size:12px;line-height:1.8}
.ad-review-prompt{display:flex;flex-direction:column;gap:4px}
.ad-review-prompt .ad-area{width:100%;min-height:96px}
.ad-review-counter{font-size:12px;color:var(--ad-label-secondary)}
.ad-review-counter[data-over="1"]{color:var(--ad-error)}
.ad-review-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ad-review-rounds{display:flex;flex-direction:column;gap:6px}
.ad-review-round{border:1px solid var(--ad-border);border-radius:8px;padding:6px 8px;font-size:12px;color:var(--ad-label-secondary);display:flex;flex-direction:column;gap:2px}
.ad-review-round-head{display:flex;gap:8px;flex-wrap:wrap;color:var(--ad-label-primary);font-weight:600}
.ad-review-round-reason{color:var(--ad-warn)}
.ad-review-round-prompt{overflow-wrap:anywhere}
@media (max-width:900px){.ad-review-body{grid-template-columns:1fr}.ad-review-list{max-height:240px}}
`

    function Styles() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } })
    }

    /* ------------------------------------------------------------ 侧栏图标 */

    function DramaIcon(props) {
      const size = (props && props.size) || 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M3 8.5h18v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z' }),
        h('path', { d: 'M3 8.5 5.2 4.2h15L18 8.5' }),
        h('path', { d: 'm8.6 4.2-2 4.3' }),
        h('path', { d: 'm13.6 4.2-2 4.3' }),
        h('path', { d: 'm18.4 4.2-2 4.3' }),
      )
    }

    /* ---------------------------------------------- v0.13.3（task-35 / M6-0c）：统一图标 */
    const ICON_PATHS = {
      trash: 'M2.5 4.2h11M6 4.2V2.9c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.3M4.2 4.2l.5 8.6c0 .6.5 1 1.1 1h4.4c.6 0 1.1-.4 1.1-1l.5-8.6M6.6 6.8v4.4M9.4 6.8v4.4',
      ellipsis: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
      pencil: 'M11.3 2.8l1.9 1.9-7.6 7.6H3.7v-1.9l7.6-7.6zM10.2 3.9l1.9 1.9',
      refresh: 'M13.4 8a5.4 5.4 0 1 1-1.7-3.9M13.4 2.6v3h-3',
      folder: 'M2.5 4.6h3.8l1.2 1.4h5.9v5.9a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5.6a1 1 0 0 1 1-1z',
      plus: 'M8 3.2v9.6M3.2 8h9.6',
      chevron: 'M6 4l4 4-4 4',
      send: 'M13.5 2.5L2.5 7.17l4.83 1.83L9.5 14.5l5-12zM6.5 8.8L13 3',
    }
    function icon(name) {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', { d: ICON_PATHS[name] || ICON_PATHS.ellipsis }))
    }

    /* ------------------------- v0.15.1（task-108 / B2S-C）：素材库分类 + 图片可见（只读） helper */
    // 9 类资产卡类型（与宿主 lib/assets.js ASSET_PREFIXES 对齐）+ 展示顺序/中文标签。
    const ASSET_TYPE_ORDER = [
      ['CHR', '角色'],
      ['SPC', '场景'],
      ['PRP', '道具'],
      ['CST', '服装'],
      ['EXP', '表情'],
      ['SFX', '音效'],
      ['VOX', '配音'],
      ['MUS', '音乐'],
      ['SHT', '分镜'],
    ]
    const ASSET_TYPE_LABELS = (() => {
      const labels = {}
      for (const [type, label] of ASSET_TYPE_ORDER) labels[type] = label
      return labels
    })()
    const ASSET_IMAGE_MAX_COUNT = 6
    const ASSET_IMAGE_SRC_MAX = 500
    // 图片读取去重表（项目切换/刷新时清空；渲染状态由组件 assetImageCache 驱动）
    const assetImageLoadState = new Map()

    function assetCardImagePaths(cards, maxCards) {
      const paths = []
      for (const card of (Array.isArray(cards) ? cards : []).slice(0, maxCards || 60)) {
        if (!card || !card.media) continue
        if (card.media.thumbnail) paths.push(card.media.thumbnail)
        if (Array.isArray(card.media.images) && card.media.images[0]) paths.push(card.media.images[0])
      }
      return paths
    }

    function assetTypeLabelOf(type) {
      return ASSET_TYPE_LABELS[String(type || '').toUpperCase()] || '资产'
    }

    function assetIdTypeOf(id) {
      const match = /^([A-Z]{3})[0-9]/.exec(String(id || '').toUpperCase())
      return match && ASSET_TYPE_LABELS[match[1]] ? match[1] : ''
    }

    /** 图片源分类：http(s) 可直接展示；非 http 的非空字符串按项目相对路径走 media-read；其余不请求。 */
    function assetImageSourceOf(raw) {
      const text = typeof raw === 'string' ? raw.trim().slice(0, ASSET_IMAGE_SRC_MAX) : ''
      if (!text) return { kind: 'none', value: '' }
      if (/^https?:\/\//i.test(text)) {
        try {
          const parsed = new URL(text)
          return { kind: 'http', value: parsed.href }
        } catch {
          return { kind: 'invalid', value: text }
        }
      }
      if (/^(?:data|blob):/i.test(text)) return { kind: 'invalid', value: text }
      if (/^[\\/]/.test(text) || /^[A-Za-z]:[\\/]/.test(text)) return { kind: 'absolute', value: text }
      return { kind: 'relative', value: text }
    }

    function normalizeAssetMedia(raw) {
      const media = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
      if (!media) return null
      const images = []
      if (Array.isArray(media.images)) {
        for (const item of media.images) {
          const src = assetImageSourceOf(item)
          if (src.kind === 'none' || src.kind === 'invalid') continue
          if (!images.includes(src.value)) images.push(src.value)
          if (images.length >= ASSET_IMAGE_MAX_COUNT) break
        }
      }
      // v0.15.2（task-112）：media.audio 为 string[]（1–6 项；兼容脏数据中的单字符串），默认试听 audio[0]。
      const audios = []
      const audioRaw = Array.isArray(media.audio) ? media.audio : typeof media.audio === 'string' ? [media.audio] : []
      for (const item of audioRaw) {
        const src = assetImageSourceOf(item)
        if (src.kind === 'none' || src.kind === 'invalid') continue
        if (!audios.includes(src.value)) audios.push(src.value)
        if (audios.length >= ASSET_IMAGE_MAX_COUNT) break
      }
      const thumbnail = assetImageSourceOf(media.thumbnail)
      const normalized = {}
      if (images.length) normalized.images = images
      if (audios.length) normalized.audio = audios
      if (thumbnail.value && thumbnail.kind !== 'invalid') normalized.thumbnail = thumbnail.value
      return Object.keys(normalized).length ? normalized : null
    }

    /** 防御式归一化 assets-get add-only `cards`（缺 id/name/重复 id 跳过；旧项目 [] → 旧视图）。 */
    function normalizeAssetCards(raw) {
      if (!Array.isArray(raw)) return []
      const cards = []
      const seen = new Set()
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const id = typeof item.id === 'string' ? item.id.trim().toUpperCase() : ''
        const name = typeof item.name === 'string' ? item.name.trim() : ''
        if (!id || !name || seen.has(id)) continue
        seen.add(id)
        const version = Number(item.version)
        cards.push({
          id,
          type: String(item.type || '').trim().toUpperCase() || assetIdTypeOf(id),
          name,
          status: typeof item.status === 'string' ? item.status.trim() : '',
          version: Number.isFinite(version) && version >= 1 ? Math.floor(version) : 1,
          variantOf: typeof item.variantOf === 'string' ? item.variantOf : '',
          aliases: Array.isArray(item.aliases) ? item.aliases.map((alias) => String(alias).trim()).filter(Boolean) : [],
          fields: item.fields && typeof item.fields === 'object' && !Array.isArray(item.fields) ? item.fields : {},
          relations: item.relations && typeof item.relations === 'object' && !Array.isArray(item.relations) ? item.relations : {},
          prompts: item.prompts && typeof item.prompts === 'object' && !Array.isArray(item.prompts) ? item.prompts : {},
          history: Array.isArray(item.history) ? item.history : [],
          media: normalizeAssetMedia(item.media),
          review: normalizeAssetReview(item.review),
        })
      }
      return cards
    }

    function filterAssetCards(cards, type, query) {
      const typeKey = String(type || '全部').toUpperCase()
      const keyword = String(query || '').trim().toLowerCase()
      return (Array.isArray(cards) ? cards : []).filter((card) => {
        if (typeKey !== '全部' && String(card.type || '').toUpperCase() !== typeKey) return false
        if (!keyword) return true
        return String(card.id || '').toLowerCase().includes(keyword) || String(card.name || '').toLowerCase().includes(keyword)
      })
    }

    function assetFieldEntries(card) {
      if (!card || typeof card !== 'object') return []
      const entries = []
      const push = (label, value) => {
        const text = typeof value === 'string' ? value.trim() : typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
        if (!text) return
        entries.push([label, text.length > 200 ? text.slice(0, 200) + '…' : text])
      }
      push('类型', card.type ? `${assetTypeLabelOf(card.type)}（${card.type}）` : '')
      push('状态', card.status)
      push('版本', card.version ? `v${card.version}` : '')
      push('变体引用', card.variantOf)
      if (card.aliases && card.aliases.length) push('别名', card.aliases.join('、'))
      const flattenObject = (source, prefix) => {
        if (!source || typeof source !== 'object') return
        for (const [key, raw] of Object.entries(source)) {
          if (entries.length >= 30) return
          if (raw == null) continue
          let text = ''
          if (Array.isArray(raw)) text = raw.map((item) => (item == null ? '' : String(item).trim())).filter(Boolean).join('；')
          else if (typeof raw === 'object') text = ''
          else text = String(raw)
          push(`${prefix} · ${key}`, text)
        }
      }
      flattenObject(card.fields, '字段')
      flattenObject(card.relations, '关联')
      flattenObject(card.prompts, '提示词')
      const history = Array.isArray(card.history) ? card.history.slice(-3) : []
      for (const item of history) push('历史', `v${item && item.version ? item.version : '?'} ${item && item.change ? item.change : ''}`)
      return entries
    }

    /* ---------------- v0.15.3（task-115 / VB-C）：视觉圣经专区只读数据 helper ---------------- */
    const STYLE_DIMENSION_ORDER = [
      ['palette', '色板'],
      ['lighting', '光感'],
      ['texture', '质感'],
      ['composition', '构图偏好'],
      ['motion', '运镜节奏'],
    ]
    const VISUAL_STYLE_TEXT_MAX = 300

    /* ---------------- v0.16.6（C2-C / E15+H-7）：视觉圣经定向/冻结（style-save 写入口） ---------------- */
    const STYLE_DIRECTION_LABELS = { draft: '草稿', directed: '已定向（可微调）', frozen: '已冻结' }
    const STYLE_REASON_MIN = 10
    const STYLE_REASON_MAX = 300
    function styleDraftOf(raw) {
      const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      const draft = {}
      for (const [key] of STYLE_DIMENSION_ORDER) draft[key] = typeof source[key] === 'string' ? source[key].slice(0, VISUAL_STYLE_TEXT_MAX) : ''
      return draft
    }
    function normalizeStyleDirection(raw) {
      const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      const status = source.status === 'directed' || source.status === 'frozen' ? source.status : 'draft'
      const revision = Number.isInteger(source.revision) && source.revision > 0 ? source.revision : 1
      const textOf = (value) => (typeof value === 'string' ? value : '')
      return {
        status,
        revision,
        directedAt: textOf(source.directedAt),
        frozenAt: textOf(source.frozenAt),
        freezeNote: textOf(source.freezeNote),
        unfreezeCount: Number.isInteger(source.unfreezeCount) && source.unfreezeCount >= 0 ? source.unfreezeCount : 0,
        hash: textOf(source.hash),
      }
    }
    function styleMomentText(iso) {
      const text = String(iso || '')
      if (!text) return ''
      const date = new Date(text)
      if (!date || Number.isNaN(date.getTime())) return text.slice(0, 19)
      const pad = (value) => (value < 10 ? '0' + String(value) : String(value))
      return String(date.getFullYear()) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /* ---------------- v0.16.9（C3-C / E16+H-8）：资产/场景卡多轮审核（asset-save 写入口） ---------------- */
    const ASSET_REVIEW_STATUS_ORDER = ['draft', 'pending', 'rejected', 'approved', 'final']
    const ASSET_REVIEW_STATUS_LABELS = { draft: '草稿', pending: '待审', rejected: '已驳回', approved: '已通过', final: '已定稿' }
    const ASSET_REVIEW_KIND_LABELS = { asset: '资产卡', scene: '场景卡' }
    const ASSET_REVIEW_PROMPT_MAX = 2000
    const ASSET_REVIEW_REASON_MIN = 4
    const ASSET_REVIEW_REASON_MAX = 300
    const ASSET_REVIEW_ACTION_NOTICES = {
      saveDraft: '提示词草稿已保存',
      submit: '已提交审核',
      approve: '审核已通过',
      reject: '已驳回：请修改提示词后重新提交',
      finalize: '已定稿并锁定（写操作将被拒绝，需重打开）',
      reopen: '已重打开：可继续修改并重新提交',
    }

    /** 防御式归一卡内 add-only `review`（缺失 → null；旧卡不出现 review）。 */
    function normalizeAssetReview(raw) {
      const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
      if (!source) return null
      const intOf = (value, fallback) => {
        const number = Number(value)
        return Number.isInteger(number) && number >= 0 ? number : fallback
      }
      const textOf = (value) => (typeof value === 'string' ? value : '')
      const rounds = (Array.isArray(source.rounds) ? source.rounds : [])
        .filter((round) => round && typeof round === 'object')
        .map((round) => ({
          round: intOf(round.round, 0),
          prompt: textOf(round.prompt).slice(0, ASSET_REVIEW_PROMPT_MAX),
          promptVersion: intOf(round.promptVersion, 0),
          status: ASSET_REVIEW_STATUS_ORDER.includes(String(round.status)) ? String(round.status) : 'pending',
          submittedAt: textOf(round.submittedAt),
          reviewer: textOf(round.reviewer),
          reviewedAt: textOf(round.reviewedAt),
          reason: textOf(round.reason).slice(0, ASSET_REVIEW_REASON_MAX),
        }))
        .slice(-20)
      return {
        schemaVersion: intOf(source.schemaVersion, 1),
        status: ASSET_REVIEW_STATUS_ORDER.includes(String(source.status)) ? String(source.status) : 'draft',
        revision: intOf(source.revision, 0),
        roundCount: intOf(source.roundCount, 0),
        round: intOf(source.round, rounds.length),
        promptVersion: intOf(source.promptVersion, 0),
        currentPrompt: textOf(source.currentPrompt).slice(0, ASSET_REVIEW_PROMPT_MAX),
        rounds,
        approvedAt: textOf(source.approvedAt),
        approvedBy: textOf(source.approvedBy),
        finalizedAt: textOf(source.finalizedAt),
        finalizedBy: textOf(source.finalizedBy),
        finalPrompt: textOf(source.finalPrompt).slice(0, ASSET_REVIEW_PROMPT_MAX),
        reopenCount: intOf(source.reopenCount, 0),
      }
    }

    /** 提示词校验（trim 后 1–2000 字；返回错误文案或空串）。 */
    function assetReviewPromptIssue(prompt) {
      const text = String(prompt == null ? '' : prompt).trim()
      if (text.length < 1) return '提示词不能为空（1–2000 字，trim 后计）'
      if (text.length > ASSET_REVIEW_PROMPT_MAX) return `提示词最多 ${ASSET_REVIEW_PROMPT_MAX} 字（当前 ${text.length} 字）`
      return ''
    }

    /** 驳回/重打开原因校验（trim 后 4–300 字；返回错误文案或空串）。 */
    function assetReviewReasonIssue(reason) {
      const text = String(reason == null ? '' : reason).trim()
      if (text.length < ASSET_REVIEW_REASON_MIN) return `原因至少 ${ASSET_REVIEW_REASON_MIN} 字（当前 ${text.length} 字）`
      if (text.length > ASSET_REVIEW_REASON_MAX) return `原因最多 ${ASSET_REVIEW_REASON_MAX} 字（当前 ${text.length} 字）`
      return ''
    }

    /** 审核状态徽标文案。 */
    function assetReviewStatusLabel(review) {
      if (!review) return '草稿'
      return ASSET_REVIEW_STATUS_LABELS[review.status] || review.status
    }

    /** 归一 styleDNA（只保留五维非空字符串；无有效维返回 null → 视觉基调空态）。 */
    function normalizeVisualStyle(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const style = {}
      for (const [key] of STYLE_DIMENSION_ORDER) {
        const value = typeof raw[key] === 'string' ? raw[key].trim().slice(0, VISUAL_STYLE_TEXT_MAX) : ''
        if (value) style[key] = value
      }
      return Object.keys(style).length ? style : null
    }

    /** 归一场景卡（防御式；仅展示用字段；无 id/name 跳过；按 id 排序）。 */
    function normalizeVisualScenes(raw) {
      if (!Array.isArray(raw)) return []
      const scenes = []
      const seen = new Set()
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const id = typeof item.id === 'string' ? item.id.trim().toUpperCase() : ''
        const name = typeof item.name === 'string' ? item.name.trim() : ''
        if (!id || !name || seen.has(id)) continue
        seen.add(id)
        const space = item.space && typeof item.space === 'object' && !Array.isArray(item.space) ? item.space : {}
        const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max || 120) : '')
        scenes.push({
          id,
          name,
          interior: text(space.interior, 10),
          timeOfDay: text(space.timeOfDay, 40),
          weather: text(space.weather, 40),
          location: text(space.location, 120),
          lighting: text(item.lighting, 300),
          description: text(item.description, 300),
          assetRefs: Array.isArray(item.assetRefs) ? item.assetRefs.map((ref) => String(ref).trim()).filter(Boolean) : [],
          review: normalizeAssetReview(item.review),
        })
      }
      return scenes.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'))
    }

    /** 聚合资产卡 media.images（全部类型，按 URL 去重；thumbnail 不参与图墙）。 */
    function collectVisualImages(cards) {
      const entries = []
      const seen = new Set()
      for (const card of Array.isArray(cards) ? cards : []) {
        if (!card || !card.media || !Array.isArray(card.media.images)) continue
        for (const raw of card.media.images) {
          const src = assetImageSourceOf(raw)
          if (src.kind === 'none' || src.kind === 'invalid') continue
          if (seen.has(src.value)) continue
          seen.add(src.value)
          entries.push({ src: src.value, kind: src.kind, cardId: card.id, cardName: card.name, type: String(card.type || '').toUpperCase() })
        }
      }
      return entries
    }

        /* ---------------- v0.16.4（task-141 / C1-C）：视觉圣经图墙按资产类型分组 helper ---------------- */
    const VISUAL_WALL_GROUPS = [
      { key: 'scene', label: '场景', types: ['SPC'] },
      { key: 'char', label: '角色', types: ['CHR'] },
      { key: 'prop', label: '道具', types: ['PRP'] },
      { key: 'other', label: '其他', types: null },
    ]
    function visualWallGroupOf(type) {
      const normalized = String(type || '').toUpperCase()
      for (const group of VISUAL_WALL_GROUPS) {
        if (group.types && group.types.includes(normalized)) return group.key
      }
      return 'other'
    }
    function visualWallGroupLabel(key) {
      const group = VISUAL_WALL_GROUPS.find((item) => item.key === key)
      return group ? group.label : '其他'
    }

    /** 场景缩略图兜底：同 id 的 SPC 资产卡 media.thumbnail || media.images[0]（场景卡 schema 无 media）。 */
    function sceneThumbOf(scene, cardsById) {
      const card = scene && cardsById ? cardsById.get(String(scene.id || '').toUpperCase()) : null
      if (!card || !card.media) return ''
      return card.media.thumbnail || (Array.isArray(card.media.images) ? card.media.images[0] : '') || ''
    }

    /* ---------------- v0.15.4（task-119 / M20-C）：素材库 2.0 · legacy 登记统一视图 helper ---------------- */
    const LEGACY_ASSET_KIND_ORDER = ['image', 'video', 'audio', 'doc', 'other']
    const LEGACY_ASSET_KIND_LABELS = { image: '图片', video: '视频', audio: '音频', doc: '文档', other: '其他' }
    const legacyImageLoadState = new Map()

    function normalizeLegacyAssets(raw) {
      const list = []
      const seen = new Set()
      for (const item of Array.isArray(raw) ? raw : []) {
        if (!item || typeof item !== 'object') continue
        const id = typeof item.id === 'string' ? item.id.trim() : ''
        const name = typeof item.name === 'string' ? item.name.trim() : ''
        if (!id || !name || seen.has(id)) continue
        seen.add(id)
        const kindRaw = String(item.kind || '').trim().toLowerCase()
        const kind = LEGACY_ASSET_KIND_ORDER.includes(kindRaw) ? kindRaw : 'other'
        const bytes = Number(item.bytes)
        list.push({
          id,
          name,
          kind,
          bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0,
          sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
          note: typeof item.note === 'string' ? item.note.trim().slice(0, 500) : '',
          linkedShots: Array.isArray(item.linkedShots) ? item.linkedShots.map((shot) => String(shot).trim()).filter(Boolean) : [],
          source: typeof item.source === 'string' ? item.source : '',
        })
      }
      return list
    }

    function formatAssetBytes(bytes) {
      const value = Number(bytes) || 0
      if (value >= 1024 * 1024) return Math.round((value / (1024 * 1024)) * 10) / 10 + ' MB'
      if (value >= 1024) return Math.round((value / 1024) * 10) / 10 + ' KB'
      return value + ' B'
    }

    function legacyAssetSearchText(asset) {
      return [asset.name, asset.note, asset.id, ...(asset.linkedShots || []), asset.source].join(' ').toLowerCase()
    }

    function filterLegacyAssets(list, kind, query) {
      const kindKey = String(kind || 'all').toLowerCase()
      const keyword = String(query || '').trim().toLowerCase()
      return (Array.isArray(list) ? list : []).filter((asset) => {
        if (kindKey !== 'all' && asset.kind !== kindKey) return false
        if (!keyword) return true
        return legacyAssetSearchText(asset).includes(keyword)
      })
    }

    function sortLegacyAssets(list, sortKey) {
      const items = (Array.isArray(list) ? list : []).slice()
      if (sortKey === 'size-desc') return items.sort((a, b) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0) || String(a.name).localeCompare(String(b.name), 'zh'))
      return items.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))
    }

    // v0.15.5（task-121）：lightbox 关闭热修 —— 触发元素与 body overflow 原值（关闭时恢复焦点/滚动）
    let lightboxTriggerEl = null
    let lightboxPrevBodyOverflow = ''

    /* ---------------- v0.15.8（task-126 / EXT-C1）：素材登记仅项目内 helper ---------------- */
    const OUTSIDE_PROJECT_HINT = '素材必须位于项目文件夹内（仅支持项目内路径）：请先把文件放入项目「素材/」目录再登记'
    const OUTSIDE_PROJECT_MESSAGE_PATTERN = /项目文件夹内|项目目录|外部路径|素材必须位于|项目外|仅支持项目内/
    function normalizeProjectPath(value) {
      const text = String(value == null ? '' : value).trim().replace(/\\/g, '/')
      if (!text) return ''
      const driveMatch = /^([A-Za-z]):(?:\/|$)/.exec(text)
      const isUnc = text.startsWith('//')
      if (!driveMatch && !isUnc) return ''
      const stack = []
      const rest = driveMatch ? text.slice(driveMatch[0].length) : text.slice(2)
      for (const part of rest.split('/')) {
        if (!part || part === '.') continue
        if (part === '..') { stack.pop(); continue }
        stack.push(part)
      }
      const joined = stack.join('/')
      if (driveMatch) return driveMatch[1].toUpperCase() + ':' + (joined ? '/' + joined : '')
      return '//' + joined
    }
    function resolveProjectInternalPath(source, projectRoot) {
      const root = normalizeProjectPath(projectRoot)
      if (!root) return ''
      const text = String(source == null ? '' : source).trim().replace(/\\/g, '/')
      if (!text) return ''
      if (text.startsWith('//?/') || text.startsWith('//./')) return '' // 设备路径：无法归属项目内
      let candidate = ''
      if (/^[A-Za-z]:\//.test(text) || text.startsWith('//')) candidate = text
      else if (text.startsWith('/')) {
        const drive = /^([A-Za-z]):/.exec(root)
        if (drive) candidate = drive[1] + ':' + text
      } else candidate = root + '/' + text
      return normalizeProjectPath(candidate)
    }
    function isProjectExternalSource(source, projectRoot) {
      const root = normalizeProjectPath(projectRoot)
      if (!root) return false // 项目根未知 → 降级不标记（宁可不标，不误伤项目内绝对路径）
      const resolved = resolveProjectInternalPath(source, projectRoot)
      if (!resolved) return true // 设备路径/异常路径 → 视为项目外
      const target = resolved.toLowerCase()
      const boundary = root.toLowerCase()
      return !(target === boundary || target.startsWith(boundary + '/'))
    }
    // 错误文案里如夹带项目外绝对路径（如宿主「找不到文件：G:\...」）→ 隐藏，避免泄漏到 DOM
    function hideProjectExternalPaths(text, projectRoot) {
      return String(text == null ? '' : text).replace(/(?:[A-Za-z]:[\\/]|\/\/)[^\s'"，。；、）)]+/g, (token) => {
        const trimmed = token.replace(/[，。；、）)]+$/, '')
        return isProjectExternalSource(trimmed, projectRoot) ? '（外部路径已隐藏）' : token
      })
    }

    /* ---------------- v0.15.9（task-129 / D2C-C）：扫描素材目录 / 批量登记 helper ---------------- */
    const SCAN_KIND_ORDER = ['image', 'video', 'audio', 'doc', 'other']
    const SCAN_BATCH_WARN_THRESHOLD = 50
    function scanBasename(value) {
      const parts = String(value == null ? '' : value).split('/').filter(Boolean)
      return parts.length ? parts[parts.length - 1] : ''
    }
    function normalizeScanFiles(raw) {
      const files = []
      const seen = new Set()
      for (const item of Array.isArray(raw) ? raw : []) {
        if (!item || typeof item !== 'object') continue
        // 安全：只接受项目内相对路径（正斜杠），拒绝绝对路径/盘符/.. 段
        const rel = String(item.path == null ? '' : item.path).trim().replace(/\\/g, '/')
        if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) continue
        if (seen.has(rel)) continue
        seen.add(rel)
        const kindRaw = String(item.kindGuess || '').toLowerCase()
        const kind = SCAN_KIND_ORDER.includes(kindRaw) ? kindRaw : 'other'
        const size = Number(item.size)
        files.push({ path: rel, name: scanBasename(rel), kind, size: Number.isFinite(size) && size >= 0 ? size : 0 })
      }
      return files
    }

    /* ---------------- v0.16.x（C2-C 原型）：跨项目资产复用 helper（只读源项目 → assets-import B-1；无新调用点） ---------------- */
    const CROSS_IMPORT_MIN_HOST_VERSION = '0.16.7' // C2-H 交付版本（v0.16.7）；旧宿主隐藏入口
    const CROSS_IMPORT_MAX_BATCH = 100
    function crossAssetCategoryOf(source) {
      const text = String(source == null ? '' : source).replace(/\\/g, '/')
      const match = /^素材\/([^/]+)\//.exec(text)
      return match ? match[1] : ''
    }
    function normalizeCrossAssets(raw) {
      const seen = new Set()
      const list = []
      for (const item of Array.isArray(raw) ? raw : []) {
        if (!item || typeof item !== 'object') continue
        const id = String(item.id == null ? '' : item.id).trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        const name = String(item.name == null ? '' : item.name).trim() || id
        const kind = String(item.kind == null ? '' : item.kind).toLowerCase()
        const bytes = Number(item.bytes)
        const sha256 = String(item.sha256 == null ? '' : item.sha256)
        list.push({
          id,
          name,
          kind,
          category: crossAssetCategoryOf(item.source),
          bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0,
          sha256,
        })
      }
      return list.sort((a, b) => a.id.localeCompare(b.id, 'en'))
    }
    function sanitizeCrossMessage(text) {
      return String(text == null ? '' : text).replace(/(?:[A-Za-z]:[\\/]|\/\/)[^\s'"，。；、）)]+/g, '（路径已隐藏）')
    }
    function crossImportErrorText(error) {
      const code = String((error && error.code) || 'failed')
      const message = sanitizeCrossMessage((error && error.message) || '')
      if (code === 'duplicate' || code === 'conflict') return '已存在（内容相同），已跳过'
      if (code === 'too-large') return '文件超过 50MB 上限，未导入'
      if (code === 'forbidden' || code === 'invalid-args') return '源项目或资产不可用（仅支持受管项目内的已登记素材）'
      if (code === 'not-found') return '源资产已不存在，请刷新源列表后重试'
      if (code === 'style-directed' || code === 'style-locked') return '目标风格已定稿/已锁定，未导入风格（不改目标状态机）'
      if (code === 'id-exists') return '同 id 冲突（默认跳过）'
      if (code === 'alias-exists') return '别名冲突，未导入'
      return '导入失败：' + (message || '未知错误') + '（不阻塞；可重试失败项）'
    }

    /* ---------------- v0.16.8（I5-1-C）：跨项目对象导入（资产卡/场景卡/风格 DNA）helper ---------------- */
    const CROSS_OBJECTS_MIN_HOST_VERSION = '0.16.8'
    const CROSS_OBJECT_BATCH = 100
    const CROSS_TABS = [
      { key: 'assets', label: '素材' },
      { key: 'cards', label: '资产卡' },
      { key: 'scenes', label: '场景卡' },
      { key: 'style', label: '风格 DNA' },
    ]
    function crossCompact(input) {
      if (input == null) return undefined
      if (typeof input === 'string') return input.trim() ? input : undefined
      if (Array.isArray(input)) {
        const list = input.map((item) => crossCompact(item)).filter((item) => item !== undefined)
        return list.length ? list : undefined
      }
      if (typeof input === 'object') {
        const out = {}
        for (const key of Object.keys(input).sort()) {
          if (key === 'version' || key === 'history' || key === 'importedFrom') continue
          const value = crossCompact(input[key])
          if (value !== undefined) out[key] = value
        }
        return Object.keys(out).length ? out : undefined
      }
      return input
    }
    function crossStableStringify(value) {
      try { return JSON.stringify(crossCompact(value)) || '' } catch { return '' }
    }
    function crossCardSignature(card) {
      if (!card || typeof card !== 'object') return ''
      return crossStableStringify({
        id: card.id,
        type: card.type,
        name: card.name,
        status: card.status,
        aliases: card.aliases,
        fields: card.fields,
        relations: card.relations,
        prompts: card.prompts,
        media: card.media,
      })
    }
    function crossSceneSignature(scene) {
      if (!scene || typeof scene !== 'object') return ''
      return crossStableStringify({
        id: scene.id,
        name: scene.name,
        space: scene.space,
        lighting: scene.lighting,
        assetRefs: scene.assetRefs,
      })
    }
    function normalizeCrossCards(raw) {
      const list = []
      const seen = new Set()
      for (const item of Array.isArray(raw) ? raw : []) {
        if (!item || typeof item !== 'object') continue
        const id = String(item.id == null ? '' : item.id).trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        const media = item.media && typeof item.media === 'object' ? item.media : {}
        const imageCount = Array.isArray(media.images) ? media.images.length : 0
        const audioCount = Array.isArray(media.audio) ? media.audio.length : 0
        list.push({
          id,
          name: String(item.name == null ? '' : item.name).trim() || id,
          type: String(item.type == null ? '' : item.type).toUpperCase(),
          status: String(item.status == null ? '' : item.status),
          aliases: Array.isArray(item.aliases) ? item.aliases.map((alias) => String(alias)) : [],
          mediaCount: imageCount + audioCount + (media.thumbnail ? 1 : 0),
          instance: item,
        })
      }
      return list.sort((a, b) => a.id.localeCompare(b.id, 'en'))
    }
    function normalizeCrossScenes(raw) {
      const list = []
      const seen = new Set()
      for (const item of Array.isArray(raw) ? raw : []) {
        if (!item || typeof item !== 'object') continue
        const id = String(item.id == null ? '' : item.id).trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        const space = item.space && typeof item.space === 'object' ? item.space : {}
        const summary = [space.interior, space.timeOfDay, space.weather, space.location].filter(Boolean).join(' · ')
        list.push({
          id,
          name: String(item.name == null ? '' : item.name).trim() || id,
          summary,
          instance: item,
        })
      }
      return list.sort((a, b) => a.id.localeCompare(b.id, 'en'))
    }
    function normalizeCrossStyle(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const style = {}
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' && value.trim()) style[key] = value.trim()
      }
      return Object.keys(style).length ? style : null
    }
    function crossObjectCount(entry) {
      if (!entry || typeof entry !== 'object') return { ok: 0, duplicate: 0, fail: [] }
      const imported = Array.isArray(entry.imported) ? entry.imported : []
      const skipped = Array.isArray(entry.skipped) ? entry.skipped : []
      const failed = Array.isArray(entry.failed) ? entry.failed : []
      return { ok: imported.length, duplicate: skipped.length, fail: failed }
    }
    function sanitizeCrossWarnings(raw) {
      return (Array.isArray(raw) ? raw : []).map((item) => {
        const text = typeof item === 'string' ? item : String((item && (item.message || item.reason || item.warning || item.detail)) || '')
        return sanitizeCrossMessage(text).trim()
      }).filter(Boolean)
    }

    function crossFailureText(item) {
      if (!item || typeof item !== 'object') return '导入失败'
      const reason = item.reason || item.error || item.message
      if (reason) return sanitizeCrossMessage(String(reason))
      if (item.code) return crossImportErrorText({ code: item.code })
      return '导入失败'
    }
    function crossFailItems(rawList, kind, lookupName) {
      return (Array.isArray(rawList) ? rawList : []).map((item) => {
        const sourceId = String((item && (item.sourceAssetId || item.sourceCardId || item.sourceSceneId || item.id)) || '')
        const name = String((item && item.name) || (typeof lookupName === 'function' ? lookupName(sourceId) : '') || sourceId)
        return { kind, sourceId, name, reason: crossFailureText(item) }
      })
    }
    function crossCounts(rawEntry, kind, lookupName) {
      const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : {}
      const imported = Array.isArray(entry.imported) ? entry.imported : []
      const skipped = Array.isArray(entry.skipped) ? entry.skipped : []
      const failed = crossFailItems(entry.failed, kind, lookupName)
      return { ok: imported.length, duplicate: skipped.length, fail: failed }
    }

    /* ---------------- v0.16.10（M3-C）：registry 损坏提示 / 修复 / ledger 显式渲染 helper ---------------- */
    const M3_MIN_HOST_VERSION = '0.16.10' // M3-H 交付版本（C3 冻结/host M3 打包后校准）
    const REGISTRY_WARNING_TEXT = '素材登记文件损坏，已降级只读'
    const REGISTRY_WARNING_DETAIL = '扫描/导入素材/跨项目导入已暂停；请先修复登记表（修复前会备份原登记文件）。'
    const REGISTRY_REPAIR_CONFIRM = '修复素材登记表？\n\n将从项目「素材/」实际文件重建登记（按 SHA/大小校验）；修复前会备份原登记文件。'
    const REGISTRY_REPAIR_FAIL_TEXT = '修复失败：登记表未能重建（原文件与备份保留）；请检查项目数据文件后重试'
    const REGISTRY_DISABLED_ACTION_TEXT = '素材登记表损坏，请先修复登记表后再操作'
    const LEDGER_RENDER_FAIL_TEXT = '渲染失败：账本文件未写入（原数据未改动）'
    function m3RepairNotice(result) {
      const rebuilt = Number(
        result && (result.rebuiltCount != null
          ? result.rebuiltCount
          : result.rebuilt != null
            ? result.rebuilt
            : result.repairedCount != null
              ? result.repairedCount
              : result.count)
      )
      const count = Number.isFinite(rebuilt) && rebuilt >= 0 ? rebuilt : 0
      const backupPath = result && typeof result.backup === 'string' ? result.backup.trim() : ''
      const safeBackup = backupPath && !/^[A-Za-z]:[\\/]/.test(backupPath) && !backupPath.startsWith('/') ? backupPath : 'assets.json.bak'
      return `登记表已修复：重建 ${count} 条；原登记文件已备份（${safeBackup}）`
    }

    /* ---------------- v0.15.11（task-135 / IMP-C）：一键导入 helper（file input/拖拽 → assets-import） ---------------- */
    const IMPORT_MAX_BYTES = 50 * 1024 * 1024
    const IMPORT_MAX_BATCH = 20
    const IMPORT_MIN_HOST_VERSION = '0.15.11'
    const IMPORT_CATEGORIES = ['角色', '场景', '道具', '服装', '表情', '特效', '音效', '配音', '音乐', '分镜', '其他']
    const IMPORT_KIND_EXTENSIONS = {
      image: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
      audio: ['mp3', 'wav', 'm4a', 'ogg', 'aac'],
      video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'],
      doc: ['md', 'txt', 'json', 'pdf', 'doc', 'docx', 'csv'],
    }
    const IMPORT_ACCEPT = Object.values(IMPORT_KIND_EXTENSIONS).flat().map((ext) => '.' + ext).join(',')
    const IMPORT_KIND_LABELS = { image: '图片', audio: '音频', video: '视频', doc: '文档' }
    function importExtensionOf(name) {
      const text = String(name == null ? '' : name).trim()
      const match = /\.([A-Za-z0-9]{1,8})$/.exec(text)
      return match ? match[1].toLowerCase() : ''
    }
    function importKindOf(name) {
      const extension = importExtensionOf(name)
      for (const [kind, extensions] of Object.entries(IMPORT_KIND_EXTENSIONS)) {
        if (extensions.includes(extension)) return kind
      }
      return ''
    }
    function importKindLabelOf(name) {
      const kind = importKindOf(name)
      return IMPORT_KIND_LABELS[kind] || '未知类型'
    }
    function importDefaultCategory() {
      const now = new Date()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      return `导入_${now.getFullYear()}${month}${day}`
    }
    function importReadArrayBuffer(file) {
      return new Promise((resolve, reject) => {
        try {
          const reader = new window.FileReader()
          reader.onload = () => resolve(reader.result)
          reader.onerror = () => reject(new Error('文件读取失败'))
          reader.readAsArrayBuffer(file)
        } catch (error) {
          reject(new Error('文件读取失败'))
        }
      })
    }
    function importReadBase64(file) {
      return new Promise((resolve, reject) => {
        try {
          const reader = new window.FileReader()
          reader.onload = () => {
            const text = String(reader.result || '')
            const index = text.indexOf(',')
            resolve(index >= 0 ? text.slice(index + 1) : text)
          }
          reader.onerror = () => reject(new Error('文件读取失败'))
          reader.readAsDataURL(file)
        } catch (error) {
          reject(new Error('文件读取失败'))
        }
      })
    }
    async function importSha256Of(file) {
      // crypto.subtle 不可用 → 省略 expectedSha256（host 仍自行计算/校验）
      try {
        const subtle = typeof crypto !== 'undefined' && crypto && crypto.subtle ? crypto.subtle : null
        if (!subtle || typeof subtle.digest !== 'function') return ''
        const buffer = await importReadArrayBuffer(file)
        const digest = await subtle.digest('SHA-256', buffer)
        return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
      } catch (error) {
        return ''
      }
    }

    /* ---------------- v0.16.1（task-139 / C-6）：产物入库三模式 helper（本地文件→assets-import；项目内路径/URL→intake-artifact） ---------------- */
    const ARTIFACT_EXTERNAL_HINT = '本地外部文件请使用「选择文件导入素材库」；或先把文件放入项目「素材/生成/」再传项目内路径'
    const ARTIFACT_LOCAL_TOO_LARGE = '文件超过 50MB 上限'
    const ARTIFACT_LOCAL_BAD_TYPE = '不支持的类型（png/jpg/jpeg/webp/gif、mp4/mov/webm/mkv/avi/m4v、mp3/wav/m4a/ogg/aac、md/txt/json/pdf/doc/docx/csv）'
    const ARTIFACT_CATEGORY_DEFAULT = '生成'
    const ARTIFACT_CATEGORIES = [ARTIFACT_CATEGORY_DEFAULT, ...IMPORT_CATEGORIES.filter((category) => category !== ARTIFACT_CATEGORY_DEFAULT)]
    const ARTIFACT_URL_HINTS = {
      private: '该链接指向内网或本机地址，出于安全考虑不允许下载',
      redirect: '链接重定向次数过多或跳转到不允许的地址，请使用直链',
      scheme: '仅支持 http(s) 直链（不允许账号密码或非法格式）；请粘贴生成产物的直链地址',
      tooLarge: '远程文件超过 64MB 上限，未入库；大文件请下载后使用「选择文件导入素材库」（单文件 ≤50MB）或放入项目「素材/生成/」',
      download: '下载失败：无法解析或访问链接，请检查链接或改用本地文件导入',
    }
    function artifactModeOf(file, source) {
      if (file) return 'file'
      const text = String(source == null ? '' : source).trim()
      // 任何 scheme:// 文本都按 URL 模式交给宿主校验（非 http(s) 会得到固定协议提示，而不是当地址）
      return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ? 'url' : 'path'
    }
    function mapArtifactUrlError(error) {
      const code = String((error && error.code) || '')
      const message = String((error && error.message) || '')
      if (/重定向|redirect/i.test(message)) return ARTIFACT_URL_HINTS.redirect
      if (code === 'forbidden' || /内网|本机|localhost|不允许访问|地址不被允许/i.test(message)) return ARTIFACT_URL_HINTS.private
      if (code === 'too-large' || /过大|超过.*64|64MB/i.test(message)) return ARTIFACT_URL_HINTS.tooLarge
      if (code === 'invalid-args') return ARTIFACT_URL_HINTS.scheme
      if (code === 'failed' || /解析|下载失败|HTTP/i.test(message)) return ARTIFACT_URL_HINTS.download
      return ''
    }
    function mapArtifactPathError(error) {
      const code = String((error && error.code) || '')
      const message = String((error && error.message) || '')
      if (code === 'forbidden' || /项目内|项目外|外部路径|外部文件|素材库「一键导入」|短剧项目内/i.test(message)) return ARTIFACT_EXTERNAL_HINT
      return ''
    }
    let importFileSeq = 0
    function importStatusText(item) {
      if (!item) return ''
      if (item.status === 'queued') return '待导入'
      if (item.status === 'importing') return '导入中…'
      if (item.status === 'ok') return '✓ 已导入'
      if (item.status === 'duplicate') return '已存在'
      if (item.status === 'too-large' || item.status === 'unsupported' || item.status === 'limit') return `⚠ ${item.reason}`
      if (item.status === 'fail') return `✗ ${item.reason || '导入失败'}`
      return ''
    }

    /* ------------------------------------------------------------ 通用控件 */

    /* ------------------------------------ v0.14.0（task-38 / M6-1 C 路径）：交接指令生成 */
    const HANDOFF_CHAR_LIMIT = 2000
    const HANDOFF_BYTE_LIMIT = 4096
    const HANDOFF_TRUNCATED_SUFFIX = '（已截断：其余上下文未包含）'
    function handoffBasename(pathValue) {
      const text = String(pathValue == null ? '' : pathValue).trim()
      const parts = text.split(/[\\/]+/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : '（未知目录）'
    }
    function handoffClipLine(value, max) {
      const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
      const limit = max || 120
      return text.length > limit ? text.slice(0, limit) + '…' : text
    }
    function handoffSummaryLinesOf(tabKey, data) {
      const d = data || {}
      const lines = []
      const push = (label, value) => {
        const text = handoffClipLine(value, 120)
        if (text) lines.push(label + '：' + text)
      }
      if (tabKey === 'contract') {
        const c = d.contract || {}
        push('平台 / 受众', [c.platform, c.audience].filter(Boolean).join(' / '))
        if (c.targetEpisodes) push('目标集数', c.targetEpisodes)
        if (Array.isArray(c.episodeDurationSec) && c.episodeDurationSec.length) push('单集时长', c.episodeDurationSec.join('–') + ' 秒')
        if (c.orientation) push('画幅', c.orientation === 'portrait' ? '竖屏' : c.orientation === 'landscape' ? '横屏' : c.orientation)
      } else if (tabKey === 'outline') {
        if (Array.isArray(d.rows) && d.rows.length) {
          push('总纲行数', d.rows.length)
          const titles = d.rows.slice(0, 3).map((row) => String((row && row.title) || '').trim()).filter(Boolean)
          if (titles.length) push('前几行标题', titles.join(' / '))
        } else push('总纲', '尚无行（可在交接后让 Agent 协助起草）')
      } else if (tabKey === 'characters') {
        const list = Array.isArray(d.characters) ? d.characters : []
        push('角色数', list.length)
        const names = list.slice(0, 8).map((card) => String((card && card.name) || '').trim()).filter(Boolean)
        if (names.length) push('角色名', names.join('、'))
      } else if (tabKey === 'world') {
        const list = Array.isArray(d.world) ? d.world : []
        push('世界观条目数', list.length)
        const names = list.slice(0, 8).map((entry) => String((entry && (entry.name || entry.title || entry.key)) || '').trim()).filter(Boolean)
        if (names.length) push('条目', names.join('、'))
      } else if (tabKey === 'episode') {
        const list = Array.isArray(d.episodes) ? d.episodes : []
        push('已建集数', list.length)
        if (d.episodeOrder != null) push('当前集', '第' + String(d.episodeOrder) + '集')
        push('当前集正文摘要', handoffClipLine(String(d.episodeText || '').slice(0, 200), 200) || '（未载入正文）')
      } else if (tabKey === 'storyboard') {
        push('分镜镜头数', Array.isArray(d.shots) ? d.shots.length : 0)
      } else if (tabKey === 'dialogue') {
        push('台词条目数', Array.isArray(d.dialogue) ? d.dialogue.length : (d.dialogue && typeof d.dialogue === 'object' ? Object.keys(d.dialogue).length : 0))
      } else if (tabKey === 'assets') {
        push('素材数', Array.isArray(d.assets) ? d.assets.length : 0)
      } else if (tabKey === 'memory') {
        push('记忆条目数', Array.isArray(d.memory) ? d.memory.length : 0)
      } else if (tabKey === 'drafts') {
        push('草稿数', Array.isArray(d.draftList) ? d.draftList.length : 0)
      } else if (tabKey === 'ledger') {
        const ledger = d.ledger
        push('账本', ledger && typeof ledger === 'object' ? (Array.isArray(ledger) ? ledger.length + ' 条' : '已加载（明细见项目文件）') : '未加载')
      } else if (tabKey === 'generate') {
        push('生成任务数', Array.isArray(d.genTasks) ? d.genTasks.length : 0)
      } else if (tabKey === 'check') {
        const report = d.report || d.reviewReport
        if (report && Array.isArray(report.findings)) push('审读发现', report.findings.length + ' 条')
        else push('审读报告', '尚未生成')
        push('定稿记录', Array.isArray(d.exported) ? d.exported.length + ' 条' : (Array.isArray(d.finalized) ? d.finalized.length + ' 条' : '未加载'))
      } else if (tabKey === 'tree') {
        push('目录树', d.tree ? '已加载（文件内容由 Agent 在项目中读取）' : '未加载')
      } else {
        push('页签', String(tabKey || ''))
      }
      return lines.slice(0, 8)
    }
    function handoffWithinLimits(text) {
      const value = String(text == null ? '' : text)
      if (value.length > HANDOFF_CHAR_LIMIT) return false
      try {
        if (typeof TextEncoder === 'function' && new TextEncoder().encode(value).length > HANDOFF_BYTE_LIMIT) return false
      } catch { /* 无 TextEncoder 时按字符上限 */ }
      return true
    }
    function truncateHandoff(text) {
      const full = String(text == null ? '' : text)
      if (handoffWithinLimits(full)) return full
      const suffix = HANDOFF_TRUNCATED_SUFFIX
      let body = full.slice(0, Math.max(0, HANDOFF_CHAR_LIMIT - suffix.length))
      try {
        if (typeof TextEncoder === 'function') {
          const encoder = new TextEncoder()
          while (body.length > 0 && encoder.encode(body + suffix).length > HANDOFF_BYTE_LIMIT) {
            body = body.slice(0, Math.max(0, body.length - Math.max(1, Math.ceil(body.length / 50))))
          }
        }
      } catch { /* 无 TextEncoder 时仅字符上限 */ }
      return body + suffix
    }
    function buildHandoffInstruction(args) {
      const a = args || {}
      const title = handoffClipLine(a.title, 120) || '（未命名项目）'
      const dir = handoffBasename(a.sourcePath)
      const tabLabel = handoffClipLine(a.tabLabel, 40) || handoffClipLine(a.tab, 40) || '当前页签'
      const lines = Array.isArray(a.summaryLines) ? a.summaryLines : []
      const parts = [
        '你是短剧模式 Agent。请接手以下短剧项目的下一步工作：',
        '项目：《' + title + '》',
        '目录：' + dir,
        '当前页签：' + tabLabel,
        '任务：请先阅读该项目的相关文件，围绕「' + tabLabel + '」给出可执行的下一步建议与修改计划（先不要直接改文件）。',
        '必要上下文摘要：',
      ]
      if (lines.length) lines.forEach((line) => parts.push('- ' + handoffClipLine(line, 160)))
      else parts.push('- （当前页签暂无可摘要数据，请直接查阅项目文件）')
      parts.push('约束：遵守项目契约与合规要求；如涉及生成/提交等操作，先说明计划并等待确认。')
      return truncateHandoff(parts.join('\n'))
    }

    function Field(props) {
      return h(
        'div',
        { className: 'ad-field' },
        h('label', null, props.label),
        h('input', {
          className: 'ad-input',
          value: props.value == null ? '' : String(props.value),
          placeholder: props.placeholder || '',
          onChange: (e) => props.onChange(e.target.value),
        }),
      )
    }

    function TextField(props) {
      return h(
        'div',
        { className: 'ad-field' },
        h('label', null, props.label),
        h('textarea', {
          className: 'ad-area',
          rows: props.rows || 3,
          value: props.value == null ? '' : String(props.value),
          placeholder: props.placeholder || '',
          onChange: (e) => props.onChange(e.target.value),
        }),
      )
    }

    /* v0.16.2（C1-C）：契约页「八大设定（可选）」8 字段（E14 add-only；空串删键/读不补默认）
     * 字段顺序 = worldSpace→worldTime→powerSystem→speciesEcology→factions→resourceEconomy→cultureBelief→soulDeath */
    const CONTRACT_WORLD_FIELDS = [
      ['worldSpace', '地理与空间', 1500, '舞台 / 通行成本 / 空间结构'],
      ['worldTime', '时间与历史', 1500, '时代 / 关键历史事件 / 时间规则'],
      ['powerSystem', '力量体系', 2000, '力量来源 / 天花板 / 代价（必须写清上限与代价）'],
      ['speciesEcology', '种族与生态', 1200, '种族 / 生态 / 种族间关系'],
      ['factions', '社会与势力', 1500, '势力格局 / 阵营 / 冲突'],
      ['resourceEconomy', '资源与经济', 1200, '稀缺资源 / 货币 / 交换规则'],
      ['cultureBelief', '文化与信仰', 1500, '信仰 / 习俗 / 禁忌'],
      ['soulDeath', '灵魂/生死/因果', 1500, '死后去哪 / 能否复活 / 死亡权重'],
    ]

    /** 八大字段读取：仅接受 string；缺省/非法类型按未填处理（读不补默认）。 */
    function contractWorldValue(contract, key) {
      const value = contract && typeof contract === 'object' ? contract[key] : undefined
      return typeof value === 'string' ? value : ''
    }

    /** 已填计数（trim 后非空；用于折叠组「已填 X/8 / 未填写」）。 */
    function contractWorldFilledCount(contract) {
      return CONTRACT_WORLD_FIELDS.filter(([key]) => contractWorldValue(contract, key).trim() !== '').length
    }

    /** 保存 payload（Lead 19:2x 修正）：8 个键**始终存在**且为 string —— 未填/清空发 ''，
     *  由宿主 C1-H 在 trim 后删除该键（解决「清空字段无法删除旧值」）；非空发 trim 值；
     *  其余 7 字段与未知旧字段原样保留。 */
    function contractWorldPayload(contract) {
      const payload = contract && typeof contract === 'object' ? { ...contract } : {}
      for (const [key] of CONTRACT_WORLD_FIELDS) {
        const value = contractWorldValue(payload, key).trim()
        payload[key] = value ? value : ''
      }
      return payload
    }

    /** 超长前端提示（trim 后字符数 > 上限）；后端 C1-H 400 仍为最终权威。 */
    function contractWorldOverLimit(contract) {
      return CONTRACT_WORLD_FIELDS
        .map(([key, label, limit]) => [label, contractWorldValue(contract, key).trim().length, limit])
        .filter(([, length, limit]) => length > limit)
    }
    /* ============================================= v0.12.1（task-8）：独立设置页 */
    // 宿主 settings.section（侧栏「设置 → AI 短剧」）与项目页面板内设置浮层共用同一组件：
    // - 每次挂载都 settings-get 重读（宿主 tree 与主面板 tree 之间经 API 共享状态）
    // - 保存继续走既有 settings-save（不新增路由/调用点；旧宿主 costTier SKIP 逻辑原样保留）
    // - 任务模型/成本档位等文案与 aria 原样保留（既有客户端静态断言依赖这些 marker）
    function SettingsSection(props) {
      const options = props || {}
      const closeHandler = typeof options.onClose === 'function'
        ? options.onClose
        : typeof options.close === 'function' ? options.close : null
      const [settings, setSettings] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [flash, setFlash] = React.useState('')
      const [taskModelError, setTaskModelError] = React.useState('')
      const [taskModelRecent, setTaskModelRecent] = React.useState(() => loadRecentTaskModels())
      const [costTierNotice, setCostTierNotice] = React.useState('')
      // v0.12.3（task-21 / M4 批2）：诊断区 4 条既有路由（只读；仅按钮显式点击时调用，挂载不自动跑）
      const [diagBackends, setDiagBackends] = React.useState(null)
      const [diagBackendsBusy, setDiagBackendsBusy] = React.useState(false)
      const [diagCatalog, setDiagCatalog] = React.useState(null)
      const [diagCatalogBusy, setDiagCatalogBusy] = React.useState(false)
      const [diagCatalogBackend, setDiagCatalogBackend] = React.useState('neowow')
      const [diagCatalogKind, setDiagCatalogKind] = React.useState('image')
      const [diagAgents, setDiagAgents] = React.useState(null)
      const [diagAgentsBusy, setDiagAgentsBusy] = React.useState(false)
      const [diagPing, setDiagPing] = React.useState(null)
      const [diagPingBusy, setDiagPingBusy] = React.useState(false)

      const say = (message) => {
        setFlash(message)
        window.setTimeout(() => setFlash(''), 2200)
      }
      // v0.9.2（P3-E）：成本档位 —— 旧宿主（<0.9.2）SKIP 不发送（与主面板原逻辑一致）
      const hostSupportsCostTier = () => versionAtLeast((status && status.version) || '', COST_TIER_MIN_HOST_VERSION)

      const load = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const [st, stg] = await Promise.all([api('status'), api('settings-get')])
          setStatus(st)
          setSettings(normalizeSettings(stg.settings))
        } catch (err) {
          setError(err.message)
        } finally {
          setLoading(false)
        }
      }, [])
      React.useEffect(() => {
        load()
      }, [load])

      /* ------------------------------- P2-6 任务模型（settings.taskModels，Q1–Q5） */

      const taskModelsOf = () => normalizeTaskModels((settings && settings.taskModels) || {})
      const setAuditTaskModelDefault = (useDefault) => {
        setTaskModelError('')
        setSettings((prev) => {
          const base = normalizeSettings(prev)
          const models = { ...(base.taskModels || {}) }
          if (useDefault) delete models.audit
          else models.audit = { model: '' }
          return { ...base, taskModels: models }
        })
      }
      // 逐字段编辑 + Q4 即时校验（temperature 0–2、maxTokens ≤60000、model 必填）
      const setAuditTaskModelField = (key, value) => {
        setSettings((prev) => {
          const base = normalizeSettings(prev)
          const models = { ...(base.taskModels || {}) }
          const entry = { ...(models.audit || {}) }
          if (value === '' || value == null) delete entry[key]
          else if (key === 'temperature' || key === 'maxTokens' || key === 'timeoutMs') entry[key] = Number(value)
          else entry[key] = String(value)
          models.audit = entry
          return { ...base, taskModels: models }
        })
        if (key === 'temperature') {
          const num = Number(value)
          setTaskModelError(value !== '' && (!Number.isFinite(num) || num < 0 || num > TASK_MODEL_MAX_TEMPERATURE)
            ? 'Temperature 需在 0~2 之间'
            : '')
        } else if (key === 'maxTokens') {
          const num = Number(value)
          setTaskModelError(value !== '' && (!Number.isFinite(num) || num < 1 || num > TASK_MODEL_MAX_TOKENS)
            ? `MaxTokens 需在 1~${TASK_MODEL_MAX_TOKENS}（全局上限 60k）之间`
            : '')
        } else if (key === 'timeoutMs') {
          const num = Number(value)
          setTaskModelError(value !== '' && (!Number.isFinite(num) || !Number.isInteger(num) || num < TASK_MODEL_MIN_TIMEOUT_MS || num > TASK_MODEL_MAX_TIMEOUT_MS)
            ? `超时需在 ${TASK_MODEL_MIN_TIMEOUT_MS}~${TASK_MODEL_MAX_TIMEOUT_MS} 毫秒之间（整数）`
            : '')
        } else if (key === 'model') {
          setTaskModelError(value !== '' && !String(value).trim() ? '模型名不能为空' : '')
        } else {
          setTaskModelError('')
        }
      }
      // v0.6.3：最近使用模型（localStorage 本地记录，去重 + 最多 8 条）
      const rememberRecentTaskModel = (entry) => {
        const model = entry && typeof entry.model === 'string' ? entry.model.trim() : ''
        if (!model) return
        setTaskModelRecent((prev) => {
          const next = mergeRecentTaskModel(prev, { provider: entry.provider || '', model })
          saveRecentTaskModels(next)
          return next
        })
      }
      const applyRecentTaskModel = (item) => {
        if (!item || !item.model) return
        setAuditTaskModelField('model', item.model)
        if (item.provider) setAuditTaskModelField('provider', item.provider)
        say('已填入最近使用的模型：' + item.model)
      }
      const setAuditTaskModelCostTier = (value) => {
        const key = normalizeCostTier(value)
        if (value && !key) {
          setTaskModelError('成本档位需为 fast / standard / strong')
          return
        }
        setTaskModelError('')
        setCostTierNotice('')
        setSettings((prev) => {
          const base = normalizeSettings(prev)
          const models = { ...(base.taskModels || {}) }
          const entry = { ...(models.audit || {}) }
          if (key) entry.costTier = key
          else delete entry.costTier
          models.audit = entry
          return { ...base, taskModels: models }
        })
      }
      const validateTaskModelsForSave = (normalized) => {
        const audit = normalized && normalized.taskModels ? normalized.taskModels.audit : null
        if (!audit) return ''
        if (!audit.model || !String(audit.model).trim()) {
          // v0.9.2：仅配置成本档位（costTier）时允许不填 model（host 侧按档位映射解析）
          if (!audit.costTier) return '审读（audit）任务模型名不能为空（或配置成本档位）；不需要任务级覆盖请勾选「使用宿主默认」'
        }
        if (audit.temperature != null && (!Number.isFinite(Number(audit.temperature)) || Number(audit.temperature) < 0 || Number(audit.temperature) > 2)) {
          return 'Temperature 需在 0~2 之间'
        }
        if (audit.maxTokens != null && (Math.round(Number(audit.maxTokens)) < 1 || Math.round(Number(audit.maxTokens)) > TASK_MODEL_MAX_TOKENS)) {
          return `MaxTokens 需在 1~${TASK_MODEL_MAX_TOKENS}（全局上限 60k）之间`
        }
        if (audit.timeoutMs != null && (!Number.isInteger(Number(audit.timeoutMs)) || Number(audit.timeoutMs) < TASK_MODEL_MIN_TIMEOUT_MS || Number(audit.timeoutMs) > TASK_MODEL_MAX_TIMEOUT_MS)) {
          return `超时需在 ${TASK_MODEL_MIN_TIMEOUT_MS}~${TASK_MODEL_MAX_TIMEOUT_MS} 毫秒之间（整数）`
        }
        if (audit.costTier != null && audit.costTier !== '' && !normalizeCostTier(audit.costTier)) {
          return '成本档位需为 fast / standard / strong'
        }
        return ''
      }

      const saveSettings = async () => {
        if (!settings || busy) return
        setTaskModelError('')
        setError('')
        setBusy(true)
        try {
          // 先按「用户意图」校验原始 taskModels（勾掉默认但没填 model 时要提示，而不是静默丢弃）
          const rawTaskModels = (settings && settings.taskModels) || {}
          const rawAudit = rawTaskModels.audit
          const rawCostTier = rawAudit ? normalizeCostTier(rawAudit.costTier) : ''
          if (rawAudit && !String(rawAudit.model || '').trim() && !rawCostTier) {
            setTaskModelError('审读（audit）任务模型名不能为空（或配置成本档位）；不需要任务级覆盖请勾选「使用宿主默认」')
            return
          }
          if (rawAudit) {
            // 原始值越界时明确报错（归一化会丢弃非法值，不能让它静默保存成「未配置」）
            if (rawAudit.temperature != null && rawAudit.temperature !== '') {
              const temperature = Number(rawAudit.temperature)
              if (!Number.isFinite(temperature) || temperature < 0 || temperature > TASK_MODEL_MAX_TEMPERATURE) {
                setTaskModelError('Temperature 需在 0~2 之间')
                return
              }
            }
            if (rawAudit.maxTokens != null && rawAudit.maxTokens !== '') {
              const maxTokens = Number(rawAudit.maxTokens)
              if (!Number.isFinite(maxTokens) || Math.round(maxTokens) < 1 || Math.round(maxTokens) > TASK_MODEL_MAX_TOKENS) {
                setTaskModelError(`MaxTokens 需在 1~${TASK_MODEL_MAX_TOKENS}（全局上限 60k）之间`)
                return
              }
            }
            if (rawAudit.timeoutMs != null && rawAudit.timeoutMs !== '') {
              const timeoutMs = Number(rawAudit.timeoutMs)
              if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < TASK_MODEL_MIN_TIMEOUT_MS || timeoutMs > TASK_MODEL_MAX_TIMEOUT_MS) {
                setTaskModelError(`超时需在 ${TASK_MODEL_MIN_TIMEOUT_MS}~${TASK_MODEL_MAX_TIMEOUT_MS} 毫秒之间（整数）`)
                return
              }
            }
            if (rawAudit.costTier != null && rawAudit.costTier !== '' && !normalizeCostTier(rawAudit.costTier)) {
              setTaskModelError('成本档位需为 fast / standard / strong')
              return
            }
          }
          const normalized = normalizeSettings(settings)
          const invalid = validateTaskModelsForSave(normalized)
          if (invalid) {
            setTaskModelError(invalid)
            return
          }
          setTaskModelError('')
          // v0.9.2（P3-E）：旧宿主（<0.9.2）SKIP —— 不发送 costTier 字段（零副作用，避免 400）
          let payload = normalized
          if (!hostSupportsCostTier() && payload.taskModels) {
            const stripped = {}
            for (const [task, entry] of Object.entries(payload.taskModels)) {
              const copy = { ...entry }
              delete copy.costTier
              delete copy.costTierModels
              if (Object.keys(copy).length) stripped[task] = copy
            }
            payload = { ...payload, taskModels: stripped }
          }
          const result = await api('settings-save', { settings: payload })
          const nextSettings = normalizeSettings(result.settings)
          setSettings(nextSettings)
          say('设置已保存')
          // v0.6.3：保存成功后记录「最近使用」模型（去重 + 上限 8 条，仅本地 localStorage）
          const savedAudit = nextSettings && nextSettings.taskModels ? nextSettings.taskModels.audit : null
          if (savedAudit && savedAudit.model) rememberRecentTaskModel({ provider: savedAudit.provider || '', model: savedAudit.model })
          // v0.9.2（P3-E）：成本档位 SKIP / 回退提示（消费 host 只增字段）
          const skippedCostTier = !hostSupportsCostTier() && Boolean(rawAudit && rawAudit.costTier)
          setCostTierNotice(
            skippedCostTier
              ? '当前宿主版本不支持成本档位：已跳过（SKIP，不发送该字段）'
              : costTierFallbackFrom(result),
          )
          // Q3 运行时探测：宿主若返回 modelFallback 标记（只增字段）则明确提示降级；旧宿主无该字段忽略
          const fallback = result.modelFallback === true ||
            (result.settings && result.settings.modelFallback === true) ||
            nextSettings.modelFallback === true
          if (fallback) {
            setTaskModelError('模型运行时探测不可用：宿主将回退到默认模型并标记 modelFallback（不阻断审读）。')
          }
          if (typeof options.onSaved === 'function') options.onSaved(nextSettings)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }

      const refreshStatus = async () => {
        try {
          setStatus(await api('status'))
        } catch (err) {
          setError(err.message)
        }
      }

      // v0.12.3（task-21 / M4 批2）：诊断区 4 条既有路由 —— 只有用户点按钮时才调用（挂载/打开设置页不自动跑）
      const probeDiagnosticBackends = async () => {
        if (diagBackendsBusy) return
        setDiagBackendsBusy(true)
        setDiagBackends(null)
        try {
          const result = await api('backends-status', {})
          setDiagBackends(result && typeof result === 'object' ? result : { backends: [], degraded: true, note: '后端探测返回为空' })
        } catch (err) {
          setDiagBackends({ backends: [], degraded: true, note: '后端探测失败：' + err.message + '（不阻塞）' })
        } finally {
          setDiagBackendsBusy(false)
        }
      }

      const loadDiagnosticCatalog = async () => {
        if (diagCatalogBusy) return
        setDiagCatalogBusy(true)
        setDiagCatalog(null)
        try {
          const result = await api('catalog', { backend: diagCatalogBackend, kind: diagCatalogKind, refresh: true })
          setDiagCatalog(result && typeof result === 'object' ? result : { ok: false, count: 0, models: [], detail: '模型目录返回为空' })
        } catch (err) {
          setDiagCatalog({ ok: false, count: 0, models: [], detail: err.message })
        } finally {
          setDiagCatalogBusy(false)
        }
      }

      const loadDiagnosticAgents = async () => {
        if (diagAgentsBusy) return
        setDiagAgentsBusy(true)
        setDiagAgents(null)
        try {
          const result = await api('agents-status', {})
          setDiagAgents(result && typeof result === 'object' ? result : { ok: false, detail: 'Agent 诊断返回为空' })
        } catch (err) {
          setDiagAgents({ ok: false, detail: err.message })
        } finally {
          setDiagAgentsBusy(false)
        }
      }

      const pingDiagnostic = async () => {
        if (diagPingBusy) return
        setDiagPingBusy(true)
        setDiagPing(null)
        const startedAt = Date.now()
        try {
          const result = await api('ping', {})
          setDiagPing({ ...(result && typeof result === 'object' ? result : {}), latencyMs: Date.now() - startedAt })
        } catch (err) {
          setDiagPing({ ok: false, error: err.message, latencyMs: Date.now() - startedAt })
        } finally {
          setDiagPingBusy(false)
        }
      }

      const body = []
      if (loading) {
        body.push(h('div', { className: 'ad-skeleton', key: 'st-loading', role: 'status', 'aria-label': '设置载入中骨架' },
          h('div', { className: 'ad-skeleton-line w60' }),
          h('div', { className: 'ad-skeleton-line w90' }),
          h('div', { className: 'ad-skeleton-line w80' })))
      } else if (!settings) {
        body.push(emptyState({
          key: 'st-error',
          title: '设置载入失败',
          description: error || '无法读取宿主设置（settings-get）。',
          next: '检查宿主连接后重试；列表页/项目数据不受影响',
          actions: [{ label: '重试', onClick: load }],
        }))
      } else {
        const rawModels = settings.taskModels && typeof settings.taskModels === 'object' ? settings.taskModels : {}
        const rawAudit = rawModels.audit && typeof rawModels.audit === 'object' && !Array.isArray(rawModels.audit) ? rawModels.audit : null
        const useDefault = !rawAudit
        const audit = rawAudit || {}
        body.push(
          h('div', { className: 'ad-form-group', key: 'st-contract' },
            h('div', { className: 'ad-sec' }, '默认契约'),
            h('div', { className: 'ad-settings-grid' },
              h(Field, { label: '默认平台', value: settings.defaultPlatform, placeholder: '抖音 / 快手 / 红果', onChange: (v) => setSettings({ ...settings, defaultPlatform: v }) }),
              h(Field, { label: '默认目标集数', value: settings.defaultTargetEpisodes, onChange: (v) => setSettings({ ...settings, defaultTargetEpisodes: Number(v) || 0 }) }),
              h('div', { className: 'ad-field' },
                h('label', null, '默认单集时长'),
                h('input', { className: 'ad-input', type: 'number', value: settings.defaultEpisodeDurationSec[0], onChange: (e) => setSettings({ ...settings, defaultEpisodeDurationSec: [Number(e.target.value), settings.defaultEpisodeDurationSec[1]] }) }),
                h('span', null, '~'),
                h('input', { className: 'ad-input', type: 'number', value: settings.defaultEpisodeDurationSec[1], onChange: (e) => setSettings({ ...settings, defaultEpisodeDurationSec: [settings.defaultEpisodeDurationSec[0], Number(e.target.value)] }) })),
              h('div', { className: 'ad-field' },
                h('label', null, '默认画幅'),
                h('select', { className: 'ad-select', value: settings.defaultOrientation, onChange: (e) => setSettings({ ...settings, defaultOrientation: e.target.value }) },
                  h('option', { value: 'portrait' }, '竖屏'), h('option', { value: 'landscape' }, '横屏'))))),
          h('div', { className: 'ad-form-group', key: 'st-model' },
            h('div', { className: 'ad-sec' }, '默认模型与检索'),
            h('div', { className: 'ad-settings-grid' },
              h(Field, { label: '默认模型', value: settings.defaultModel, placeholder: '留空 = 跟随会话当前模型', onChange: (v) => setSettings({ ...settings, defaultModel: v }) }),
              h(Field, { label: '检索条数', value: settings.retrievalTopK, onChange: (v) => setSettings({ ...settings, retrievalTopK: Number(v) || 5 }) }),
              h('div', { className: 'ad-field' },
                h('label', null, '检索增强'),
                h('select', { className: 'ad-select', value: settings.retrievalEnabled ? 'on' : 'off', onChange: (e) => setSettings({ ...settings, retrievalEnabled: e.target.value === 'on' }) },
                  h('option', { value: 'on' }, '开启（生成前召回设定 / 伏笔）'), h('option', { value: 'off' }, '关闭')))),
            h(Field, { label: '存储位置', value: settings.storageLocation, placeholder: '留空 = 默认位置（P1 仅持久化预留，切换存储根在 P2 生效）', onChange: (v) => setSettings({ ...settings, storageLocation: v }) })),
          h('div', { className: 'ad-form-group', key: 'st-task-model' },
            h('div', { className: 'ad-sec' }, '任务模型'),
            h('div', { className: 'ad-box' },
              h('div', { className: 'ad-row', style: { marginBottom: 6, flexWrap: 'wrap' } },
                h('span', { className: 'ad-count' }, '按任务覆盖模型参数；未配置 = 跟随宿主默认'),
                h('div', { style: { flex: 1 } }),
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 } },
                  h('input', {
                    className: 'ad-check',
                    type: 'checkbox',
                    checked: useDefault,
                    'aria-label': '审读任务使用宿主默认模型',
                    onChange: (e) => setAuditTaskModelDefault(e.target.checked),
                  }),
                  '审读：使用宿主默认')),
              useDefault
                ? h('div', { className: 'ad-hint-next' }, '跟随宿主默认（回退链：settings.defaultModel → 宿主 agentDefaultModel）。取消勾选可配置任务级模型。')
                : h('div', { className: 'ad-settings-grid', style: { marginBottom: 8 } },
                    h(Field, { label: 'Provider', value: audit.provider || '', placeholder: '留空 = 宿主默认 provider', onChange: (v) => setAuditTaskModelField('provider', v) }),
                    h(Field, { label: '审读模型', value: audit.model || '', placeholder: hostSupportsCostTier() ? '必填；或仅配置成本档位（留空）' : '必填，例如 deepseek-reasoner', onChange: (v) => setAuditTaskModelField('model', v) }),
                    h(Field, { label: 'Temperature', value: audit.temperature == null ? '' : audit.temperature, placeholder: '0~2，留空 = 宿主默认', onChange: (v) => setAuditTaskModelField('temperature', v) }),
                    h(Field, { label: 'MaxTokens', value: audit.maxTokens == null ? '' : audit.maxTokens, placeholder: '≤60000，留空 = 宿主默认 60k', onChange: (v) => setAuditTaskModelField('maxTokens', v) }),
                    h(Field, { label: '超时(ms)', value: audit.timeoutMs == null ? '' : audit.timeoutMs, placeholder: '1000~60000，留空 = 宿主默认 45s', onChange: (v) => setAuditTaskModelField('timeoutMs', v) })),
              h('div', { className: 'ad-field', key: 'tm-cost-tier' },
                h('label', null, '成本档位'),
                h('select', {
                  className: 'ad-select',
                  'aria-label': '审读成本档位',
                  value: normalizeCostTier(audit.costTier),
                  onChange: (e) => setAuditTaskModelCostTier(e.target.value),
                  disabled: useDefault || !hostSupportsCostTier(),
                  title: hostSupportsCostTier()
                    ? '成本档位（fast/standard/strong；不可用时宿主回退并标记）'
                    : `当前宿主 v${(status && status.version) || '?'} 不支持成本档位：SKIP（不发送该字段）`,
                },
                  COST_TIER_OPTIONS.map(([value, label]) => h('option', { key: value || 'default', value }, label))),
                useDefault
                  ? h('span', { className: 'ad-sub' }, '未配置任务级模型时不保存档位')
                  : !hostSupportsCostTier()
                    ? h('span', { className: 'ad-sub' }, '旧宿主降级：SKIP（不发送 costTier）')
                    : h('span', { className: 'ad-sub' }, '不可用档位由宿主回退并标记')),
              costTierNotice ? h('div', { className: 'ad-doc-note', key: 'tm-cost-notice', role: 'status', style: { marginBottom: 6 } }, costTierNotice) : null,
              !useDefault
                ? h('div', { className: 'ad-row', key: 'tm-recent', style: { marginBottom: 8, flexWrap: 'wrap' } },
                    h('span', { className: 'ad-sub' }, '最近使用：'),
                    taskModelRecent.length
                      ? taskModelRecent.map((item, index) => h('button', {
                          className: 'ad-btn ad-sm',
                          key: `${item.provider}/${item.model}/${index}`,
                          title: '填入该模型配置',
                          onClick: () => applyRecentTaskModel(item),
                        }, `${item.provider ? item.provider + ' / ' : ''}${item.model}`))
                      : h('span', { className: 'ad-hint-next' }, '暂无记录（保存一次任务模型后自动记录，最多 8 条）'))
                : null,
              taskModelError ? h('div', { className: 'ad-err', style: { marginBottom: 6 }, role: 'alert' }, taskModelError) : null,
              h('div', { className: 'ad-path' }, '回退链：任务模型 → 默认模型 → 宿主默认（agentDefaultModel）。模型运行时不可用时宿主降级并标记，不阻断审读。其他任务键（review/outline/characters/episode/storyboard）已预留，v0.6.1 暂不渲染。Ctrl/⌘+S 保存当前页签或文档栏；Enter 执行搜索。'))),
          h('div', { className: 'ad-form-group', key: 'st-templates' },
            h('div', { className: 'ad-sec' }, `提示词模板（${PROMPT_TEMPLATE_KEYS.length} 个环节，留空 = 内置默认）`),
            h('div', { className: 'ad-settings-grid' },
              PROMPT_TEMPLATE_KEYS.map(([key, label]) =>
                h(TextField, {
                  key,
                  label,
                  rows: 2,
                  placeholder: `${label}环节的自定义提示词前缀（可选）`,
                  value: settings.promptTemplates[key] || '',
                  onChange: (v) => setSettings({ ...settings, promptTemplates: { ...settings.promptTemplates, [key]: v } }),
                })))),
        )
      }

      return h('div', { className: 'ad-settings-page', role: 'region', 'aria-label': 'AI 短剧设置' },
        h(Styles),
        options.embedded
          ? null
          : h('div', { className: 'ad-settings-head' },
              h('div', { className: 'ad-sec', style: { margin: 0 } }, 'AI 短剧设置'),
              h('div', { className: 'ad-sub' }, '默认契约 / 默认模型 / 任务模型 / 提示词模板 / 存储位置；设置保存在宿主 settings，列表页不再重复展示。')),
        flash ? h('div', { className: 'ad-flash', role: 'status', 'aria-live': 'polite' }, flash) : null,
        error ? h('div', { className: 'ad-err', role: 'alert' }, error) : null,
        body,
        h('details', { className: 'ad-form-group ad-settings-diag', key: 'st-diag' },
          h('summary', { className: 'ad-settings-diag-summary' }, '环境信息 / 诊断（只读）'),
          h('div', { className: 'ad-settings-diag-body' },
          h('div', { className: 'ad-hint-next', key: 'hint-diag' }, '技术自检，排障用；日常可忽略（只读）'),
            h('div', { className: 'ad-settings-diag-rows' },
            h('div', { className: 'ad-path' }, `数据源：${shortSourcePath(currentSourceCwd) || '（宿主默认源）'}`),
            h('div', { className: 'ad-path' }, `工作区：${(status && status.workspace) || '（未解析）'}（来源：${(status && status.workspaceSource) || '-'}）`),
            h('div', { className: 'ad-path' }, `数据目录：${(status && status.root) || '-'}${status && status.exists ? '' : '（尚未创建）'}`),
            h('div', { className: 'ad-path' }, `宿主版本：v${(status && status.version) || '?'}`)),
          h('div', { className: 'ad-row', style: { marginTop: 6, flexWrap: 'wrap' } },
            h('button', { className: 'ad-btn ad-sm', onClick: refreshStatus, disabled: loading }, icon('refresh'), '刷新诊断'),
            h('span', { className: 'ad-sub' }, '数据源切换仍在主面板列表页「数据源」选择器；新建短剧会按此处默认值预填契约。')),
          h('div', { className: 'ad-sec', style: { marginTop: 10 } }, '连通性 / 后端 / 模型目录 / Agent（手动刷新，只读）'),
          h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 8, marginTop: 4 } },
            h('button', { className: 'ad-btn ad-sm', onClick: pingDiagnostic, disabled: diagPingBusy || loading }, diagPingBusy ? '测试中…' : '连通性探测'),
            h('button', { className: 'ad-btn ad-sm', onClick: probeDiagnosticBackends, disabled: diagBackendsBusy || loading }, diagBackendsBusy ? '探测中…' : '探测后端'),
            h('button', { className: 'ad-btn ad-sm', onClick: loadDiagnosticAgents, disabled: diagAgentsBusy || loading }, diagAgentsBusy ? '读取中…' : 'Agent 挂载状态'),
            h('select', { className: 'ad-select', 'aria-label': '模型目录后端', value: diagCatalogBackend, onChange: (e) => setDiagCatalogBackend(e.target.value), disabled: diagCatalogBusy },
              h('option', { value: 'libtv' }, 'libtv'), h('option', { value: 'neowow' }, 'neowow')),
            h('select', { className: 'ad-select', 'aria-label': '模型目录类型', value: diagCatalogKind, onChange: (e) => setDiagCatalogKind(e.target.value), disabled: diagCatalogBusy },
              h('option', { value: 'image' }, '分镜图'), h('option', { value: 'video' }, '分镜视频'), h('option', { value: 'audio' }, '配音')),
            h('button', { className: 'ad-btn ad-sm', onClick: loadDiagnosticCatalog, disabled: diagCatalogBusy || loading }, diagCatalogBusy ? '读取中…' : '读取模型目录')),
          diagPing
            ? h('div', { className: 'ad-hits', key: 'diag-ping', role: 'status' },
                h('div', { className: 'ad-hit' },
                  h('div', { className: 'ad-hit-path' }, diagPing.ok ? '连通性：正常' : '连通性：失败'),
                  h('div', null, diagPing.ok
                    ? '宿主 ' + String(diagPing.name || '—') + ' v' + String(diagPing.version || '?') + ' · 客户端耗时 ' + String(diagPing.latencyMs) + 'ms（只读，无项目写入）'
                    : '失败：' + String(diagPing.error || '未知错误') + '（不阻塞其它诊断）')))
            : null,
          diagBackends
            ? h('div', { key: 'diag-backends' },
                h('div', { className: 'ad-hint-next' }, String(diagBackends.note || (diagBackends.degraded ? '后端降级' : ''))),
                (diagBackends.backends || []).length
                  ? h('div', { className: 'ad-hits' }, diagBackends.backends.map((item, i) => h('div', { className: 'ad-hit', key: i },
                      h('div', { className: 'ad-hit-path' }, String(item.label || item.id || '后端') + ' · 优先级 ' + String(item.priority == null ? '-' : item.priority) + ' · ' + (item.ok ? '可用' : '不可用')),
                      h('div', null, item.ok ? 'active=' + String(diagBackends.activeBackend === item.id) : String(item.detail || item.reason || '不可用')))))
                  : h('div', { className: 'ad-hint-next' }, '未获取到后端列表（后端注册表未就绪时不阻塞）'))
            : null,
          diagCatalog
            ? h('div', { key: 'diag-catalog' },
                h('div', { className: 'ad-hint-next' }, diagCatalog.ok === false
                  ? '模型目录不可用：' + String(diagCatalog.detail || diagCatalog.reason || '后端未提供目录') + '（不阻塞）'
                  : '模型目录：' + String(diagCatalog.backend || diagCatalogBackend) + ' / ' + String(diagCatalog.kind || diagCatalogKind) + ' · 共 ' + String(diagCatalog.count == null ? (diagCatalog.models || []).length : diagCatalog.count) + ' 个'),
                (diagCatalog.models || []).length
                  ? h('div', { className: 'ad-hits', style: { maxHeight: 140, overflow: 'auto' } }, (diagCatalog.models || []).slice(0, 8).map((model, i) => h('div', { className: 'ad-hit', key: i },
                      h('div', { className: 'ad-hit-path' }, String(model.modelName || model.model_name || model.modelKey || model.model || model.name || '模型 ' + (i + 1))),
                      h('div', null, String(model.pricingRule || model.points_cost_per_image || model.note || model.modelKey || '—').slice(0, 160)))))
                  : null)
            : null,
          diagAgents
            ? h('div', { key: 'diag-agents' },
                h('div', { className: 'ad-hint-next' }, diagAgents.ok === false
                  ? 'Agent 诊断不可用：' + String(diagAgents.detail || '未知错误') + '（不阻塞）'
                  : 'Agent 挂载：工具 ' + String((diagAgents.attach && diagAgents.attach.toolCount) || 0) + ' / 已挂载 ' + String(((diagAgents.attach && diagAgents.attach.attachedAgents) || []).length) + ' / 已见 ' + String(((diagAgents.attach && diagAgents.attach.seenAgents) || []).length) + (diagAgents.attach && diagAgents.attach.available === false ? '（宿主诊断不可用，降级只读）' : '')),
                diagAgents.preset ? h('div', { className: 'ad-path' }, '预设：' + String(diagAgents.preset.name || diagAgents.preset.id || '—') + ' · 工具白名单 ' + String((diagAgents.tools || []).length) + ' 个') : null)
            : null,
          )),
        options.embedded
          ? null
          : h('div', { className: 'ad-path' }, '也可从侧栏底部「设置」→「AI 短剧」打开此页；两处使用同一组件与同一 settings 数据。'),        settings
          ? h('div', { className: 'ad-settings-footer' },
              h('button', { className: 'ad-btn ad-primary', onClick: saveSettings, disabled: busy, 'aria-keyshortcuts': 'Control+S Meta+S' }, busy ? '保存中…' : '保存设置'),
              h('span', { className: 'ad-sub' }, '保存后主面板会在窗口重新获得焦点时自动刷新；快捷键：Ctrl/⌘+S 保存当前页签（契约/总纲/人物/世界观/剧本/分镜/本剧记忆）或文档栏，Enter 执行搜索。'),
              h('div', { style: { flex: 1 } }),
              closeHandler ? h('button', { className: 'ad-btn ad-sm', onClick: closeHandler }, '关闭') : null)
          : null,

      )
    }
    /* ================================================= v0.12.1（task-17）：会话内工具卡 */
    // tool.call.toolview K=1：只注册 drama_check_consistency 一个 wire 名（官方 inject+register 写法）。
    // props 契约（安装态 app.asar 内 ui-tool/renderer 源码实测）：
    //   owner = { callId, toolName, phase, block, cwd, home, openFile, inspect, useDisclosure, ... }
    //   slot 注入 hook toolCallArgumentsPartial → props.useToolCallArgumentsPartial（仅 preparing 有流式参数前缀）
    //   block：preparing { phase, callId, name } / start { phase, callId, name, argsRaw }
    //          / result { kind, callId, call:{name,argsRaw}|null, content:[{type:'text',text}], isError?, error?{name,code} }
    // 卡片纯只读展示（无写按钮、无 api() 调用）；全部解析 try/catch 防御，渲染不抛错（宿主 SlotErrorBoundary 仅兜底）。

    const TOOLVIEW_MAX_ISSUES = 8
    const TOOLVIEW_MAX_FINDINGS = 6
    const TOOLVIEW_TEXT_MAX = 200

    function toolviewCut(value, max = TOOLVIEW_TEXT_MAX) {
      const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
      return text.length > max ? text.slice(0, max) + '…' : text
    }

    function toolviewJson(raw) {
      if (typeof raw !== 'string' || !raw) return null
      try {
        const value = JSON.parse(raw)
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null
      } catch {
        return null
      }
    }

    // preparing 阶段参数是流式前缀（可能不是合法 JSON）：只做安全字段抽取，不做结构猜测
    function toolviewPartialArgs(raw) {
      const text = typeof raw === 'string' ? raw : ''
      if (!text) return null
      const parsed = toolviewJson(text)
      if (parsed) return parsed
      const out = {}
      const title = /"title"\s*:\s*"([^"]*)/.exec(text)
      if (title) out.title = title[1]
      const deep = /"deep"\s*:\s*(true|false)/.exec(text)
      if (deep) out.deep = deep[1] === 'true'
      const episode = /"episode"\s*:\s*(\d+)/.exec(text)
      if (episode) out.episode = Number(episode[1])
      const maxTokens = /"maxTokens"\s*:\s*(\d+)/.exec(text)
      if (maxTokens) out.maxTokens = Number(maxTokens[1])
      return Object.keys(out).length ? out : null
    }

    function toolviewResultText(block) {
      try {
        const parts = []
        const content = block && Array.isArray(block.content) ? block.content : []
        for (const part of content) {
          if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
          else if (part && typeof part === 'object') {
            try {
              parts.push(JSON.stringify(part))
            } catch {
              /* 跳过不可序列化内容块 */
            }
          }
        }
        if (!parts.length && block && block.error) {
          parts.push([block.error.name, block.error.code].filter(Boolean).join(': '))
        }
        return parts.join('\n')
      } catch {
        return ''
      }
    }

    // 解析我们工具 render 出的文本（lib/tools.js · drama_check_consistency）：
    //  一致性检查：error N / warn N / info N（共 N 项）
    //  · [severity] 说明（定位）                       → 确定性问题
    //  AI 审读：{mode} / {state}（原因：...） / 结论：... → AI 审读段
    //  · [severity] dimension @定位：证据 → 建议        → 审读 finding
    //  已保存审读报告：第 N 集（路径） / 报告已落盘：路径 / 下一步：...
    function toolviewParseCheck(text) {
      const model = { summary: null, issues: [], findings: [], noIssues: false, deep: null, conclusion: [], saved: null, savedPath: '', next: '', others: [] }
      try {
        const lines = String(text || '').split('\n')
        for (const rawLine of lines) {
          const line = String(rawLine || '').trim()
          if (!line) continue
          const summary = /^一致性检查：error (\d+) \/ warn (\d+) \/ info (\d+)（共 (\d+) 项）$/.exec(line)
          if (summary) {
            model.summary = { error: Number(summary[1]), warn: Number(summary[2]), info: Number(summary[3]), total: Number(summary[4]) }
            continue
          }
          if (line === '未发现问题 ✓' || line === '未发现问题') {
            model.noIssues = true
            continue
          }
          const deepMode = /^AI 审读：(.*?) \/ (.*?)(?:（原因：(.*?)）)?$/.exec(line)
          if (deepMode) {
            model.deep = { mode: deepMode[1], state: deepMode[2], reason: deepMode[3] || '' }
            continue
          }
          const saved = /^已保存审读报告：第 (\d+) 集（(.*?)）$/.exec(line)
          if (saved) {
            model.saved = { episode: Number(saved[1]), path: saved[2] || '' }
            continue
          }
          const savedPath = /^报告已落盘：(.*)$/.exec(line)
          if (savedPath) {
            model.savedPath = savedPath[1] || ''
            continue
          }
          const nextLine = /^下一步：(.*)$/.exec(line)
          if (nextLine) {
            model.next = nextLine[1] || ''
            continue
          }
          const conclusion = /^结论：(.*)$/.exec(line)
          if (conclusion) {
            model.conclusion.push(conclusion[1] || '')
            continue
          }
          const finding = /^· \[([a-z]+)\] (.+?) @(.+?)：(.+?) → (.+)$/.exec(line)
          if (finding) {
            model.findings.push({
              severity: finding[1],
              dimension: finding[2],
              location: finding[3],
              evidence: finding[4],
              suggestion: finding[5],
            })
            continue
          }
          const issue = /^· \[([a-z]+)\] ([\s\S]*)$/.exec(line)
          if (issue) {
            let rest = issue[2] || ''
            let where = ''
            if (rest.endsWith('）')) {
              const at = rest.lastIndexOf('（')
              if (at > 0) {
                where = rest.slice(at + 1, -1)
                rest = rest.slice(0, at)
              }
            }
            model.issues.push({ severity: issue[1], message: rest, where })
            continue
          }
          model.others.push(line)
        }
      } catch {
        /* 解析失败 → 上层回退原文摘要 */
      }
      return model
    }

    function toolviewSeverityChip(severity) {
      const key = severity === 'error' || severity === 'warn' ? severity : 'info'
      return h('span', { className: 'ad-toolview-sev', 'data-tone': key, key: 'sev-' + key }, key)
    }

    function toolviewArgsLine(args) {
      if (!args) return null
      const parts = []
      if (args.title) parts.push(`项目：${toolviewCut(args.title, 60)}`)
      if (args.deep === true) parts.push('AI 审读：开')
      if (args.episode != null) parts.push(`第 ${args.episode} 集`)
      if (args.maxTokens != null) parts.push(`预算 ${args.maxTokens} tokens`)
      if (args.timeoutMs != null) parts.push(`超时 ${args.timeoutMs}ms`)
      return parts.length ? h('div', { className: 'ad-toolview-args', key: 'args' }, parts.join(' · ')) : null
    }

    function renderDramaCheckCard(owner, partialRaw) {
      const block = owner.block && typeof owner.block === 'object' ? owner.block : {}
      const resultPhase = Object.prototype.hasOwnProperty.call(block, 'kind')
      const phase = resultPhase ? 'result' : (block.phase === 'preparing' || owner.phase === 'preparing' ? 'preparing' : 'start')
      const argsRaw = phase === 'result'
        ? (block.call && typeof block.call.argsRaw === 'string' ? block.call.argsRaw : '')
        : (typeof block.argsRaw === 'string' ? block.argsRaw : '')
      const args = phase === 'preparing' ? toolviewPartialArgs(partialRaw || argsRaw) : toolviewJson(argsRaw)
      const isError = phase === 'result' && Boolean(block.isError)
      const interrupted = phase === 'result' && Boolean(block.error && block.error.code === 'interrupted')
      const state = phase === 'preparing' ? 'preparing' : phase === 'start' ? 'running' : isError ? (interrupted ? 'stopped' : 'error') : 'ok'
      const stateLabel = state === 'preparing' ? '准备参数' : state === 'running' ? '检查中…' : state === 'stopped' ? '已停止' : state === 'error' ? '失败' : '已完成'
      const children = [
        h('div', { className: 'ad-toolview-head', key: 'head' },
          h('span', { className: 'ad-toolview-title' }, '一致性检查'),
          h('span', { className: 'ad-toolview-badge', 'data-state': state }, stateLabel),
          h('span', { className: 'ad-toolview-tool', title: 'wire tool' }, 'drama_check_consistency')),
        toolviewArgsLine(args),
      ]
      if (phase === 'preparing') {
        children.push(h('div', { className: 'ad-toolview-hint', key: 'prep' }, args ? '等待参数发送…' : '准备参数…'))
      } else if (phase === 'start') {
        children.push(h('div', { className: 'ad-toolview-hint', key: 'run' }, '检查中…（确定性检查 + 可选 AI 审读，完成后显示结果）'))
      } else if (isError) {
        const errorText = toolviewResultText(block) || [block.error && block.error.name, block.error && block.error.code].filter(Boolean).join(': ')
        children.push(h('div', { className: 'ad-toolview-error', key: 'err' },
          h('div', { className: 'ad-toolview-error-title' }, interrupted ? '检查已中断' : '检查失败'),
          h('div', { className: 'ad-toolview-error-body' }, toolviewCut(errorText || '（无错误详情）', 400))))
      } else {
        let text = ''
        try {
          text = toolviewResultText(block)
        } catch {
          text = ''
        }
        let model = null
        try {
          model = toolviewParseCheck(text)
        } catch {
          model = null
        }
        const parsed = Boolean(model && (model.summary || model.issues.length || model.findings.length || model.noIssues || model.deep || model.saved))
        if (!parsed || !text) {
          children.push(h('div', { className: 'ad-toolview-fallback', key: 'raw' },
            h('div', { className: 'ad-toolview-hint' }, '结果解析回退（原文摘要）'),
            h('div', { className: 'ad-toolview-pre' }, toolviewCut(text || '（无结果文本）', 400))))
        } else {
          if (model.summary) {
            children.push(h('div', { className: 'ad-toolview-summary', key: 'sum' },
              h('span', { className: 'ad-toolview-chip', 'data-tone': 'error', key: 'e' }, `error ${model.summary.error}`),
              h('span', { className: 'ad-toolview-chip', 'data-tone': 'warn', key: 'w' }, `warn ${model.summary.warn}`),
              h('span', { className: 'ad-toolview-chip', 'data-tone': 'info', key: 'i' }, `info ${model.summary.info}`),
              h('span', { className: 'ad-toolview-chip', 'data-tone': 'total', key: 't' }, `共 ${model.summary.total} 项`)))
          }
          if (model.noIssues) children.push(h('div', { className: 'ad-toolview-ok', key: 'ok' }, '未发现问题 ✓'))
          if (model.issues.length) {
            children.push(h('div', { className: 'ad-toolview-list', key: 'issues' },
              model.issues.slice(0, TOOLVIEW_MAX_ISSUES).map((issue, index) => h('div', { className: 'ad-toolview-issue', key: 'issue-' + index },
                toolviewSeverityChip(issue.severity),
                h('span', { className: 'ad-toolview-issue-msg', key: 'msg' }, toolviewCut(issue.message, TOOLVIEW_TEXT_MAX)),
                issue.where ? h('span', { className: 'ad-toolview-where', key: 'where' }, `定位：${toolviewCut(issue.where, 80)}`) : null)),
              model.issues.length > TOOLVIEW_MAX_ISSUES
                ? h('div', { className: 'ad-toolview-hint', key: 'more-issues' }, `…共 ${model.issues.length} 项；完整清单见面板「检查」页`)
                : null))
          }
          if (model.deep || model.conclusion.length || model.findings.length) {
            children.push(h('div', { className: 'ad-toolview-deep', key: 'deep' },
              h('div', { className: 'ad-toolview-sub', key: 'sub' }, 'AI 审读',
                model.deep
                  ? h('span', { className: 'ad-toolview-badge', 'data-state': model.deep.state.indexOf('降级') >= 0 ? 'error' : 'ok', style: { marginLeft: 6 }, key: 'deep-badge' }, `${model.deep.mode} / ${model.deep.state}`)
                  : null),
              model.deep && model.deep.reason
                ? h('div', { className: 'ad-toolview-hint', key: 'reason' }, `降级原因：${toolviewCut(model.deep.reason, 120)}（不阻断定稿 / 导出）`)
                : null,
              model.conclusion.length
                ? h('div', { className: 'ad-toolview-conclusion', key: 'conclusion' }, `结论：${toolviewCut(model.conclusion[model.conclusion.length - 1], TOOLVIEW_TEXT_MAX)}`)
                : null,
              model.findings.slice(0, TOOLVIEW_MAX_FINDINGS).map((finding, index) => h('div', { className: 'ad-toolview-finding', key: 'finding-' + index },
                h('div', { className: 'ad-toolview-finding-head', key: 'head' },
                  toolviewSeverityChip(finding.severity),
                  h('span', { className: 'ad-toolview-dim', key: 'dim' }, `${toolviewCut(finding.dimension, 40)} @${toolviewCut(finding.location, 40)}`)),
                h('div', { className: 'ad-toolview-evidence', key: 'ev' }, `证据：${toolviewCut(finding.evidence, TOOLVIEW_TEXT_MAX)}`),
                h('div', { className: 'ad-toolview-suggestion', key: 'sg' }, `建议：${toolviewCut(finding.suggestion, TOOLVIEW_TEXT_MAX)}`))),
              model.findings.length > TOOLVIEW_MAX_FINDINGS
                ? h('div', { className: 'ad-toolview-hint', key: 'more-findings' }, `…共 ${model.findings.length} 条；完整清单见面板「检查」页 / .aidrama/reviews/latest.json`)
                : null))
          }
          if (model.saved) children.push(h('div', { className: 'ad-toolview-hint', key: 'saved' }, `已保存审读报告：第 ${model.saved.episode} 集${model.saved.path ? `（${toolviewCut(model.saved.path, 120)}）` : ''}`))
          if (model.savedPath) children.push(h('div', { className: 'ad-toolview-hint', key: 'path' }, `报告已落盘：${toolviewCut(model.savedPath, 160)}`))
          if (model.next) children.push(h('div', { className: 'ad-toolview-next', key: 'next' }, `下一步：${toolviewCut(model.next, 200)}`))
        }
        children.push(h('div', { className: 'ad-toolview-foot', key: 'foot' }, '只读卡片：裁决（采纳 / 忽略 / 标误报）请在面板「检查」页操作；完整报告见 .aidrama/reviews/latest.json。'))
      }
      return h('div', { className: 'ad-toolview', 'data-toolview': 'drama_check_consistency', 'data-state': state }, children)
    }

    function DramaCheckToolCard(props) {
      const owner = props && typeof props === 'object' ? props : {}
      // 框架 slot 注入 hook：仅 preparing 阶段有 assistant 源（dispatched 调用返回 ""）
      let partialRaw = ''
      if (typeof owner.useToolCallArgumentsPartial === 'function') {
        try {
          partialRaw = owner.useToolCallArgumentsPartial()
        } catch {
          partialRaw = ''
        }
      }
      if (partialRaw != null && typeof partialRaw !== 'string') partialRaw = ''
      try {
        return renderDramaCheckCard(owner, partialRaw)
      } catch (error) {
        // 双保险：宿主 SlotErrorBoundary 之前也不抛错，降级为纯文本
        return h('div', { className: 'ad-toolview', 'data-toolview': 'drama_check_consistency', 'data-state': 'error' },
          h('div', { className: 'ad-toolview-error-title' }, '一致性检查结果渲染失败（已降级为纯文本）'),
          h('div', { className: 'ad-toolview-error-body' }, toolviewCut(error && error.message ? error.message : String(error), 300)))
      }
    }

    /* v0.12.4（task-24 / M5-A）：对话框焦点陷阱（防御式；无 DOM / 容器缺失时 no-op；cleanup 恢复原焦点） */
    function installDialogFocusTrap(containerId) {
      const noop = () => {}
      if (typeof document === 'undefined' || !document || typeof window === 'undefined' || !window) return noop
      let container = null
      try {
        container = typeof document.getElementById === 'function' ? document.getElementById(containerId) : null
      } catch {
        container = null
      }
      if (!container || typeof container.querySelectorAll !== 'function') return noop
      const previous = document.activeElement && typeof document.activeElement.focus === 'function' ? document.activeElement : null
      const focusables = () => {
        try {
          return Array.prototype.slice
            .call(container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
            .filter((el) => el && !el.disabled && (typeof el.tabIndex !== 'number' || el.tabIndex >= 0))
        } catch {
          return []
        }
      }
      const initial = focusables()
      if (initial.length && typeof initial[0].focus === 'function') {
        try {
          initial[0].focus()
        } catch {
          /* 初始焦点失败不影响对话框可用性 */
        }
      } else if (typeof container.focus === 'function') {
        try {
          container.focus()
        } catch {
          /* 同上 */
        }
      }
      const onKeyDown = (event) => {
        if (!event || event.key !== 'Tab') return
        const list = focusables()
        if (!list.length) return
        const first = list[0]
        const last = list[list.length - 1]
        const active = document.activeElement
        const inside = typeof container.contains === 'function' ? container.contains(active) : Boolean(active)
        if (event.shiftKey) {
          if (active === first || !inside) {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            if (last && typeof last.focus === 'function') last.focus()
          }
        } else if (active === last || !inside) {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          if (first && typeof first.focus === 'function') first.focus()
        }
      }
      window.addEventListener('keydown', onKeyDown)
      return () => {
        window.removeEventListener('keydown', onKeyDown)
        if (previous && typeof previous.focus === 'function') {
          try {
            previous.focus()
          } catch {
            /* 原焦点元素已不在 DOM 时安全跳过 */
          }
        }
      }
    }

    /* -------------------------------------------------------------- 主面板 */

    function DramaPanel(props) {
      const slotProps = props || {}
      // 根席位标准套件：useWorkspaces 由 ui-workspace 插件通过 slots.provideRoot 提供；
      // 无该 hook 的环境（测试/极旧壳）降级为普通函数，保证 A 阶段「旧宿主降级」路径可用。
      const useWorkspacesHook = typeof slotProps.useWorkspaces === 'function' ? slotProps.useWorkspaces : () => null
      const workspaceSnapshot = useWorkspacesHook((snapshot) => snapshot)
      const workspaceItems = workspaceSnapshot && Array.isArray(workspaceSnapshot.items) ? workspaceSnapshot.items : []
      const [phase, setPhase] = React.useState('loading')
      const [error, setError] = React.useState('')
      const [status, setStatus] = React.useState(null)
      const [projects, setProjects] = React.useState([])
      const [draftTitle, setDraftTitle] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [flash, setFlash] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [hits, setHits] = React.useState(null)

      const [openTitle, setOpenTitle] = React.useState('')
      const [tab, setTab] = React.useState('outline')
      const [tree, setTree] = React.useState(null)
      // v0.15.8（task-126 / EXT-C1）：素材登记仅项目内 —— 当前项目根（from tree.path）+ 登记区错误提示
      const [projectRoot, setProjectRoot] = React.useState('')
      const [assetAddError, setAssetAddError] = React.useState('')
      const [contract, setContract] = React.useState(null)
      const [rows, setRows] = React.useState([])
      const [characters, setCharacters] = React.useState([])
      const [episodes, setEpisodes] = React.useState([])
      const [episodeOrder, setEpisodeOrder] = React.useState(1)
      const [episodeText, setEpisodeText] = React.useState('')
      const [shots, setShots] = React.useState([])
      const [draftList, setDraftList] = React.useState([])
      const [report, setReport] = React.useState(null)
      const [exported, setExported] = React.useState([])
      const [memory, setMemory] = React.useState([])
      const [world, setWorld] = React.useState([])
      // v0.16.0 A-C1：progress 仅 openProject 内部只读保留（进度 UI 已移除，不再渲染任何进度语义）
      const [progress, setProgress] = React.useState(null)
      const [collapsed, setCollapsed] = React.useState({})
      const [settings, setSettings] = React.useState(null)
      const [shared, setShared] = React.useState(null)
      const [sharedText, setSharedText] = React.useState('')
      const [sharedPath, setSharedPath] = React.useState('')
      const [dialogue, setDialogue] = React.useState(null)
      // v0.15.2（task-112）：剧本页「正文 | 台词」视图 + 台词筛选 + legacy dialogue 重定向提示
      const [episodeView, setEpisodeView] = React.useState('text') // text | dialogue
      const [dialogueEpisodeFilter, setDialogueEpisodeFilter] = React.useState('all')
      const [dialogueCharacterFilter, setDialogueCharacterFilter] = React.useState('all')
      const [dialogueRedirectNotice, setDialogueRedirectNotice] = React.useState(false)
      const [assets, setAssets] = React.useState([])
      const [assetSource, setAssetSource] = React.useState('')
      const [assetShots, setAssetShots] = React.useState('')
      // v0.15.1（task-108 / B2S-C）：素材库分类 + 图片可见（只读）UI 态
      const [assetCards, setAssetCards] = React.useState([])
      const [assetTypeFilter, setAssetTypeFilter] = React.useState('全部')
      const [assetQuery, setAssetQuery] = React.useState('')
      const [assetSelectedId, setAssetSelectedId] = React.useState(null)
      const [assetImageIndex, setAssetImageIndex] = React.useState(0)
      // 项目相对路径图片缓存：path → { status:'loading'|'ok'|'error', dataUrl? }；http 图不走缓存
      const [assetImageCache, setAssetImageCache] = React.useState({})
      const [assetBrokenImages, setAssetBrokenImages] = React.useState({})
      // v0.15.2（task-112）：角色卡音色参考试听（media.audio 数组；默认 audio[0]，可切换）
      const [assetAudioIndex, setAssetAudioIndex] = React.useState(0)
      const [assetBrokenAudios, setAssetBrokenAudios] = React.useState({})
      // v0.15.3（task-115 / VB-C）：素材库内「卡片视图 | 视觉圣经」只读专区
      const [visualStyle, setVisualStyle] = React.useState(null)
      const [visualScenes, setVisualScenes] = React.useState([])
      const [assetView, setAssetView] = React.useState('cards') // cards | visual
      const [visualType, setVisualType] = React.useState('all')
      const [visualQuery, setVisualQuery] = React.useState('')
      const [visualSort, setVisualSort] = React.useState('id-asc')
      // v0.16.4（task-141 / C1-C）：图墙分组折叠（仅控制组内 DOM，不影响筛选）
      const [visualGroupCollapsed, setVisualGroupCollapsed] = React.useState({})
      const [visualLightbox, setVisualLightbox] = React.useState(null)
      const [visualAudioIndex, setVisualAudioIndex] = React.useState({})
      // v0.16.6（C2-C / E15+H-7）：视觉圣经风格定向/冻结状态（style-save 唯一写入口）
      const [styleDirection, setStyleDirection] = React.useState(null)
      const [styleDraft, setStyleDraft] = React.useState(styleDraftOf(null))
      const [styleBusy, setStyleBusy] = React.useState(false)
      const [styleNotice, setStyleNotice] = React.useState('')
      const [styleError, setStyleError] = React.useState('')
      const [styleDialog, setStyleDialog] = React.useState(null)
      const [styleReason, setStyleReason] = React.useState('')
      const [styleReasonError, setStyleReasonError] = React.useState('')
      // v0.16.9（C3-C / E16+H-8）：资产/场景卡审核工作台 UI 态（asset-save 唯一写入口）
      const [assetReviewKind, setAssetReviewKind] = React.useState('asset') // asset | scene
      const [assetReviewStatusFilter, setAssetReviewStatusFilter] = React.useState('all')
      const [assetReviewTypeFilter, setAssetReviewTypeFilter] = React.useState('全部')
      const [assetReviewQuery, setAssetReviewQuery] = React.useState('')
      const [assetReviewSelectedId, setAssetReviewSelectedId] = React.useState('')
      const [assetReviewPrompt, setAssetReviewPrompt] = React.useState('')
      const [assetReviewPromptError, setAssetReviewPromptError] = React.useState('')
      const [assetReviewReason, setAssetReviewReason] = React.useState('')
      const [assetReviewReasonError, setAssetReviewReasonError] = React.useState('')
      const [assetReviewDialog, setAssetReviewDialog] = React.useState(null) // { type:'reject'|'finalize'|'reopen' } | null
      const [assetReviewError, setAssetReviewError] = React.useState('')
      const [assetReviewNotice, setAssetReviewNotice] = React.useState('')
      const [assetReviewBusy, setAssetReviewBusy] = React.useState(false)
      const [assetReviewHashes, setAssetReviewHashes] = React.useState({ asset: '', scene: '' })
      // v0.15.4（task-119 / M20-C）：素材库 2.0 · legacy 登记统一卡片视图
      const [legacyImageCache, setLegacyImageCache] = React.useState({})
      const [legacyKindFilter, setLegacyKindFilter] = React.useState('all')
      const [legacyQuery, setLegacyQuery] = React.useState('')
      const [legacySort, setLegacySort] = React.useState('name-asc')
      const [assetRegistrationOpen, setAssetRegistrationOpen] = React.useState(false)
      // v0.15.9（task-129 / D2C-C）：扫描素材目录 + 批量登记（不移动文件；复用 assets-get 加参 + assets-add）
      const [scanSupported, setScanSupported] = React.useState(null) // null=未探测 | true=支持 | false=旧宿主
      const [scanOpen, setScanOpen] = React.useState(false)
      const [scanFiles, setScanFiles] = React.useState([])
      const [scanTotal, setScanTotal] = React.useState(0)
      const [scanTruncated, setScanTruncated] = React.useState(false)
      const [scanKindFilter, setScanKindFilter] = React.useState('all')
      const [scanSelected, setScanSelected] = React.useState({})
      const [scanBatchBusy, setScanBatchBusy] = React.useState(false)
      const [scanProgress, setScanProgress] = React.useState({ done: 0, total: 0 })
      const [scanSummary, setScanSummary] = React.useState(null)
      // v0.15.11（task-135 / IMP-C）：一键导入（file input/拖拽 → assets-import；仅 host version≥0.15.11 显示）
      const [importSupported, setImportSupported] = React.useState(null) // null=未知 | true | false
      // v0.16.10（M3-C）：registry 损坏提示/修复 + ledger 显式渲染（host≥M3）
      const [registrySupported, setRegistrySupported] = React.useState(null) // null=未探测 | true=字段存在 | false=旧宿主
      const [registryOk, setRegistryOk] = React.useState(true)
      const [registryBusy, setRegistryBusy] = React.useState(false)
      const [registryNotice, setRegistryNotice] = React.useState('')
      const [registryError, setRegistryError] = React.useState('')
      const [m3Supported, setM3Supported] = React.useState(null) // ledger renderFile/修复能力（版本门禁）
      const [ledgerRendered, setLedgerRendered] = React.useState(false)
      const [importOpen, setImportOpen] = React.useState(false)
      const [importQueue, setImportQueue] = React.useState([])
      const [importCategory, setImportCategory] = React.useState('')
      const [importBusy, setImportBusy] = React.useState(false)
      const [importProgress, setImportProgress] = React.useState({ done: 0, total: 0 })
      const [importSummary, setImportSummary] = React.useState(null)
      // v0.16.x（C2-C 原型）：跨项目资产复用（只读源项目 → assets-import add-only；无新方法/调用点）
      const [crossSupported, setCrossSupported] = React.useState(null) // null=未知 | true | false
      const [crossOpen, setCrossOpen] = React.useState(false)
      const [crossSourceTitle, setCrossSourceTitle] = React.useState('')
      const [crossAssets, setCrossAssets] = React.useState([])
      const [crossLoading, setCrossLoading] = React.useState(false)
      const [crossLoadError, setCrossLoadError] = React.useState('')
      const [crossQuery, setCrossQuery] = React.useState('')
      const [crossSelected, setCrossSelected] = React.useState({})
      const [crossCategory, setCrossCategory] = React.useState('')
      const [crossBusy, setCrossBusy] = React.useState(false)
      const [crossSummary, setCrossSummary] = React.useState(null)
      // v0.16.8（I5-1-C）：跨项目对象导入 tabs（素材/资产卡/场景卡/风格 DNA；host≥0.16.8）
      const [crossObjectsSupported, setCrossObjectsSupported] = React.useState(null) // null=未知 | true | false
      const [crossTab, setCrossTab] = React.useState('assets')
      const [crossCards, setCrossCards] = React.useState([])
      const [crossScenes, setCrossScenes] = React.useState([])
      const [crossStyle, setCrossStyle] = React.useState(null)
      const [crossCardSelected, setCrossCardSelected] = React.useState({})
      const [crossSceneSelected, setCrossSceneSelected] = React.useState({})
      const [crossCopyStyleDNA, setCrossCopyStyleDNA] = React.useState(false)
      const [crossCopyMedia, setCrossCopyMedia] = React.useState(true)
      const [crossAllowNewIdSuffix, setCrossAllowNewIdSuffix] = React.useState(false)
      const [crossOverwriteStyle, setCrossOverwriteStyle] = React.useState(false)
      const [crossWarnings, setCrossWarnings] = React.useState([])


      // v0.15.5（task-121）：lightbox 关闭热修 —— 统一关闭函数 + Esc/背景/焦点/滚动锁（三方式关闭）
      const closeVisualLightbox = () => setVisualLightbox(null)
      React.useEffect(() => {
        if (!visualLightbox) return undefined
        const doc = typeof document === 'undefined' ? null : document
        const overlay = doc && typeof doc.querySelector === 'function' ? doc.querySelector('[data-lightbox-overlay]') : null
        const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        const listFocusables = () => {
          if (!overlay || typeof overlay.querySelectorAll !== 'function') return []
          return Array.prototype.slice.call(overlay.querySelectorAll(focusableSelector)).filter((el) => !el.disabled)
        }
        if (!lightboxTriggerEl && doc && doc.activeElement) lightboxTriggerEl = doc.activeElement
        const onKeyDown = (event) => {
          if (event.key === 'Escape' || event.key === 'Esc') {
            event.preventDefault()
            event.stopPropagation()
            setVisualLightbox(null)
            return
          }
          if (event.key !== 'Tab') return
          const items = listFocusables()
          if (!items.length) return
          const first = items[0]
          const last = items[items.length - 1]
          const active = doc ? doc.activeElement : null
          if (items.indexOf(active) < 0) { event.preventDefault(); first.focus(); return }
          if (event.shiftKey && active === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
        }
        if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('keydown', onKeyDown, true)
        const closeBtn = overlay && typeof overlay.querySelector === 'function' ? overlay.querySelector('[data-lightbox-close]') : null
        if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus()
        if (doc && doc.body) {
          lightboxPrevBodyOverflow = doc.body.style.overflow
          document.body.style.overflow = 'hidden'
        }
        return () => {
          if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', onKeyDown, true)
          if (doc && doc.body) document.body.style.overflow = lightboxPrevBodyOverflow
          const trigger = lightboxTriggerEl
          lightboxTriggerEl = null
          if (trigger && trigger.isConnected !== false && typeof trigger.focus === 'function') {
            try { trigger.focus() } catch { /* 触发元素可能已卸载 */ }
          }
        }
      }, [visualLightbox])
      const visualLightboxNode = visualLightbox
        ? h('div', {
            className: 'ad-visual-lightbox',
            key: 'visual-lightbox',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '大图预览',
            'data-lightbox-overlay': 'true',
            onClick: (event) => {
              // 背景点击关闭（target === currentTarget）；图片/按钮点击不误关
              if (event && event.target === event.currentTarget) closeVisualLightbox()
            },
          },
            h('button', {
              type: 'button',
              className: 'ad-btn ad-sm ad-visual-lightbox-close',
              'aria-label': '关闭大图预览',
              'data-lightbox-close': 'true',
              onClick: (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault()
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                closeVisualLightbox()
              },
            }, '关闭（Esc）'),
            h('div', { className: 'ad-visual-lightbox-hint', 'aria-hidden': 'true' }, '点击背景或按 Esc 关闭'),
            h('img', {
              className: 'ad-visual-lightbox-img',
              src: visualLightbox.src,
              alt: visualLightbox.alt || '大图预览',
              loading: 'lazy',
              onClick: (event) => { if (event && typeof event.stopPropagation === 'function') event.stopPropagation() },
            }))
        : null
      const [finalized, setFinalized] = React.useState([])
      const [ledger, setLedger] = React.useState(null)
      const [genBackends, setGenBackends] = React.useState(null)
      const [genCanvas, setGenCanvas] = React.useState(null)
      const [genBudget, setGenBudget] = React.useState(null)
      const [genTasks, setGenTasks] = React.useState([])
      const [genPlan, setGenPlan] = React.useState(null)
      const [genKind, setGenKind] = React.useState('image')
      const [genModel, setGenModel] = React.useState('')
      const [genLimit, setGenLimit] = React.useState('')
      // v0.12.2（task-20 / M4 批1）：5 条既有路由面板接线状态（均用户显式点击才调用，不自动加载）
      const [genEstimate, setGenEstimate] = React.useState(null)
      const [genEstimateBusy, setGenEstimateBusy] = React.useState(false)
      const [genSearchQuery, setGenSearchQuery] = React.useState('')
      const [genSearchTopK, setGenSearchTopK] = React.useState('5')
      const [genSearchResult, setGenSearchResult] = React.useState(null)
      const [genSearchBusy, setGenSearchBusy] = React.useState(false)
      const [reconcileResult, setReconcileResult] = React.useState(null)
      const [reconcileBusy, setReconcileBusy] = React.useState(false)
      const [taskRecordBusy, setTaskRecordBusy] = React.useState(false)
      const [taskRecordPrompt, setTaskRecordPrompt] = React.useState('')
      const [taskRecordBackend, setTaskRecordBackend] = React.useState('libtv')
      const [taskStatusDraft, setTaskStatusDraft] = React.useState({})
      const [taskNotice, setTaskNotice] = React.useState('')
      // v0.12.3（task-21 / M4 批2）：产物入库（intake-artifact；仅点击时写 素材/生成 + 素材清单 + assets.json）
      const [artifactSource, setArtifactSource] = React.useState('')
      const [artifactKind, setArtifactKind] = React.useState('image')
      const [artifactName, setArtifactName] = React.useState('')
      const [artifactBusy, setArtifactBusy] = React.useState(false)
      const [artifactResult, setArtifactResult] = React.useState(null)
      // v0.16.1（task-139 / C-6）：产物入库本地文件模式（选择文件 → assets-import）与导入分类
      const [artifactFile, setArtifactFile] = React.useState(null)
      const [artifactFileName, setArtifactFileName] = React.useState('')
      const [artifactFileSize, setArtifactFileSize] = React.useState(0)
      const [artifactCategory, setArtifactCategory] = React.useState(ARTIFACT_CATEGORY_DEFAULT)
      const [importText, setImportText] = React.useState('')
      const [importPreview, setImportPreview] = React.useState(null)
      const [showImport, setShowImport] = React.useState(false)
      // v0.12.0（task-7）：窄窗页签「更多 ▾」菜单展开态
      const [tabsMoreOpen, setTabsMoreOpen] = React.useState(false)
      // v0.12.1（task-8）：项目页「设置」入口的面板内设置浮层开关
      const [settingsOverlay, setSettingsOverlay] = React.useState(false)
      // v0.14.0（task-38 / M6-1）：交给 Agent（C 路径：生成交接指令 + 复制）状态
      const [handoffOpen, setHandoffOpen] = React.useState(false)
      const [handoffBusy, setHandoffBusy] = React.useState(false)
      const [handoffInstr, setHandoffInstr] = React.useState('')
      const [handoffCopied, setHandoffCopied] = React.useState(false)
      const [handoffCopyError, setHandoffCopyError] = React.useState('')
      // P1：宿主能力门控（status.version >= 0.4.0 才启用 H-1/H-2/H-3 新交互）
      const [hostFlags, setHostFlags] = React.useState({ p1: false })
      // P1：未保存标记（v0.11.5/task-4：扩展至 7 个可保存页签 —— 契约/总纲/人物/世界观/剧本/分镜/本剧记忆）
      const [dirty, setDirty] = React.useState({ contract: false, outline: false, characters: false, world: false, memory: false, episode: false, storyboard: false })
      // P1（C-1）：草稿多选与「含已处理」视图
      const [draftSelection, setDraftSelection] = React.useState({})
      const [draftIncludeResolved, setDraftIncludeResolved] = React.useState(false)
      // T7（E1）：面板内右栏文档编辑器（不新增 slot）状态机 loading→clean⇄dirty→saving→saved + conflict
      const [docOpen, setDocOpen] = React.useState(false)
      const [docPath, setDocPath] = React.useState('')
      const [docText, setDocText] = React.useState('')
      const [docHash, setDocHash] = React.useState('')
      const [docUpdatedAt, setDocUpdatedAt] = React.useState('')
      const [docDirty, setDocDirty] = React.useState(false)
      const [docBusy, setDocBusy] = React.useState(false)
      const [docNotice, setDocNotice] = React.useState('')
      const [docError, setDocError] = React.useState('')
      const [docUnavailable, setDocUnavailable] = React.useState(false)
      const [docConflict, setDocConflict] = React.useState(null)
      const [docNotifyState, setDocNotifyState] = React.useState('idle')
      const [docSelection, setDocSelection] = React.useState('')
      // P2-1 多数据源：sources = 宿主 sources-list（E5）或降级 A 的工作区枚举
      const [sourcePath, setSourcePath] = React.useState(() => {
        const saved = readSavedSource()
        if (saved && !currentSourceCwd) currentSourceCwd = saved
        return saved
      })
      const [sources, setSources] = React.useState([])
      const [sourcesMode, setSourcesMode] = React.useState('loading') // loading | host | legacy
      const [sourcesDegraded, setSourcesDegraded] = React.useState(false)
      const [sourceBusy, setSourceBusy] = React.useState(false)
      // P2-8：错误可读化 + 可恢复动作（重试当前操作 / 重新载入 / 返回列表）
      const [errorInfo, setErrorInfo] = React.useState(null)
      const [retryAction, setRetryAction] = React.useState(null)
      // P2-3 审读报告（只读展示；触发由 Agent 工具 deep:true 完成，面板不主动调用）
      const [reviewReport, setReviewReport] = React.useState(null)
      const [reviewBusy, setReviewBusy] = React.useState(false)
      const [reviewError, setReviewError] = React.useState('')
      const [reviewEpisode, setReviewEpisode] = React.useState(0)
      const [reviewFeedback, setReviewFeedback] = React.useState({})
      const [reviewJump, setReviewJump] = React.useState(null)
      // v0.6.3：审读展示细化（维度筛选 / 排序）+ 任务模型最近使用列表
      const [reviewDimensionFilter, setReviewDimensionFilter] = React.useState('')
      const [reviewSort, setReviewSort] = React.useState('severity')
      // v0.10.4（task-91）：分镜「详情」展开行（仅 UI 态，不写盘/不发请求）
      const [shotExtraOpen, setShotExtraOpen] = React.useState(null)
      // v0.11.2（task-99）：分镜分组 groups add-only 只读展示（仅 UI 态；无 groups → 零新显示）
      const [shotGroups, setShotGroups] = React.useState(null)
      const [shotGroupsTruncated, setShotGroupsTruncated] = React.useState(false)
      // v0.11.5（task-4 · P0 数据安全三连）：载入态 / 空覆盖守卫 / 未保存离开守卫
      // loadedEpisodeOrder / loadedShotsOrder = 当前 episodeText / shots 对应的集数（0 = 未载入）；
      // 保存前与 episodeOrder 比对，不一致一律拦截（防止把 A 集内容写进 B 集）。
      const [loadedEpisodeOrder, setLoadedEpisodeOrder] = React.useState(0)
      const [loadedShotsOrder, setLoadedShotsOrder] = React.useState(0)
      const [episodeDiskHadContent, setEpisodeDiskHadContent] = React.useState(false)
      const [episodeLoadError, setEpisodeLoadError] = React.useState('')
      const [shotsLoadError, setShotsLoadError] = React.useState('')
      // 空覆盖守卫的持久提示：{ scope: 'episode' | 'storyboard', text }（say() 2.2s 太短，GUI 走查需要看得到）
      const [saveBlock, setSaveBlock] = React.useState(null)
      // 未保存离开守卫：leavePrompt = { action }（action = 用户确认后要执行的离开动作）
      const [leavePrompt, setLeavePrompt] = React.useState(null)
      const [leaveSaving, setLeaveSaving] = React.useState(false)

      const say = (message) => {
        setFlash(message)
        window.setTimeout(() => setFlash(''), 2200)
      }

      const retryLastAction = () => {
        const pending = retryAction
        if (!pending || busy) return
        setRetryAction(null)
        guard(pending.run)
      }

      // v0.11.5（task-4）：guard 返回布尔（true=提交成功；false=被校验拦截或失败），供「保存并离开」判断是否真正保存成功
      const guard = async (fn) => {
        setBusy(true)
        setError('')
        setErrorInfo(null)
        try {
          const result = await fn()
          return result !== false
        } catch (err) {
          setError(err.message)
          setErrorInfo(friendlyErrorInfo(err))
          setRetryAction({ run: fn })
          return false
        } finally {
          setBusy(false)
        }
      }

      const markDirty = (key) => setDirty((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
      const clearDirty = (key) => setDirty((prev) => (prev[key] ? { ...prev, [key]: false } : prev))
      const dirtyMark = (key) => (dirty[key] ? h('span', { className: 'ad-dirty' }, '● 有未保存修改') : null)

      /* ------------------------- v0.11.5（task-4）：P0 数据安全三连公共状态/守卫 ------------------------- */

      const DIRTY_KEYS = ['contract', 'outline', 'characters', 'world', 'memory', 'episode', 'storyboard']
      const DIRTY_LABELS = {
        contract: '剧集契约',
        outline: '总纲',
        characters: '人物',
        world: '世界观',
        memory: '本剧记忆',
        episode: '剧本',
        storyboard: '分镜',
        doc: '文档',
      }
      const hasUnsavedChanges = () => DIRTY_KEYS.some((key) => Boolean(dirty[key])) || docDirty
      const resetAllDirty = () => {
        setDirty({ contract: false, outline: false, characters: false, world: false, memory: false, episode: false, storyboard: false })
        setDocDirty(false)
        setSaveBlock(null)
      }
      const unsavedScopeLabels = () => {
        const labels = DIRTY_KEYS.filter((key) => Boolean(dirty[key])).map((key) => DIRTY_LABELS[key])
        if (docDirty) labels.push(DIRTY_LABELS.doc)
        return labels
      }
      // P0-1：统一离开守卫入口（只判断「有没有未保存修改」；保存/放弃动作由对话框按钮执行）
      const requestLeave = (action) => {
        if (typeof action !== 'function') return
        if (!hasUnsavedChanges()) {
          action()
          return
        }
        setLeavePrompt({ action })
      }

      // P0-2：项目级状态清理（openProject 起始统一调用；resetProjectView 切源/返回列表复用同一份口径）。
      // 清理范围：文档编辑器 / 生成（画布·预算·任务·已规划计划）/ 账本 / 台词 / 素材 / 导入 / 剧本分镜载入态 / 未保存标记。
      // 保留：数据源选择、全局设置、页签折叠偏好等全局状态。
      const resetProjectScopedState = () => {
        // 文档编辑器（T7/E1）：A 项目残留的 docPath/docText 不得沿用到 B 项目
        setDocOpen(false)
        setDocPath('')
        setDocText('')
        setDocHash('')
        setDocUpdatedAt('')
        setDocDirty(false)
        setDocBusy(false)
        setDocNotice('')
        setDocError('')
        setDocUnavailable(false)
        setDocConflict(null)
        setDocNotifyState('idle')
        setDocSelection('')
        // 生成页：A 项目的画布/预算/任务/已规划计划不得沿用到 B 项目（防止 A 计划花 B 预算）
        setGenBackends(null)
        setGenCanvas(null)
        setGenBudget(null)
        setGenTasks([])
        setGenPlan(null)
        // 账本 / 台词 / 素材 / 导入预览：跨项目不串扰
        setLedger(null)
        setLedgerRendered(false)
        setRegistrySupported(null)
        setRegistryOk(true)
        setRegistryBusy(false)
        setRegistryNotice('')
        setRegistryError('')
        setDialogue(null)
        setEpisodeView('text')
        setDialogueEpisodeFilter('all')
        setDialogueCharacterFilter('all')
        setDialogueRedirectNotice(false)
        setAssets([])
        setAssetSource('')
        setAssetShots('')
        setAssetCards([])
        setAssetTypeFilter('全部')
        setAssetQuery('')
        setAssetSelectedId(null)
        setAssetImageIndex(0)
        setAssetImageCache({})
        setAssetBrokenImages({})
        setAssetAudioIndex(0)
        setAssetBrokenAudios({})
        setVisualStyle(null)
        setStyleDirection(null)
        setStyleDraft(styleDraftOf(null))
        setStyleBusy(false)
        setStyleNotice('')
        setStyleError('')
        setStyleDialog(null)
        setStyleReason('')
        setStyleReasonError('')
        setVisualScenes([])
        setAssetView('cards')
        setVisualType('all')
        setVisualQuery('')
        setVisualSort('id-asc')
        setVisualLightbox(null)
        setVisualAudioIndex({})
        setVisualGroupCollapsed({})
        setLegacyImageCache({})
        setLegacyKindFilter('all')
        setLegacyQuery('')
        setLegacySort('name-asc')
        setAssetRegistrationOpen(false)
        setScanSupported(null)
        setScanOpen(false)
        setScanFiles([])
        setScanTotal(0)
        setScanTruncated(false)
        setScanKindFilter('all')
        setScanSelected({})
        setScanBatchBusy(false)
        setScanProgress({ done: 0, total: 0 })
        setScanSummary(null)
        setImportOpen(false)
        setImportQueue([])
        setImportCategory('')
        setImportBusy(false)
        setImportProgress({ done: 0, total: 0 })
        setImportSummary(null)
        // v0.16.1（task-139 / C-6）：产物入库本地文件/分类状态（切项目清空）
        setArtifactFile(null)
        setArtifactFileName('')
        setArtifactFileSize(0)
        setArtifactCategory(ARTIFACT_CATEGORY_DEFAULT)
        setArtifactResult(null)
        setCrossOpen(false)
        setCrossSourceTitle('')
        setCrossAssets([])
        setCrossLoading(false)
        setCrossLoadError('')
        setCrossQuery('')
        setCrossSelected({})
        setCrossCategory('')
        setCrossBusy(false)
        setCrossSummary(null)
        setCrossTab('assets')
        setCrossCards([])
        setCrossScenes([])
        setCrossStyle(null)
        setCrossCardSelected({})
        setCrossSceneSelected({})
        setCrossCopyStyleDNA(false)
        setCrossCopyMedia(true)
        setCrossAllowNewIdSuffix(false)
        setCrossOverwriteStyle(false)
        setCrossWarnings([])
        setProjectRoot('')
        setAssetAddError('')
        legacyImageLoadState.clear()
        assetImageLoadState.clear()
        setImportText('')
        setImportPreview(null)
        setShowImport(false)
        // 剧本/分镜载入态 + 守卫提示（正文/分镜内容本身也清空，避免跨项目残留）
        setEpisodeText('')
        setShots([])
        setShotGroups(null)
        setShotGroupsTruncated(false)
        setShotExtraOpen(null)
        setLoadedEpisodeOrder(0)
        setLoadedShotsOrder(0)
        setEpisodeDiskHadContent(false)
        setEpisodeLoadError('')
        setShotsLoadError('')
        setSaveBlock(null)
        setLeavePrompt(null)
        setLeaveSaving(false)
        // 未保存标记（7 个可保存页签 + 文档）
        setDirty({ contract: false, outline: false, characters: false, world: false, memory: false, episode: false, storyboard: false })
      }

      // P0-3：载入结果统一应用（手动载入 / 自动载入共用，保证载入态与磁盘内容标记一致）
      const applyEpisodeLoaded = (order, text) => {
        const target = Number(order) || 1
        setEpisodeOrder(target)
        setEpisodeText(typeof text === 'string' ? text : '')
        setLoadedEpisodeOrder(target)
        setEpisodeDiskHadContent(Boolean(String(text || '').trim()))
        setEpisodeLoadError('')
        clearDirty('episode')
      }
      const applyShotsLoaded = (order, response) => {
        const target = Number(order) || 1
        const result = response || {}
        setEpisodeOrder(target)
        setShots(result.shots || [])
        setShotExtraOpen(null)
        const groups = normalizeStoryboardGroups(result.groups)
        setShotGroups(groups)
        setShotGroupsTruncated(Boolean(groups) && (result.groupsTruncated === true || result.truncated === true))
        setLoadedShotsOrder(target)
        setShotsLoadError('')
        clearDirty('storyboard')
      }
      // P0-3：openProject 后自动载入当前集正文 / 分镜（只读、不阻断进入项目；not-found/空视为空项目静默，其他错误给可读提示）
      const autoLoadEpisode = async (title, order) => {
        const target = Number(order) || 1
        try {
          const result = await api('episode-read', { title, order: target })
          applyEpisodeLoaded(target, result.text || '')
        } catch (error) {
          if (error && (error.code === 'not-found' || error.code === 'invalid-args')) {
            setLoadedEpisodeOrder(target)
            setEpisodeDiskHadContent(false)
            setEpisodeLoadError('')
          } else {
            setEpisodeLoadError(`第 ${target} 集正文自动载入失败：${error.message}（可点「载入」重试）`)
          }
        }
      }
      const autoLoadShots = async (title, order) => {
        const target = Number(order) || 1
        try {
          const result = await api('storyboard-get', { title, order: target })
          applyShotsLoaded(target, result)
        } catch (error) {
          if (error && (error.code === 'not-found' || error.code === 'invalid-args')) {
            setEpisodeOrder(target)
            setShots([])
            setShotGroups(null)
            setShotGroupsTruncated(false)
            setLoadedShotsOrder(target)
            setShotsLoadError('')
          } else {
            setShotsLoadError(`第 ${target} 集分镜自动载入失败：${error.message}（可点「载入」重试）`)
          }
        }
      }

      const loadList = React.useCallback(async () => {
        setPhase('loading')
        setError('')
        try {
          const [st, shelf, stg, sh] = await Promise.all([
            api('status'),
            api('shelf'),
            api('settings-get'),
            api('shared-list', {}),
          ])
          setStatus(st)
          setHostFlags({ p1: versionAtLeast(st.version, MIN_P1_HOST) })
          // v0.15.11（task-135 / IMP-C）：能力探测 A（version≥0.15.11 才显示「导入素材」，旧宿主零新显示、零额外请求）
          setImportSupported(versionAtLeast(st.version, IMPORT_MIN_HOST_VERSION))
        setCrossSupported(versionAtLeast(st.version, CROSS_IMPORT_MIN_HOST_VERSION))
        setM3Supported(versionAtLeast(st.version, M3_MIN_HOST_VERSION))
        setCrossObjectsSupported(versionAtLeast(st.version, CROSS_OBJECTS_MIN_HOST_VERSION))
          setProjects(shelf.projects || [])
          setSettings(normalizeSettings(stg.settings))
          setShared(sh)
          setPhase('ready')
        } catch (err) {
          setError(err.message)
          setErrorInfo(friendlyErrorInfo(err))
          setRetryAction({ run: loadList })
          setPhase('error')
        }
      }, [])

      React.useEffect(() => {
        loadList()
      }, [loadList])

      const createProject = () =>
        guard(async () => {
          const title = draftTitle.trim()
          if (!title) return
          await api('create-project', { title })
          setDraftTitle('')
          await loadList()
          say('已创建')
        })

      const openProject = (title) =>
        guard(async () => {
          // P0-2（task-4）：打开项目前统一清理上一项目残留的项目级状态（doc/gen/ledger/dialogue/assets/import + dirty）
          resetProjectScopedState()
          const [t, c, o, ch, eps, dr, mem, wrld, prg, fin] = await Promise.all([
            api('tree', { title }),
            api('contract-get', { title }),
            api('outline-get', { title }),
            api('characters-get', { title }),
            api('episodes-list', { title }),
            api('drafts-list', { title }),
            api('memory-get', { title }),
            api('world-get', { title }),
            api('progress-get', { title }),
            api('finalized-list', { title }),
          ])
          setOpenTitle(title)
          setProjectRoot(t && t.tree && typeof t.tree.path === 'string' ? t.tree.path : '')
          setTree(t.tree)
          setContract(c.contract)
          setRows(o.rows || [])
          setCharacters(ch.characters || [])
          setEpisodes(eps.episodes || [])
          setDraftList(dr.drafts || [])
          setMemory(mem.memory || [])
          setWorld(wrld.world || [])
          setProgress(prg.progress)
          setFinalized((fin.finalized || []).map((f) => f))
          setReport(null)
          setExported([])
          setTab('outline')
          const first = (eps.episodes || [])[0]
          const firstOrder = first ? Number(first.order) || 1 : 1
          setEpisodeOrder(firstOrder)
          setEpisodeText('')
          setShots([])
          // 折叠状态按项目持久化（FR-A04）
          try {
            const raw = window.localStorage.getItem('ai-drama:collapsed:' + t.tree.path)
            setCollapsed(raw ? JSON.parse(raw) : {})
          } catch {
            setCollapsed({})
          }
          setPhase('project')
          // P0-3（task-4）：自动载入当前集正文 / 分镜（首屏即见磁盘内容；失败不阻断进入项目，仅给可读提示）
          autoLoadEpisode(title, firstOrder).catch(() => {})
          autoLoadShots(title, firstOrder).catch(() => {})
          // P2-3：审读报告按需读取（进入检查页触发）；切项目先清空本地裁决
          setReviewReport(null)
          setReviewBusy(false)
          setReviewError('')
          setReviewEpisode(0)
          setReviewFeedback(readReviewFeedback())
          setReviewJump(null)
        })

      const toggleCollapse = (name) =>
        setCollapsed((prev) => {
          const next = { ...prev, [name]: !prev[name] }
          try {
            if (tree) window.localStorage.setItem('ai-drama:collapsed:' + tree.path, JSON.stringify(next))
          } catch {
            /* 忽略 */
          }
          return next
        })

      const doSearch = () =>
        guard(async () => {
          const result = await api('search', { query })
          setHits(result)
        })

      /* ------------------------------------------------------ 契约 / 总纲 / 人物 */

      // P0-1（task-4）：契约编辑统一入口 —— 任何字段变更都标「未保存」（dirty 覆盖 7 个可保存页签）
      const updateContract = (next) => {
        markDirty('contract')
        setContract(next)
      }

      const saveContract = () =>
        guard(async () => {
          // v0.16.2（C1-C）：8 字段超长前端提示（trim 后计；后端 C1-H 400 仍为最终权威）
          const overLimit = contractWorldOverLimit(contract)
          if (overLimit.length) {
            setError('八大设定超出长度上限：' + overLimit.map(([label, length, limit]) => '「' + label + '」' + length + '/' + limit).join('、') + '；请精简后再保存（后端亦会以 400 拒绝）。')
            return false
          }
          // v0.16.2（C1-C）：只提交非空字段（trim 非空保留、空串删键）；其余 7 字段与未知旧字段原样
          const result = await api('contract-save', { title: openTitle, contract: contractWorldPayload(contract) })
          setContract(result.contract)
          clearDirty('contract')
          say('契约已保存')
        })

      const setRow = (index, key, value) => {
        markDirty('outline')
        setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [key]: value } : row)))
      }
      const addRow = () => {
        markDirty('outline')
        setRows((prev) => [
          ...prev,
          { order: prev.length + 1, title: '', logline: '', hook: '', twist: '', cliffhanger: '', estDurationSec: 0 },
        ])
      }
      const removeRow = (index) => {
        markDirty('outline')
        setRows((prev) => prev.filter((_, i) => i !== index))
      }
      const saveOutline = () => guard(async () => {
        const result = await api('outline-save', { title: openTitle, rows })
        setRows(result.rows)
        clearDirty('outline')
        say('总纲已保存')
      })

      const setCard = (index, key, value) => {
        markDirty('characters')
        setCharacters((prev) => prev.map((card, i) => (i === index ? { ...card, [key]: value } : card)))
      }
      const addCard = () => {
        markDirty('characters')
        setCharacters((prev) => [...prev, { name: '', role: '配角', personality: [], bio: '', appearancePrompt: '', voiceHint: '' }])
      }
      const removeCard = (index) => {
        markDirty('characters')
        setCharacters((prev) => prev.filter((_, i) => i !== index))
      }
      const saveCharacters = () => guard(async () => {
        const result = await api('characters-save', { title: openTitle, characters })
        setCharacters(result.characters)
        clearDirty('characters')
        say('人物卡已保存')
      })

      /* ---------------------------------------------------------- 剧本 / 分镜 */

      const loadEpisode = (order) =>
        guard(async () => {
          const target = Number(order) || 1
          const result = await api('episode-read', { title: openTitle, order: target })
          applyEpisodeLoaded(target, result.text || '')
        })

      // P0-3（task-4）：空/串集覆盖守卫 —— 未载入或载入集数不匹配时不得写盘（新建集合法路径除外）
      const episodeSaveBlocked = () => {
        const target = Number(episodeOrder) || 1
        const diskExists = episodes.some((item) => Number(item.order) === target)
        const trimmed = String(episodeText || '').trim()
        if (loadedEpisodeOrder !== target) {
          if (diskExists) {
            setSaveBlock({ scope: 'episode', text: `第 ${target} 集磁盘已有内容，但编辑器未载入该集：请先点「载入」查看磁盘内容，确认后再保存（防止空内容/串集覆盖）。` })
            return true
          }
          // 磁盘上还没有该集文件：新建集是合法路径，允许保存
          return false
        }
        if (!trimmed && episodeDiskHadContent) {
          setSaveBlock({ scope: 'episode', text: `第 ${target} 集磁盘已有内容，空内容保存会清空它：请先点「载入」确认后再保存。` })
          return true
        }
        return false
      }

      const saveEpisode = () =>
        guard(async () => {
          if (episodeSaveBlocked()) return false
          setSaveBlock(null)
          const target = Number(episodeOrder) || 1
          const result = await api('episode-write', { title: openTitle, order: target, text: episodeText })
          const eps = await api('episodes-list', { title: openTitle })
          setEpisodes(eps.episodes || [])
          setLoadedEpisodeOrder(target)
          setEpisodeDiskHadContent(Boolean(String(episodeText || '').trim()))
          clearDirty('episode')
          const bytes = result.saved && result.saved.bytes
          say(`第${target}集已保存${bytes ? `（${bytes} 字节）` : ''}`)
          // P2-8 一致性：编辑器打开的是同一剧本文件时，同步磁盘最新内容（有未保存修改则先提示）
          if (docOpen && docPath && docPath === docFallbackPath()) {
            if (docDirty) setDocNotice('文档编辑器有未保存修改：可直接保存覆盖，或点「重新载入最新」同步刚保存的剧本。')
            else loadDoc(docPath).catch(() => {})
          }
        })

      const loadShots = (order) =>
        guard(async () => {
          const target = Number(order) || 1
          const result = await api('storyboard-get', { title: openTitle, order: target })
          applyShotsLoaded(target, result)
        })

      // P0-3（task-4）：分镜未载入（或载入集数不匹配）时禁止写盘，避免整体覆盖磁盘分镜
      const shotsSaveBlocked = () => {
        const target = Number(episodeOrder) || 1
        if (loadedShotsOrder !== target) {
          setSaveBlock({ scope: 'storyboard', text: `第 ${target} 集分镜尚未载入：请先点「载入」确认磁盘内容后再保存（防止覆盖磁盘分镜）。` })
          return true
        }
        return false
      }

      const setShot = (index, key, value) => {
        markDirty('storyboard')
        setShots((prev) => prev.map((shot, i) => (i === index ? { ...shot, [key]: value } : shot)))
      }
      const addShot = () => {
        markDirty('storyboard')
        setShots((prev) => [
          ...prev,
          { shotNumber: `${episodeOrder}-${prev.length + 1}`, shotSize: '中景', cameraMove: '', description: '', dialogue: '', sfx: '', durationSec: 3, imagePrompt: '', videoPrompt: '' },
        ])
      }
      const removeShot = (index) => {
        markDirty('storyboard')
        setShots((prev) => prev.filter((_, i) => i !== index))
      }
      // P1-A：表格行上/下移（纯客户端），配合「自动重编号」保持镜号与顺序一致
      const moveShot = (index, delta) => {
        setShots((prev) => {
          const target = index + delta
          if (target < 0 || target >= prev.length) return prev
          const next = prev.slice()
          const [item] = next.splice(index, 1)
          next.splice(target, 0, item)
          return next
        })
        markDirty('storyboard')
      }
      const renumberShots = () => {
        setShots((prev) => prev.map((shot, i) => ({ ...shot, shotNumber: `${episodeOrder}-${i + 1}` })))
        markDirty('storyboard')
        say('镜号已按当前顺序重编')
      }
      const saveShots = () => guard(async () => {
        if (shotsSaveBlocked()) return false
        setSaveBlock(null)
        const target = Number(episodeOrder) || 1
        const result = await api('storyboard-save', { title: openTitle, order: episodeOrder, shots })
        // v0.10（task-84）：host 返回为权威；合并回 host 未返回的未知/add-only per-shot 字段，
        // 避免保存后本地 state 被规范化返回值覆盖导致字段在会话内丢失（已知字段以 host 返回为准）。
        setShots((prev) => mergeShotsPreservingExtraFields(prev, result.shots))
        setLoadedShotsOrder(target)
        clearDirty('storyboard')
        say(`分镜已保存${result.shots ? `（${result.shots.length} 个镜头）` : ''}`)
      })

      /* ---------------------------------------------------------- 草稿 / 检查 / 导出 */

      const loadDrafts = (includeResolved) => {
        const resolved = Boolean(includeResolved)
        setDraftIncludeResolved(resolved)
        return guard(async () => {
          const result = await api('drafts-list', { title: openTitle, includeResolved: resolved })
          setDraftList(result.drafts || [])
        })
      }

      // 草稿处理后统一刷新：草稿区 + 可能被改写的正式内容 + 分镜 + 目录树
      const reloadAfterDraftResolution = async () => {
        const [dr, c, o, ch, eps, sb, tr] = await Promise.all([
          api('drafts-list', { title: openTitle, includeResolved: draftIncludeResolved }),
          api('contract-get', { title: openTitle }),
          api('outline-get', { title: openTitle }),
          api('characters-get', { title: openTitle }),
          api('episodes-list', { title: openTitle }),
          api('storyboard-get', { title: openTitle, order: episodeOrder }),
          api('tree', { title: openTitle }),
        ])
        setDraftList(dr.drafts || [])
        setContract(c.contract)
        setRows(o.rows || [])
        setCharacters(ch.characters || [])
        setEpisodes(eps.episodes || [])
        setShots(sb.shots || [])
        setLoadedShotsOrder(Number(episodeOrder) || 1)
        // 草稿采纳可能改写剧本正文：本地 episodeText 可能已过期 → 失效载入态，保存前必须先「载入」（防空覆盖）
        setLoadedEpisodeOrder(0)
        setTree(tr.tree)
        // 草稿处理后状态由宿主权威内容整体替换 → 对应页签的未保存标记同步清零（避免守卫误报）
        clearDirty('contract')
        clearDirty('outline')
        clearDirty('characters')
        clearDirty('storyboard')
      }

      const resolveDraft = (id, action) =>
        guard(async () => {
          await api('draft-resolve', { title: openTitle, id, action })
          say(action === 'accept' ? '已采纳并写入正式稿' : '已丢弃')
          setDraftSelection((prev) => ({ ...prev, [id]: false }))
          await reloadAfterDraftResolution()
        })

      // C-1：批量采纳/丢弃/恢复。宿主 < 0.4.0 时按钮隐藏；accept/discard 批量失败时降级为逐条调用。
      const pendingDrafts = draftList.filter((draft) => draft.status === 'pending')
      const selectedDraftIds = pendingDrafts.filter((draft) => draftSelection[draft.id]).map((draft) => draft.id)

      const toggleDraftSelection = (id) =>
        setDraftSelection((prev) => ({ ...prev, [id]: !prev[id] }))

      const toggleSelectAllDrafts = () =>
        setDraftSelection((prev) => {
          const allOn = pendingDrafts.length > 0 && pendingDrafts.every((draft) => prev[draft.id])
          const next = { ...prev }
          for (const draft of pendingDrafts) next[draft.id] = !allOn
          return next
        })

      const batchResolveDrafts = (action) =>
        guard(async () => {
          const ids = selectedDraftIds
          if (!ids.length) return
          let note = ''
          try {
            const result = await api('draft-resolve', { title: openTitle, ids, action })
            const counts = result && result.counts
            if (counts && counts.failed) note = `，失败 ${counts.failed} 条`
          } catch (err) {
            if (action === 'restore') throw err
            // 旧宿主不认识 ids 时降级：逐条沿用单条语义
            for (const id of ids) {
              await api('draft-resolve', { title: openTitle, id, action })
            }
            note = '（宿主旧版，已逐条处理）'
          }
          say(`${action === 'accept' ? '批量采纳' : '批量丢弃'} ${ids.length} 条${note}`)
          setDraftSelection({})
          await reloadAfterDraftResolution()
        })

      const restoreDraft = (id) =>
        guard(async () => {
          await api('draft-resolve', { title: openTitle, id, action: 'restore' })
          say('已恢复到草稿区（待采纳）')
          setDraftSelection((prev) => ({ ...prev, [id]: false }))
          await reloadAfterDraftResolution()
        })

      const runCheck = () =>
        guard(async () => {
          const result = await api('consistency-check', { title: openTitle })
          setReport(result.report)
          say('检查完成')
        })

      const runExport = (format) =>
        guard(async () => {
          const result = await api('export-project', { title: openTitle, format })
          setExported((prev) => [...prev.filter((x) => x.format !== format), result.export])
          say('已导出 ' + format)
        })

      /* ------------------------------------------------------------ 本剧记忆 */

      const setMem = (index, key, value) => {
        markDirty('memory')
        setMemory((prev) => prev.map((m, i) => (i === index ? { ...m, [key]: value } : m)))
      }
      const addMem = () => {
        markDirty('memory')
        setMemory((prev) => [...prev, { id: '', kind: '伏笔', content: '', episode: null, status: 'open' }])
      }
      const removeMem = (index) => {
        markDirty('memory')
        setMemory((prev) => prev.filter((_, i) => i !== index))
      }
      const saveMemory = () =>
        guard(async () => {
          const result = await api('memory-save', { title: openTitle, memory })
          setMemory(result.memory)
          clearDirty('memory')
          say('本剧记忆已保存')
        })

      /* ------------------------------------------------------------ 项目操作 */

      const renameProject = (title) =>
        guard(async () => {
          const name = window.prompt('重命名短剧', title)
          if (!name || name === title) return
          await api('project-rename', { title, name })
          await loadList()
          say('已重命名')
        })

      const deleteProject = (title) =>
        guard(async () => {
          if (!window.confirm(`删除短剧《${title}》？\n\n该操作会删除项目目录下的全部内容（含 .aidrama 源数据与历史快照），且不可恢复。`)) return
          await api('project-delete', { title })
          await loadList()
          say('已删除')
        })

      /* ------------------------------------------------- 目录树条目管理（C-4） */

      const refreshTree = () =>
        guard(async () => {
          const result = await api('tree', { title: openTitle })
          setTree(result.tree)
        })

      // P1 只支持一级节点的改名/删除（Lead 定调：二级路径操作列 P2）。
      // 必需节点在客户端先做保护，避免用户误删/误改导致面板功能失效。
      const REQUIRED_ROOTS = ['剧集契约.md', '分集剧本', '分镜', '人物', '总纲']

      const createEntry = (parent) =>
        guard(async () => {
          const raw = window.prompt(`在「${parent}」下新建文件\n\n名称（可带子目录，如：第001集.md）`, '')
          const name = raw == null ? '' : raw.trim()
          if (!name) return
          await api('entry-create', { title: openTitle, path: `${parent}/${name}`, kind: 'file' })
          await refreshTree()
          say(`已新建：${name}`)
        })

      const createEntryDir = (parent) =>
        guard(async () => {
          const raw = window.prompt(`在「${parent}」下新建子目录`, '')
          const name = raw == null ? '' : raw.trim()
          if (!name) return
          await api('entry-create', { title: openTitle, path: `${parent}/${name}`, kind: 'dir' })
          await refreshTree()
          say(`已新建目录：${name}`)
        })

      const renameEntry = (relPath) =>
        guard(async () => {
          const raw = window.prompt(`重命名「${relPath}」\n\n提示：固定节点改名后，面板对应功能可能找不到它。`, relPath)
          const name = raw == null ? '' : raw.trim()
          if (!name || name === relPath) return
          await api('entry-rename', { title: openTitle, path: relPath, name })
          await refreshTree()
          say('已重命名')
        })

      const deleteEntry = (relPath) =>
        guard(async () => {
          if (!window.confirm(`删除「${relPath}」？\n\n若为目录，其下全部内容会一并删除，且不可恢复。`)) return
          await api('entry-delete', { title: openTitle, path: relPath })
          await refreshTree()
          say('已删除')
        })

      /* ------------------------------------- 文档编辑器（T7 / 契约 E1） */

      const docFallbackPath = () => `分集剧本/第${String(episodeOrder).padStart(3, '0')}集.md`

      const docCandidates = () => {
        const paths = ['剧集契约.md']
        if (tree && Array.isArray(tree.nodes)) {
          for (const node of tree.nodes) {
            if (node.kind !== 'dir' || !Array.isArray(node.children)) continue
            for (const kid of node.children) if (kid.kind === 'file') paths.push(`${node.name}/${kid.name}`)
          }
        }
        if (episodeOrder) paths.push(docFallbackPath())
        return [...new Set(paths)]
      }

      const isHostRouteMissing = (error) =>
        Boolean(error) && (error.code === 'not-found' || /未知方法/.test(String(error.message || '')))

      const loadDoc = async (path) => {
        if (!openTitle) return
        const target = path || docPath || docFallbackPath()
        setDocBusy(true)
        setDocError('')
        setDocNotice('')
        try {
          const result = await api('doc-read', { title: openTitle, path: target })
          setDocPath(result.path || target)
          setDocText(typeof result.text === 'string' ? result.text : '')
          setDocHash(result.hash || '')
          setDocUpdatedAt(result.updatedAt || '')
          setDocDirty(false)
          setDocConflict(null)
          setDocUnavailable(false)
          setDocNotifyState('idle')
          setDocSelection('')
          setDocNotice('文档已载入（当前为最新磁盘版本）')
        } catch (error) {
          if (isHostRouteMissing(error)) {
            setDocPath(target)
            setDocUnavailable(true)
            setDocError('宿主未提供 E1 编辑器接口（doc-read / doc-save / doc-notify 待 task-13 交付），编辑器降级为不可用。')
          } else {
            setDocError(error.message)
          }
        } finally {
          setDocBusy(false)
        }
      }

      // Lead 裁定：doc-notify 未就绪时按「不阻断保存」降级
      const notifyDocSaved = async (path, hash) => {
        try {
          await api('doc-notify', { title: openTitle, path, action: 'save', hash })
          setDocNotifyState('ok')
        } catch (error) {
          setDocNotifyState(isHostRouteMissing(error) ? 'skip' : 'fail')
        }
      }

      const saveDoc = async (expectedOverride) => {
        if (!openTitle || !docPath) return false
        if (docUnavailable) {
          setDocError('编辑器接口未就绪，暂不能保存。')
          return false
        }
        const expectedHash = typeof expectedOverride === 'string' ? expectedOverride : docHash
        setDocBusy(true)
        setDocError('')
        setDocNotice('')
        try {
          const result = await api('doc-save', { title: openTitle, path: docPath, text: docText, expectedHash })
          setDocHash(result.hash || '')
          setDocDirty(false)
          setDocConflict(null)
          setDocNotice(`已保存（${result.bytes == null ? docText.length : result.bytes} 字节）`)
          say('文档已保存')
          if (docPath === docFallbackPath()) {
            setEpisodeText(docText)
            setLoadedEpisodeOrder(Number(episodeOrder) || 1)
            setEpisodeDiskHadContent(Boolean(String(docText || '').trim()))
            setEpisodeLoadError('')
            clearDirty('episode')
          }
          await notifyDocSaved(docPath, result.hash || '')
          return true
        } catch (error) {
          if (error.code === 'conflict') {
            const detail = error.detail || {}
            setDocConflict({ currentHash: detail.currentHash || '', at: new Date().toISOString() })
            setDocError('磁盘版本已变化（conflict）：请选择「重新载入最新」或「保留本地重试」。')
            return false
          }
          if (isHostRouteMissing(error)) {
            setDocUnavailable(true)
            setDocError('宿主未提供 doc-save 接口（task-13 未就绪），无法保存。')
            return false
          }
          setDocError(error.message)
          return false
        } finally {
          setDocBusy(false)
        }
      }

      const toggleDocPane = () => {
        if (!docOpen && openTitle && !docPath && !docUnavailable) loadDoc(docFallbackPath())
        setDocOpen((open) => !open)
      }

      const pickDoc = (path) => {
        if (path === docPath) return
        if (docDirty && !window.confirm('当前文档有未保存修改，切换会丢弃这些修改。继续？')) return
        loadDoc(path)
      }

      /* ------------------------------------- 多数据源：选择器 / 切换 / 降级（P2-1） */

      // A 阶段降级来源：从根席位 hook `useWorkspaces` 快照枚举已注册工作区（WorkspaceView.path）
      const legacySources = () => {
        const list = []
        const seen = new Set()
        for (const item of workspaceItems) {
          const path = item && typeof item.path === 'string' ? item.path.trim() : ''
          if (!path || seen.has(path)) continue
          seen.add(path)
          list.push({
            path,
            sourceType: 'workspace',
            label: item.title || '',
            projectCount: null,
            lastActiveAt: item.updatedAt || item.createdAt || '',
          })
        }
        return list
      }

      const applySourceList = (list, mode, degraded, preferPath) => {
        const cleaned = (Array.isArray(list) ? list : [])
          .filter((item) => item && typeof item.path === 'string' && item.path.trim())
          .map((item) => ({
            path: item.path.trim(),
            sourceType: item.sourceType || 'workspace',
            label: item.label || '',
            projectCount: item.projectCount == null ? null : Number(item.projectCount),
            lastActiveAt: item.lastActiveAt || '',
          }))
        setSources(cleaned)
        setSourcesMode(mode)
        setSourcesDegraded(Boolean(degraded))
        const saved = readSavedSource()
        const exists = (path) => cleaned.some((item) => item.path === path)
        // preferPath = 本次切换目标（异步回调里 state 仍是旧值，必须显式传入，避免“切源后被旧列表回落”）
        const preferred = typeof preferPath === 'string' && preferPath ? preferPath : sourcePath
        let next = ''
        if (preferred && exists(preferred)) next = preferred
        else if (saved && exists(saved)) next = saved
        else if (cleaned.length) next = cleaned[0].path
        if (next !== sourcePath) setSourcePath(next)
        currentSourceCwd = next
        saveSourceSelection(next)
        return next
      }

      const refreshSources = async () => {
        setSourceBusy(true)
        try {
          const result = await api('sources-list', { limit: 50 })
          if (result && Array.isArray(result.sources)) {
            return applySourceList(result.sources, 'host', result.degraded)
          }
          throw new Error('sources-list 返回格式不正确')
        } catch (error) {
          // B→A 降级：旧宿主无 sources-list（或服务不可用）时退回工作区枚举，旧行为不被阻断
          return applySourceList(legacySources(), 'legacy', !isHostRouteMissing(error))
        } finally {
          setSourceBusy(false)
        }
      }

      // 切源后重置全部视图状态（页签/项目/文档/搜索均回到列表页），避免跨源串扰。
      // v0.11.5（task-4）：项目级状态清理统一走 resetProjectScopedState（与 openProject 共用一份口径）。
      const resetProjectView = () => {
        resetProjectScopedState()
        setPhase('ready')
        setTree(null)
        setOpenTitle('')
        setTab('outline')
        setContract(null)
        setRows([])
        setCharacters([])
        setEpisodes([])
        setEpisodeOrder(1)
        setDraftList([])
        setReport(null)
        setExported([])
        setMemory([])
        setWorld([])
        setProgress(null)
        setFinalized([])
        setShared(null)
        setSharedPath('')
        setSharedText('')
        setHits(null)
        // P2-3：审读报告与本地裁决一并清空（跨项目/跨源不串扰）
        setReviewReport(null)
        setReviewBusy(false)
        setReviewError('')
        setReviewEpisode(0)
        setReviewFeedback({})
        setReviewJump(null)
      }

      const selectSource = (path) => {
        const next = typeof path === 'string' ? path : ''
        if (!next || next === sourcePath) return
        // P0-1（task-4）：切数据源是「离开当前项目」路径，有未保存修改时先走三选一守卫
        requestLeave(() => {
          setSourcePath(next)
          currentSourceCwd = next
          saveSourceSelection(next)
          guard(async () => {
            resetProjectView()
            await loadList()
            // E5 语义：cwd 是排序提示（默认源之后优先当前源），刷新列表但不强制过滤
            try {
              const result = await api('sources-list', { cwd: next, limit: 50 })
              if (result && Array.isArray(result.sources)) {
                applySourceList(result.sources, 'host', result.degraded, next)
              }
            } catch {
              /* 旧宿主：保持 A 模式列表 */
            }
            say('已切换数据源：' + shortSourcePath(next))
          })
        })
      }

      const sourceLabelOf = (item, index) => {
        const name = item.label || shortSourcePath(item.path)
        const type = sourceTypeLabel(item.sourceType)
        const count = item.projectCount == null ? '' : ` · ${item.projectCount} 个项目`
        const mark = index === 0 && sourcesMode === 'host' ? '★ ' : ''
        return `${mark}${name}（${type}${count}）`
      }

      // P0-1/P0-2（task-4）：「← 返回」列表 = 离开项目路径：先守卫 → 再清理项目级状态 → 刷新列表
      const goBackToList = () => {
        setError('')
        setErrorInfo(null)
        setRetryAction(null)
        resetProjectView()
        loadList()
      }

      React.useEffect(() => {
        refreshSources().catch((err) => setError(err.message))
      }, [])

      // A 降级：工作区快照迟到（hook 异步 hydrate）时补全来源列表
      React.useEffect(() => {
        if (sourcesMode === 'host') return
        const list = legacySources()
        if (!list.length) return
        const signature = list.map((item) => item.path).join('\n')
        const current = sources.map((item) => item.path).join('\n')
        if (signature === current) return
        applySourceList(list, 'legacy', sourcesDegraded)
      }, [workspaceSnapshot])

      const switchTab = (tabKey) => {
        // v0.15.2（task-112）：legacy dialogue → 剧本页台词视图（无 URL 深链机制，按 tab-key 别名重定向）
        const targetTab = normalizeTabKey(tabKey)
        if (isLegacyDialogueTab(tabKey)) {
          setEpisodeView('dialogue')
          setDialogueRedirectNotice(true)
        }
        // P0-1（task-4）：切页签是「离开当前编辑页」路径，有未保存修改时先走三选一守卫
        requestLeave(() => {
          setTab(targetTab)
          // v0.15.4（task-119 / M20-C）：进入素材库自动加载（不再要求先点「刷新」）
          if (targetTab === 'assets' && openTitle) loadAssets().catch(() => {})
          // P2-3：进入「检查」页时若无报告则尝试读取最新审读报告（未就绪时静默降级为空态+指引）
          if (targetTab === 'check' && openTitle && !reviewReport && !reviewBusy) loadReview().catch(() => {})
        })
      }

      // v0.15.2（task-112）：legacy `dialogue` tab key 统一重定向到「剧本」页台词视图 + 提示（无外部深链参数）。
      React.useEffect(() => {
        if (tab !== 'dialogue') return
        setEpisodeView('dialogue')
        setDialogueRedirectNotice(true)
        setTab('episode')
      }, [tab])

      /* --------------------------------- P2-3 审读报告（只读展示 / 跳转 / 裁决） */

      const loadReview = async (options = {}) => {
        if (!openTitle || reviewBusy) return
        setReviewBusy(true)
        setReviewError('')
        try {
          const result = await api('doc-read', { title: openTitle, path: REVIEW_LATEST_PATH })
          const text = typeof result.text === 'string' ? result.text : ''
          let parsed = null
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = null
          }
          if (!parsed || typeof parsed !== 'object') throw new Error('审读报告不是合法 JSON')
          const report = normalizeReviewReport(parsed)
          setReviewReport(report)
          setReviewEpisode(report.episode != null ? Number(report.episode) || 0 : 0)
          if (options.notice) say('审读报告已刷新')
        } catch (error) {
          setReviewReport(null)
          if (isHostRouteMissing(error) || (error && (error.code === 'not-found' || error.code === 'invalid-args'))) {
            // 宿主审读报告白名单未就绪 / 尚无报告：不报错、不阻断，显示空态与触发指引（Q3 默认不阻断）
            setReviewError('尚未读到审读报告。让 Agent 在短剧模式下说「审读第 N 集」（对应 drama_check_consistency deep:true），完成后点「刷新审读报告」。')
          } else {
            setReviewError(error.message)
          }
        } finally {
          setReviewBusy(false)
        }
      }

      // 跳转：有镜号 → 分镜页定位该镜；无镜号 → 剧本页定位场次（Q7 单集范围）
      const jumpToFinding = (finding) => {
        const loc = (finding && finding.location) || {}
        const episode = Number(loc.episode) || Number(reviewEpisode) || Number(episodeOrder) || 1
        // P0-1（task-4）：审读「跳转定位」会切换页签并重新载入内容，有未保存修改时先走三选一守卫
        requestLeave(() => {
          setReviewJump({
            episode,
            scene: loc.scene == null ? '' : loc.scene,
            shot: loc.shot == null ? '' : loc.shot,
          })
          if (loc.shot != null && String(loc.shot) !== '') {
            setTab('storyboard')
            loadShots(episode).catch(() => {})
          } else {
            setTab('episode')
            loadEpisode(episode).catch(() => {})
          }
          say(`已定位：${reviewLocationText({ episode, scene: loc.scene, shot: loc.shot })}`)
        })
      }

      // 裁决（Q6）：v0.6.0 记录在 client localStorage（宿主不写回、不做自动学习；Q6 不做自动学习）
      const reviewFeedbackStorageKey = () => REVIEW_FEEDBACK_KEY_PREFIX + ((tree && tree.path) || openTitle || 'default')

      const readReviewFeedback = () => {
        try {
          const raw = window.localStorage.getItem(reviewFeedbackStorageKey())
          const value = raw ? JSON.parse(raw) : null
          return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
        } catch {
          return {}
        }
      }

      const persistReviewFeedback = (next) => {
        try {
          window.localStorage.setItem(reviewFeedbackStorageKey(), JSON.stringify(next))
        } catch {
          /* 忽略：隐私模式等不阻断 */
        }
      }

      const setReviewVerdict = (id, verdict) => {
        if (!id) return
        setReviewFeedback((prev) => {
          const next = { ...prev, [id]: verdict }
          persistReviewFeedback(next)
          return next
        })
        say(
          verdict === 'accepted'
            ? '已采纳该审读建议（本地标记）'
            : verdict === 'false-positive'
              ? '已标记为误报（本地记录，v0.6.0 不做自动学习）'
              : '已忽略该建议（本地标记）',
        )
      }

      // 单条 finding 渲染（severity 徽标 / 维度 / 定位 / 置信度 / 证据 / 建议 / 本地裁决）
      const renderReviewFinding = (finding) => {
        const verdict = reviewFeedback[finding.id]
        const verdictText = verdict === 'accepted' ? '已采纳' : verdict === 'ignored' ? '已忽略' : verdict === 'false-positive' ? '已标误报' : ''
        return h('div', { className: 'ad-box ad-review-finding', key: finding.id, 'data-severity': finding.severity },
          h('div', { className: 'ad-review-head' },
            h('span', { className: 'ad-sev', 'data-tone': reviewSeverityTone(finding.severity) }, finding.severityLabel),
            h('span', null, finding.dimensionLabel),
            h('span', { className: 'ad-hit-path' }, reviewLocationText(finding.location)),
            finding.confidence != null ? h('span', { className: 'ad-count' }, `置信度 ${Math.round(Number(finding.confidence) * 100)}%`) : null,
            verdictText ? h('span', { className: 'ad-review-status' }, verdictText) : null),
          finding.evidence ? renderReviewEvidence(finding.evidence) : null,
          finding.suggestion ? h('div', { className: 'ad-hit' }, '建议：' + finding.suggestion) : null,
          h('div', { className: 'ad-review-actions' },
            h('button', { className: 'ad-btn ad-sm', onClick: () => jumpToFinding(finding) }, '跳转定位'),
            h('button', { className: 'ad-btn ad-sm', onClick: () => setReviewVerdict(finding.id, 'accepted'), disabled: verdictText === '已采纳' }, '采纳'),
            h('button', { className: 'ad-btn ad-sm', onClick: () => setReviewVerdict(finding.id, 'ignored'), disabled: verdictText === '已忽略' }, '忽略'),
            h('button', { className: 'ad-btn ad-sm', onClick: () => setReviewVerdict(finding.id, 'false-positive'), disabled: verdictText === '已标误报' }, '标误报')))
      }

      /* ------------------------------------------------------------ 世界观 */

      const setWorldEntry = (index, key, value) => {
        markDirty('world')
        setWorld((prev) => prev.map((e, i) => (i === index ? { ...e, [key]: value } : e)))
      }
      const addWorldEntry = () => {
        markDirty('world')
        setWorld((prev) => [...prev, { id: '', kind: '地点', name: '', detail: '' }])
      }
      const removeWorldEntry = (index) => {
        markDirty('world')
        setWorld((prev) => prev.filter((_, i) => i !== index))
      }
      const saveWorld = () =>
        guard(async () => {
          const result = await api('world-save', { title: openTitle, world })
          setWorld(result.world)
          clearDirty('world')
          say('世界观已保存')
        })

      /* ------------------------------------------------------- 共享资料 / 设置 */

      const openShared = (path) =>
        guard(async () => {
          if (!path) return
          const result = await api('shared-read', { path })
          setSharedPath(path)
          setSharedText(result.text || '')
        })

      const saveShared = () =>
        guard(async () => {
          if (!sharedPath) return
          await api('shared-write', { path: sharedPath, text: sharedText })
          const list = await api('shared-list', {})
          setShared(list)
          say('共享资料已保存')
        })

      /* ------------------------------------------------------- 台词 / 素材 */

      const loadDialogue = () =>
        guard(async () => {
          const result = await api('dialogue-get', { title: openTitle })
          setDialogue(result)
        })

      const exportVoiceScript = () =>
        guard(async () => {
          const result = await api('voice-script-export', { title: openTitle })
          say(`已导出 ${result.written.length} 份配音稿（共 ${result.total} 句）`)
        })

      // v0.15.1（task-108）：项目相对路径图片经只读 media-read 取 base64 → data URL（失败占位；去重/缓存；不写盘）。
      const ensureAssetImages = (rawList) => {
        if (!openTitle) return
        const candidates = []
        for (const raw of Array.isArray(rawList) ? rawList : [rawList]) {
          const src = assetImageSourceOf(raw)
          if (src.kind !== 'relative') continue
          if (!candidates.includes(src.value)) candidates.push(src.value)
        }
        const pending = candidates.filter((pathValue) => !assetImageLoadState.has(pathValue))
        if (!pending.length) return
        setAssetImageCache((prev) => {
          const next = { ...prev }
          let changed = false
          for (const pathValue of pending) {
            if (!next[pathValue]) {
              next[pathValue] = { status: 'loading' }
              changed = true
            }
          }
          return changed ? next : prev
        })
        for (const pathValue of pending.slice(0, 12)) {
          assetImageLoadState.set(pathValue, 'loading')
          api('media-read', { title: openTitle, path: pathValue })
            .then((result) => {
              // v0.15.2（task-112）：media-read 同时服务图片/音频；使用宿主返回的 MIME（不再固定 image/png）。
              const rawMime = result && typeof result.mime === 'string' ? result.mime.trim() : ''
              const mime = /^[a-z]+\/[a-z0-9.+-]+$/i.test(rawMime) ? rawMime : 'application/octet-stream'
              const base64 = result && typeof result.base64 === 'string' ? result.base64 : ''
              if (!base64) throw new Error('media-read 返回为空')
              assetImageLoadState.set(pathValue, 'ok')
              setAssetImageCache((prev) => ({ ...prev, [pathValue]: { status: 'ok', dataUrl: `data:${mime};base64,${base64}` } }))
            })
            .catch(() => {
              assetImageLoadState.set(pathValue, 'error')
              setAssetImageCache((prev) => ({ ...prev, [pathValue]: { status: 'error' } }))
            })
        }
      }

      // v0.15.4（task-119 / M20-C）：legacy 登记图片经 media-read({assetId}) 只读预览（不传客户端路径；host 白名单读已登记 source）。
      const ensureLegacyImages = (list) => {
        if (!openTitle) return
        const pending = (Array.isArray(list) ? list : []).filter((asset) => asset && asset.kind === 'image' && asset.id && !legacyImageLoadState.has(asset.id))
        if (!pending.length) return
        const batch = pending.slice(0, 8)
        for (const asset of batch) {
          legacyImageLoadState.set(asset.id, 'loading')
          setLegacyImageCache((prev) => (prev[asset.id] ? prev : { ...prev, [asset.id]: { status: 'loading' } }))
          api('media-read', { title: openTitle, assetId: asset.id })
            .then((result) => {
              const rawMime = result && typeof result.mime === 'string' ? result.mime.trim() : ''
              const mime = /^[a-z]+\/[a-z0-9.+-]+$/i.test(rawMime) ? rawMime : 'application/octet-stream'
              const base64 = result && typeof result.base64 === 'string' ? result.base64 : ''
              if (!base64) throw new Error('media-read 返回为空')
              legacyImageLoadState.set(asset.id, 'ok')
              setLegacyImageCache((prev) => ({ ...prev, [asset.id]: { status: 'ok', dataUrl: `data:${mime};base64,${base64}` } }))
            })
            .catch(() => {
              legacyImageLoadState.set(asset.id, 'error')
              setLegacyImageCache((prev) => ({ ...prev, [asset.id]: { status: 'error' } }))
            })
            .finally(() => {
              const rest = pending.slice(batch.length)
              if (rest.length) ensureLegacyImages(rest)
            })
        }
      }

      const loadAssets = (options) =>
        guard(async () => {
          // v0.15.9（task-129 / D2C-C）：首次进素材库带 scanMaterials:true 探测能力；失败保持未知下次重试；
          // 判定 false 后普通 load 不再带该参数（旧宿主输出与 v0.15.8 完全一致）。
          const keepView = Boolean(options && options.keepView === true)
          const wantsScan = options && typeof options.scan === 'boolean' ? options.scan : scanSupported === null
          // v0.16.9（C3-C / E16+H-8）：带 includeReviewHashes（add-only 入参）→ 读 cardsHash/scenesHash 供 asset-save expectedHash
          const assetsRequest = { title: openTitle, includeReviewHashes: true }
          if (wantsScan) assetsRequest.scanMaterials = true
          const result = await api('assets-get', assetsRequest)
          const cards = normalizeAssetCards(result.cards)
          const legacyList = normalizeLegacyAssets(result.assets)
          setAssets(result.assets || [])
          setAssetCards(cards)
          setAssetAddError('')
          if (Object.prototype.hasOwnProperty.call(result, 'registryOk')) {
            setRegistrySupported(true)
            setRegistryOk(result.registryOk !== false)
            if (result.registryOk === false) {
              setScanOpen(false)
              setImportOpen(false)
              setCrossOpen(false)
            }
          } else {
            setRegistrySupported(false)
            setRegistryOk(true)
          }
          if (Object.prototype.hasOwnProperty.call(result, 'unregisteredFiles')) {
            const normalizedScanFiles = normalizeScanFiles(result.unregisteredFiles)
            const total = Number(result.unregisteredTotal)
            setScanSupported(true)
            setScanFiles(normalizedScanFiles)
            setScanTotal(Number.isFinite(total) && total >= 0 ? Math.floor(total) : normalizedScanFiles.length)
            setScanTruncated(Boolean(result.truncated))
          } else if (wantsScan) {
            setScanSupported(false)
            setScanOpen(false)
          }
          setLegacyKindFilter('all')
          setLegacyQuery('')
          setLegacySort('name-asc')
          legacyImageLoadState.clear()
          setLegacyImageCache({})
          ensureLegacyImages(legacyList)
          // v0.15.3（task-115 / VB-C）：读取 add-only scenes/styleDNA（缺失 → 空态；零新调用点）
          setVisualScenes(normalizeVisualScenes(result.scenes))
          setVisualStyle(normalizeVisualStyle(result.styleDNA))
          setStyleDraft(styleDraftOf(result.styleDNA))
          setStyleDirection(normalizeStyleDirection(result.styleDirection))
          setStyleBusy(false)
          setStyleNotice('')
          setStyleError('')
          setStyleDialog(null)
          setStyleReason('')
          setStyleReasonError('')
          // v0.16.9（C3-C / E16+H-8）：审核工作台 hash（add-only 读：只有带 includeReviewHashes 且目标文件存在才返回）+ 状态重置
          const nextCardsHash = typeof result.cardsHash === 'string' ? result.cardsHash : ''
          const nextScenesHash = typeof result.scenesHash === 'string' ? result.scenesHash : ''
          setAssetReviewHashes({ asset: nextCardsHash, scene: nextScenesHash })
          setAssetReviewBusy(false)
          if (!keepView) {
            setAssetTypeFilter('全部')
            setAssetQuery('')
            setAssetSelectedId(null)
            setAssetImageIndex(0)
            setAssetView('cards')
            setVisualType('all')
            setVisualQuery('')
            setVisualSort('id-asc')
            setVisualLightbox(null)
            setVisualAudioIndex({})
            setVisualGroupCollapsed({})
            setAssetReviewKind('asset')
            setAssetReviewStatusFilter('all')
            setAssetReviewTypeFilter('全部')
            setAssetReviewQuery('')
            setAssetReviewSelectedId('')
            setAssetReviewPrompt('')
            setAssetReviewPromptError('')
            setAssetReviewReason('')
            setAssetReviewReasonError('')
            setAssetReviewDialog(null)
          }
          setAssetReviewError('')
          // 审核视图刷新后：同步当前选中卡的已保存提示词（保留视图/筛选）
          if (keepView) {
            const keepKindCards = assetReviewKind === 'scene' ? normalizeVisualScenes(result.scenes) : cards
            const keepTarget = keepKindCards.find((item) => String(item.id || '').toUpperCase() === String(assetReviewSelectedId || '').toUpperCase())
            if (keepTarget && keepTarget.review) setAssetReviewPrompt(keepTarget.review.currentPrompt)
          }
          assetImageLoadState.clear()
          setAssetImageCache({})
          ensureAssetImages(assetCardImagePaths(cards))
        })

      /* v0.16.9（C3-C / E16+H-8）：资产/场景卡审核动作层（唯一 asset-save 调用点；面板审核动作） */
      const assetReviewKindCardsOf = (kind) => {
        const list = kind === 'scene' ? visualScenes : assetCards
        return (Array.isArray(list) ? list : []).filter((item) => item && item.review)
      }
      const firstAssetReviewCardOf = (kind) => assetReviewKindCardsOf(kind)[0] || null
      const selectAssetReviewCard = (card) => {
        if (!card || !card.review) return
        setAssetReviewSelectedId(String(card.id || ''))
        setAssetReviewPrompt(card.review.currentPrompt)
        setAssetReviewPromptError('')
        setAssetReviewReason('')
        setAssetReviewReasonError('')
        setAssetReviewDialog(null)
        setAssetReviewError('')
        setAssetReviewNotice('')
      }
      const selectFirstAssetReviewCard = () => {
        const first = firstAssetReviewCardOf(assetReviewKind)
        if (first) selectAssetReviewCard(first)
      }
      const assetReviewSelectedCardOf = () => assetReviewKindCardsOf(assetReviewKind).find((item) => String(item.id || '').toUpperCase() === String(assetReviewSelectedId || '').toUpperCase()) || null
      const assetReviewExpectedHashOf = (kind) => (kind === 'scene' ? assetReviewHashes.scene : assetReviewHashes.asset)
      const assetReviewApplyResult = (result, action) => {
        if (!result || typeof result !== 'object') return
        const nextReview = normalizeAssetReview(result.review)
        if (nextReview) {
          const targetId = String(result.id || '').toUpperCase()
          if (result.kind === 'scene') {
            setVisualScenes((prev) => prev.map((item) => (String(item.id || '').toUpperCase() === targetId ? { ...item, review: nextReview } : item)))
          } else {
            setAssetCards((prev) => prev.map((item) => (String(item.id || '').toUpperCase() === targetId ? { ...item, review: nextReview } : item)))
          }
          setAssetReviewPrompt(nextReview.currentPrompt)
        }
        const nextHash = typeof result.hash === 'string' ? result.hash : ''
        setAssetReviewHashes((prev) => ({ ...prev, [result.kind === 'scene' ? 'scene' : 'asset']: nextHash }))
        setAssetReviewBusy(false)
        setAssetReviewPromptError('')
        setAssetReviewReason('')
        setAssetReviewReasonError('')
        setAssetReviewDialog(null)
        setAssetReviewError('')
        setAssetReviewNotice(ASSET_REVIEW_ACTION_NOTICES[action] || '审核操作已完成')
      }
      const assetReviewActionError = (error) => {
        const code = String((error && error.code) || '')
        const message = String((error && error.message) || '审核操作失败')
        const refreshWithNotice = (notice) => {
          setAssetReviewNotice(notice)
          loadAssets({ keepView: true }).then(() => { setAssetReviewNotice(notice) }).catch(() => { setAssetReviewNotice(notice) })
        }
        if (code === 'asset-locked') {
          say('作品已定稿，需重打开后才能修改')
          refreshWithNotice('作品已定稿，需重打开后才能修改（已刷新审核状态）')
          return
        }
        if (code === 'conflict') {
          say('资产卡已被其他写入修改，已刷新')
          refreshWithNotice('资产卡已被其他写入修改，已刷新，请重试')
          return
        }
        if (code === 'state-conflict') {
          say('当前审核状态不允许该操作，已刷新')
          refreshWithNotice('当前审核状态不允许该操作，已刷新')
          return
        }
        if (code === 'not-found') {
          say('项目或卡不存在，已刷新列表')
          loadAssets({ keepView: true }).catch(() => {})
          return
        }
        if (code === 'forbidden') {
          setAssetReviewError('无审核权限：审核动作仅面板可用')
          return
        }
        if (code === 'invalid-args') {
          if (assetReviewDialog && assetReviewDialog.type !== 'finalize') setAssetReviewReasonError(message)
          else setAssetReviewPromptError(message)
          return
        }
        setAssetReviewError(message)
      }
      const runAssetReviewAction = async (action) => {
        if (assetReviewBusy || !openTitle) return false
        const target = assetReviewSelectedCardOf()
        if (!target || !target.review) {
          setAssetReviewError('请先选择要审核的卡片')
          return false
        }
        const expectedHash = assetReviewExpectedHashOf(assetReviewKind)
        if (!expectedHash) {
          setAssetReviewError('缺少 cards.json / scenes cards.json 的 hash：请刷新素材库后重试')
          return false
        }
        const payload = {
          title: openTitle,
          kind: assetReviewKind,
          id: target.id,
          action,
          expectedHash,
        }
        if (action === 'saveDraft') {
          const prompt = String(assetReviewPrompt || '').trim()
          const promptError = assetReviewPromptIssue(prompt)
          if (promptError) {
            setAssetReviewPromptError(promptError)
            return false
          }
          payload.prompt = prompt
        }
        if (action === 'submit' && String(assetReviewPrompt || '').trim() !== String(target.review.currentPrompt || '').trim()) {
          setAssetReviewPromptError('有未保存提示词修改：请先保存草稿，再提交审核')
          return false
        }
        if (action === 'reject' || action === 'reopen') {
          const reason = String(assetReviewReason || '').trim()
          const reasonError = assetReviewReasonIssue(reason)
          if (reasonError) {
            setAssetReviewReasonError(reasonError)
            return false
          }
          payload.reason = reason
        }
        setAssetReviewBusy(true)
        setAssetReviewError('')
        setAssetReviewNotice('')
        try {
          const result = await api('asset-save', payload)
          assetReviewApplyResult(result, action)
          say(ASSET_REVIEW_ACTION_NOTICES[action] || '审核操作已完成')
          return true
        } catch (error) {
          assetReviewActionError(error)
          return false
        } finally {
          setAssetReviewBusy(false)
        }
      }
      const openAssetReviewDialog = (type) => {
        if (assetReviewBusy) return
        setAssetReviewDialog({ type })
        setAssetReviewReason('')
        setAssetReviewReasonError('')
        setAssetReviewError('')
        setAssetReviewNotice('')
      }
      const closeAssetReviewDialog = () => {
        if (assetReviewBusy) return
        setAssetReviewDialog(null)
        setAssetReviewReason('')
        setAssetReviewReasonError('')
        setAssetReviewError('')
      }
      const confirmAssetReviewDialog = () => {
        if (!assetReviewDialog || assetReviewBusy) return
        const type = assetReviewDialog.type
        if (type === 'reject') runAssetReviewAction('reject').catch(() => {})
        else if (type === 'finalize') runAssetReviewAction('finalize').catch(() => {})
        else if (type === 'reopen') runAssetReviewAction('reopen').catch(() => {})
      }

      const addAsset = () =>
        guard(async () => {
          const source = assetSource.trim()
          if (!source) return
          const linkedShots = assetShots.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean)
          setAssetAddError('')
          try {
            await api('assets-add', { title: openTitle, source, linkedShots })
          } catch (err) {
            // v0.15.8（task-126 / EXT-C1）：外部路径拒绝 → 登记区固定文案（不显示项目外绝对路径）；其它错误沿用全局展示
            const message = String((err && err.message) || '')
            const outsideProject = Boolean(err && (err.code === 'forbidden' || OUTSIDE_PROJECT_MESSAGE_PATTERN.test(message)))
            if (outsideProject) {
              setAssetAddError(OUTSIDE_PROJECT_HINT)
              setAssetRegistrationOpen(true)
              return false
            }
            const nextError = new Error(hideProjectExternalPaths(message, projectRoot) || '素材登记失败')
            nextError.code = (err && err.code) || 'failed'
            throw nextError
          }
          setAssetSource('')
          setAssetShots('')
          setAssetAddError('')
          await loadAssets()
          say('素材已登记')
        })

      const removeAsset = (id) =>
        guard(async () => {
          await api('assets-remove', { title: openTitle, id })
          await loadAssets()
          say('已移除')
        })

      // v0.15.9（task-129 / D2C-C）：扫描素材目录 + 勾选批量登记（串行；复用既有 assets-get 加参 + assets-add；不移动文件）
      const openScanPanel = () => {
        if (scanSupported !== true || scanBatchBusy) return
        if (registryOk === false) {
          say(REGISTRY_DISABLED_ACTION_TEXT)
          return
        }
        setScanSummary(null)
        setScanOpen(true)
        loadAssets({ scan: true }).catch(() => {})
      }
      const closeScanPanel = () => {
        if (scanBatchBusy) return
        setScanOpen(false)
        setScanSummary(null)
      }
      const toggleScanFile = (pathValue) => {
        setScanSelected((prev) => ({ ...prev, [pathValue]: !prev[pathValue] }))
      }
      const toggleScanAll = (visibleFiles) => {
        const list = Array.isArray(visibleFiles) ? visibleFiles : []
        const shouldSelect = list.length > 0 && list.every((file) => Boolean(scanSelected[file.path]))
        setScanSelected((prev) => {
          const next = { ...prev }
          for (const file of list) {
            if (shouldSelect) delete next[file.path]
            else next[file.path] = true
          }
          return next
        })
      }
      const runScanBatch = async () => {
        if (scanBatchBusy) return
        if (registryOk === false) {
          say(REGISTRY_DISABLED_ACTION_TEXT)
          return
        }
        const targets = scanFiles.filter((file) => Boolean(scanSelected[file.path]))
        if (!targets.length) return
        setScanBatchBusy(true)
        setScanSummary(null)
        setScanProgress({ done: 0, total: targets.length })
        const failed = []
        let ok = 0
        try {
          for (let i = 0; i < targets.length; i += 1) {
            const file = targets[i]
            try {
              await api('assets-add', { title: openTitle, source: file.path, name: file.name, kind: file.kind || 'other' })
              ok += 1
            } catch (err) {
              failed.push({ path: file.path, reason: hideProjectExternalPaths(String((err && err.message) || '登记失败'), projectRoot) })
            }
            setScanProgress({ done: i + 1, total: targets.length })
          }
          // 失败项保留在扫描列表且默认勾选，可再次批量重试；成功项经重新扫描后消失
          setScanSelected(Object.fromEntries(failed.map((item) => [item.path, true])))
          setScanSummary({ ok, fail: failed })
          await loadAssets({ scan: true })
          say(`批量登记：成功 ${ok}${failed.length ? ` · 失败 ${failed.length}` : ''}`)
        } finally {
          setScanBatchBusy(false)
        }
      }

      const repairRegistry = () => {
        if (registryBusy || !openTitle) return
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(REGISTRY_REPAIR_CONFIRM)) return
        setRegistryBusy(true)
        setRegistryError('')
        api('assets-add', { title: openTitle, repairRegistry: true })
          .then(async (result) => {
            const notice = m3RepairNotice(result)
            setRegistryNotice(notice)
            say(notice)
            try {
              await loadAssets({ scan: true })
            } catch { /* 刷新失败不阻断修复结果 */ }
          })
          .catch(() => {
            setRegistryError(REGISTRY_REPAIR_FAIL_TEXT)
          })
          .finally(() => {
            setRegistryBusy(false)
          })
      }
      // v0.15.11（task-135 / IMP-C）：一键导入（file input/拖拽 → 串行 assets-import；不移动源文件）
      const openImportPanel = () => {
        if (importSupported !== true || importBusy) return
        if (registryOk === false) {
          say(REGISTRY_DISABLED_ACTION_TEXT)
          return
        }
        setImportOpen(true)
        setImportSummary(null)
      }
      const closeImportPanel = () => {
        if (importBusy) return
        setImportOpen(false)
      }
      const pickImportFiles = () => {
        if (importBusy) return
        const input = typeof document !== 'undefined' && typeof document.getElementById === 'function' ? document.getElementById('ad-import-file-input') : null
        if (input && typeof input.click === 'function') input.click()
      }
      const addImportFiles = (fileList) => {
        if (importBusy) return
        const incoming = Array.prototype.slice.call(fileList || [])
        if (!incoming.length) return
        setImportSummary(null)
        setImportQueue((prev) => {
          const next = prev.slice()
          let queuedCount = next.filter((entry) => entry.status === 'queued').length
          for (const file of incoming) {
            const name = String((file && file.name) || '').trim() || '未命名文件'
            const size = Number(file && file.size) || 0
            const kind = importKindOf(name)
            const item = { id: `imp-${(importFileSeq += 1)}`, name, size, kindLabel: kind ? IMPORT_KIND_LABELS[kind] : '未知类型', status: 'queued', reason: '', file }
            if (size > IMPORT_MAX_BYTES) {
              item.status = 'too-large'
              item.reason = '超过 50MB，不会导入'
              item.file = null
            } else if (!kind) {
              item.status = 'unsupported'
              item.reason = '不支持的类型'
              item.file = null
            } else if (queuedCount >= IMPORT_MAX_BATCH) {
              item.status = 'limit'
              item.reason = `单批最多 ${IMPORT_MAX_BATCH} 个，请分批导入`
              item.file = null
            } else {
              queuedCount += 1
            }
            next.push(item)
          }
          return next
        })
      }
      const removeImportItem = (id) => {
        if (importBusy) return
        setImportQueue((prev) => prev.filter((item) => item.id !== id))
      }
      const clearImportQueue = () => {
        if (importBusy) return
        setImportQueue([])
        setImportSummary(null)
        setImportProgress({ done: 0, total: 0 })
      }
      const runImportBatch = async (retryOnly) => {
        if (importBusy) return
        if (registryOk === false) {
          say(REGISTRY_DISABLED_ACTION_TEXT)
          return
        }
        const targets = importQueue.filter((item) => (retryOnly ? item.status === 'fail' : item.status === 'queued'))
        if (!targets.length) return
        setImportBusy(true)
        setImportSummary(null)
        setImportProgress({ done: 0, total: targets.length })
        const failed = []
        let ok = 0
        let duplicate = 0
        let methodMissing = false
        for (let i = 0; i < targets.length; i += 1) {
          const item = targets[i]
          setImportQueue((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, status: 'importing', reason: '' } : entry)))
          try {
            // 内存策略：先读 ArrayBuffer 算 sha → 释放；再 readAsDataURL 得 base64；请求后释放引用（不预读、不缓存）
            const expectedSha256 = await importSha256Of(item.file)
            const base64 = await importReadBase64(item.file)
            const payload = { title: openTitle, fileName: item.name, base64 }
            if (importCategory) payload.targetCategory = importCategory
            if (expectedSha256) payload.expectedSha256 = expectedSha256
            await api('assets-import', payload)
            ok += 1
            setImportQueue((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, status: 'ok', reason: '', file: null } : entry)))
          } catch (err) {
            const code = String((err && err.code) || 'failed')
            const message = String((err && err.message) || '导入失败')
            if (code === 'not-found' && /未知方法|未注册|不支持/.test(message)) {
              // 防御旧包误判：方法缺失 → 隐藏入口并提示升级
              methodMissing = true
              setImportSupported(false)
              setImportOpen(false)
              say('当前插件版本不支持导入素材，请升级插件后重试')
              break
            }
            let status = 'fail'
            let reason = hideProjectExternalPaths(message, projectRoot)
            if (code === 'conflict') {
              status = 'duplicate'
              reason = '已存在（相同内容或同名文件），未重复写入'
              duplicate += 1
            } else {
              if (code === 'too-large') reason = '文件过大（服务端拒绝）'
              failed.push({ id: item.id, name: item.name, reason })
            }
            setImportQueue((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, status, reason } : entry)))
          }
          setImportProgress({ done: i + 1, total: targets.length })
        }
        setImportSummary({ ok, duplicate, fail: failed })
        try {
          if (!methodMissing) await loadAssets({ scan: true })
        } finally {
          setImportBusy(false)
        }
        if (!methodMissing) say(`导入完成：成功 ${ok}${duplicate ? ` · 已存在 ${duplicate}` : ''}${failed.length ? ` · 失败 ${failed.length}` : ''}`)
      }
      const retryFailedImports = () => {
        if (importBusy) return
        runImportBatch(true).catch(() => {})
      }

      // v0.16.x（C2-C 原型）：跨项目资产复用（只读源项目 assets-get → assets-import B-1 复制；调用点不新增）
      const crossProjectOptions = (projects || []).filter((item) => item && item.title && item.title !== openTitle)
      const crossQueryText = crossQuery.trim().toLowerCase()
      const crossVisibleAssets = crossAssets.filter((asset) =>
        !crossQueryText || `${asset.id} ${asset.name} ${asset.category}`.toLowerCase().includes(crossQueryText))
      const crossSelectedIds = Object.keys(crossSelected).filter((id) => Boolean(crossSelected[id]))
      const crossSelectedCount = crossSelectedIds.length
      const crossAllSelected = crossVisibleAssets.length > 0 && crossVisibleAssets.every((asset) => Boolean(crossSelected[asset.id]))
      const crossSelectedBytes = crossAssets.filter((asset) => crossSelected[asset.id]).reduce((sum, asset) => sum + asset.bytes, 0)
      const crossCapabilityHint = crossProjectOptions.length
        ? '只读源项目；复制到当前项目「素材/<分类>/」并自动登记（不移动源项目文件）'
        : '当前工作区还没有其他项目；先新建或打开另一个项目后再试。'
      // v0.16.8（I5-1-C）：tabs 选择/冲突/汇总（只读源项目；assets-import add-only；调用点 71 不增）
      const crossVisibleCards = crossCards.filter((card) =>
        !crossQueryText || `${card.id} ${card.name} ${card.type}`.toLowerCase().includes(crossQueryText))
      const crossVisibleScenes = crossScenes.filter((scene) =>
        !crossQueryText || `${scene.id} ${scene.name} ${scene.summary}`.toLowerCase().includes(crossQueryText))
      const crossSelectedCardIds = Object.keys(crossCardSelected).filter((id) => crossCardSelected[id])
      const crossSelectedSceneIds = Object.keys(crossSceneSelected).filter((id) => crossSceneSelected[id])
      const crossSelectedCardCount = crossSelectedCardIds.length
      const crossSelectedSceneCount = crossSelectedSceneIds.length
      const crossAllCardsSelected = crossVisibleCards.length > 0 && crossVisibleCards.every((card) => crossCardSelected[card.id])
      const crossAllScenesSelected = crossVisibleScenes.length > 0 && crossVisibleScenes.every((scene) => crossSceneSelected[scene.id])
      const crossTotalSelected = crossSelectedCount + crossSelectedCardCount + crossSelectedSceneCount + (crossCopyStyleDNA ? 1 : 0)
      const crossStyleDims = crossStyle ? Object.keys(crossStyle).length : 0
      const crossTargetStyleDims = visualStyle ? Object.keys(visualStyle).filter((key) => visualStyle[key]).length : 0
      const crossObjectConflict = (sourceList, targetList, signatureOf) => {
        const target = new Map()
        for (const item of Array.isArray(targetList) ? targetList : []) {
          if (item && item.id) target.set(item.id, item)
        }
        const same = []
        const diff = []
        for (const item of sourceList) {
          if (!target.has(item.id)) continue
          const left = signatureOf(item.instance || item)
          const right = signatureOf(target.get(item.id))
          if (left && left === right) same.push(item)
          else diff.push(item)
        }
        return { same, diff }
      }
      const resetCrossSourceState = () => {
        setCrossAssets([])
        setCrossCards([])
        setCrossScenes([])
        setCrossStyle(null)
        setCrossSelected({})
        setCrossCardSelected({})
        setCrossSceneSelected({})
        setCrossCopyStyleDNA(false)
        setCrossCopyMedia(true)
        setCrossAllowNewIdSuffix(false)
        setCrossOverwriteStyle(false)
        setCrossWarnings([])
        setCrossSummary(null)
        setCrossLoadError('')
        setCrossQuery('')
      }
      const openCrossPanel = () => {
        if (!openTitle) return
        if (registryOk === false) {
          say(REGISTRY_DISABLED_ACTION_TEXT)
          return
        }
        setCrossOpen((prev) => {
          const next = !prev
          if (!next) resetCrossSourceState()
          return next
        })
      }
      const closeCrossPanel = () => {
        if (crossBusy) return
        setCrossOpen(false)
        setCrossSourceTitle('')
        resetCrossSourceState()
      }
      const loadCrossSource = (title) => {
        const sourceTitle = String(title == null ? '' : title).trim()
        setCrossSourceTitle(sourceTitle)
        resetCrossSourceState()
        if (!sourceTitle || crossBusy) return Promise.resolve()
        setCrossLoading(true)
        return api('assets-get', { title: sourceTitle })
          .then((result) => {
            setCrossAssets(normalizeCrossAssets(result && result.assets))
            setCrossCards(crossObjectsSupported === true ? normalizeCrossCards(result && result.cards) : [])
            setCrossScenes(crossObjectsSupported === true ? normalizeCrossScenes(result && result.scenes) : [])
            setCrossStyle(crossObjectsSupported === true ? normalizeCrossStyle(result && result.styleDNA) : null)
          })
          .catch((error) => {
            setCrossLoadError('读取源项目资产失败：' + crossImportErrorText(error))
          })
          .finally(() => {
            setCrossLoading(false)
          })
      }
      const toggleCrossAsset = (id) => {
        if (crossBusy) return
        setCrossSelected((prev) => ({ ...prev, [id]: !prev[id] }))
      }
      const toggleAllCrossAssets = () => {
        if (crossBusy) return
        setCrossSelected((prev) => {
          if (crossAllSelected) {
            const next = { ...prev }
            crossVisibleAssets.forEach((asset) => { delete next[asset.id] })
            return next
          }
          if (crossVisibleAssets.length > CROSS_IMPORT_MAX_BATCH) {
            say(`单批最多 ${CROSS_IMPORT_MAX_BATCH} 个；已选择前 ${CROSS_IMPORT_MAX_BATCH} 个`)
          }
          const next = { ...prev }
          crossVisibleAssets.slice(0, CROSS_IMPORT_MAX_BATCH).forEach((asset) => { next[asset.id] = true })
          return next
        })
      }
      const clearCrossSelection = () => {
        if (crossBusy) return
        setCrossSelected({})
      }
      const toggleCrossCard = (id) => {
        if (crossBusy) return
        setCrossCardSelected((prev) => ({ ...prev, [id]: !prev[id] }))
      }
      const toggleAllCrossCards = () => {
        if (crossBusy) return
        setCrossCardSelected((prev) => {
          if (crossAllCardsSelected) {
            const next = { ...prev }
            crossVisibleCards.forEach((card) => { delete next[card.id] })
            return next
          }
          if (crossVisibleCards.length > CROSS_OBJECT_BATCH) say(`单批最多 ${CROSS_OBJECT_BATCH} 个；已选择前 ${CROSS_OBJECT_BATCH} 个`)
          const next = { ...prev }
          crossVisibleCards.slice(0, CROSS_OBJECT_BATCH).forEach((card) => { next[card.id] = true })
          return next
        })
      }
      const clearCrossCardSelection = () => {
        if (crossBusy) return
        setCrossCardSelected({})
      }
      const toggleCrossScene = (id) => {
        if (crossBusy) return
        setCrossSceneSelected((prev) => ({ ...prev, [id]: !prev[id] }))
      }
      const toggleAllCrossScenes = () => {
        if (crossBusy) return
        setCrossSceneSelected((prev) => {
          if (crossAllScenesSelected) {
            const next = { ...prev }
            crossVisibleScenes.forEach((scene) => { delete next[scene.id] })
            return next
          }
          if (crossVisibleScenes.length > CROSS_OBJECT_BATCH) say(`单批最多 ${CROSS_OBJECT_BATCH} 个；已选择前 ${CROSS_OBJECT_BATCH} 个`)
          const next = { ...prev }
          crossVisibleScenes.slice(0, CROSS_OBJECT_BATCH).forEach((scene) => { next[scene.id] = true })
          return next
        })
      }
      const clearCrossSceneSelection = () => {
        if (crossBusy) return
        setCrossSceneSelected({})
      }
      const buildCrossSummary = (result, requested) => {
        const styleRaw = requested.style ? (result && result.style) || { copied: true } : null
        const styleFailed = styleRaw && styleRaw.failed && styleRaw.failed.code ? styleRaw.failed : null
        const summary = {
          requested,
          assets: requested.assets
            ? crossCounts({ imported: result && result.imported, skipped: result && result.skipped, failed: result && result.failed }, 'assets', (id) => (crossAssets.find((item) => item.id === id) || {}).name)
            : null,
          cards: requested.cards
            ? crossCounts(result && result.cards, 'cards', (id) => (crossCards.find((item) => item.id === id) || {}).name)
            : null,
          scenes: requested.scenes
            ? crossCounts(result && result.scenes, 'scenes', (id) => (crossScenes.find((item) => item.id === id) || {}).name)
            : null,
          style: styleRaw
            ? (styleFailed
                ? { ...styleRaw, code: styleFailed.code, error: crossImportErrorText({ code: styleFailed.code, message: styleFailed.reason || '' }) }
                : styleRaw)
            : null,
          warnings: sanitizeCrossWarnings(result && result.warnings),
          idMap: Object.assign({}, (result && result.cards && result.cards.idMap) || {}, (result && result.scenes && result.scenes.idMap) || {}),
        }
        return summary
      }
      const runCrossImport = async () => {
        if (crossBusy || !crossSourceTitle) return
        if (registryOk === false) {
          say(REGISTRY_DISABLED_ACTION_TEXT)
          return
        }
        const assetIds = Object.keys(crossSelected).filter((id) => crossSelected[id])
        const cardIds = crossObjectsSupported === true ? crossSelectedCardIds.slice() : []
        const sceneIds = crossObjectsSupported === true ? crossSelectedSceneIds.slice() : []
        const wantsStyle = crossObjectsSupported === true && crossCopyStyleDNA === true
        if (!assetIds.length && !cardIds.length && !sceneIds.length && !wantsStyle) {
          say('请先选择要导入的素材/资产卡/场景卡或勾选复制风格 DNA')
          return
        }
        if (assetIds.length > CROSS_IMPORT_MAX_BATCH || cardIds.length > CROSS_OBJECT_BATCH || sceneIds.length > CROSS_OBJECT_BATCH) {
          say(`单批上限：素材 ${CROSS_IMPORT_MAX_BATCH}、资产卡/场景卡 ${CROSS_OBJECT_BATCH}`)
          return
        }
        setCrossBusy(true)
        setCrossSummary(null)
        setCrossWarnings([])
        const requested = { assets: assetIds.length > 0, cards: cardIds.length > 0, scenes: sceneIds.length > 0, style: wantsStyle }
        let capabilityMissing = false
        try {
          const payload = { title: openTitle, sourceProjectId: crossSourceTitle }
          if (requested.assets) {
            payload.sourceAssetIds = assetIds
            if (crossCategory) payload.targetCategory = crossCategory
          }
          if (requested.cards) {
            payload.sourceCardIds = cardIds
            payload.copyMedia = crossCopyMedia
            payload.allowNewIdSuffix = crossAllowNewIdSuffix
          }
          if (requested.scenes) {
            payload.sourceSceneIds = sceneIds
            payload.allowNewIdSuffix = crossAllowNewIdSuffix
          }
          if (requested.style) {
            payload.copyStyleDNA = true
            payload.overwriteStyle = crossOverwriteStyle
          }
          let result = null
          try {
            result = await api('assets-import', payload)
          } catch (error) {
            const code = String((error && error.code) || 'failed')
            const message = String((error && error.message) || '')
            if (code === 'not-found' && /未知方法|未注册|不支持/.test(message)) {
              capabilityMissing = true
              setCrossSupported(false)
              setCrossOpen(false)
              say('当前插件版本不支持跨项目导入，请升级插件后重试')
            } else {
              const reason = crossImportErrorText(error)
              const mk = (list, kind) => ({ ok: 0, duplicate: 0, fail: list.map((item) => ({ kind, sourceId: item.id, name: item.name, reason })) })
              setCrossSummary({
                requested,
                assets: requested.assets ? mk(crossAssets.filter((item) => crossSelected[item.id]), 'assets') : null,
                cards: requested.cards ? mk(crossCards.filter((item) => crossCardSelected[item.id]), 'cards') : null,
                scenes: requested.scenes ? mk(crossScenes.filter((item) => crossSceneSelected[item.id]), 'scenes') : null,
                style: requested.style ? { copied: false, merge: 'skip', copiedDims: [], error: reason } : null,
                warnings: [],
                idMap: {},
              })
            }
          }
          if (!capabilityMissing && result) {
            const summary = buildCrossSummary(result, requested)
            setCrossSummary(summary)
            setCrossWarnings(summary.warnings)
            setCrossSelected({})
            setCrossCardSelected({})
            setCrossSceneSelected({})
            setCrossCopyStyleDNA(false)
            try {
              await loadAssets({ scan: true })
            } catch { /* 刷新失败不阻断汇总 */ }
            const parts = []
            if (summary.assets) parts.push(`素材 成功 ${summary.assets.ok}${summary.assets.duplicate ? ` · 已存在 ${summary.assets.duplicate}` : ''}${summary.assets.fail.length ? ` · 失败 ${summary.assets.fail.length}` : ''}`)
            if (summary.cards) parts.push(`资产卡 成功 ${summary.cards.ok}${summary.cards.duplicate ? ` · 已存在 ${summary.cards.duplicate}` : ''}${summary.cards.fail.length ? ` · 失败 ${summary.cards.fail.length}` : ''}`)
            if (summary.scenes) parts.push(`场景卡 成功 ${summary.scenes.ok}${summary.scenes.duplicate ? ` · 已存在 ${summary.scenes.duplicate}` : ''}${summary.scenes.fail.length ? ` · 失败 ${summary.scenes.fail.length}` : ''}`)
            if (summary.style) parts.push(`风格 ${summary.style.copied === false ? '已跳过' : summary.style.merge === 'overwrite' ? '已覆盖' : summary.style.merge === 'skip' ? '已跳过' : '已合并'}`)
            say(`跨项目导入完成：${parts.join('；')}`)
          }
        } finally {
          setCrossBusy(false)
        }
      }
      const retryCrossFailed = async () => {
        if (crossBusy || !crossSummary) return
        const fails = []
        for (const key of ['assets', 'cards', 'scenes']) {
          const entry = crossSummary[key]
          if (entry && Array.isArray(entry.fail)) fails.push(...entry.fail)
        }
        if (!fails.length) return
        const nextAssets = {}
        const nextCards = {}
        const nextScenes = {}
        for (const item of fails) {
          if (item.kind === 'assets') nextAssets[item.sourceId] = true
          else if (item.kind === 'cards') nextCards[item.sourceId] = true
          else if (item.kind === 'scenes') nextScenes[item.sourceId] = true
        }
        setCrossSelected(nextAssets)
        setCrossCardSelected(nextCards)
        setCrossSceneSelected(nextScenes)
        if (crossObjectsSupported === true) {
          if (Object.keys(nextCards).length) setCrossTab('cards')
          else if (Object.keys(nextScenes).length) setCrossTab('scenes')
          else setCrossTab('assets')
        }
        setCrossSummary(null)
        setCrossWarnings([])
        say('已选失败项；再点「开始导入」重试')
      }

      /* ------------------------------------------------------------ 定稿 */

      const loadFinalized = () =>
        guard(async () => {
          const result = await api('finalized-list', { title: openTitle })
          setFinalized(result.finalized || [])
        })

      const finalizeEpisode = () =>
        guard(async () => {
          const result = await api('finalize-episode', { title: openTitle, order: episodeOrder })
          await loadFinalized()
          say(`第 ${result.finalized.order} 集已定稿 v${result.finalized.version}（${
            (result.finalized.files || []).length ? result.finalized.files.join('、') : '快照已落盘'
          }）`)
        })

      const restoreFinalized = (order, version) =>
        guard(async () => {
          if (!window.confirm(`把第 ${order} 集回滚到 v${version}？\n\n当前剧本与分镜会被该版本覆盖（覆盖前会自动留一份历史快照）。`)) return
          const result = await api('finalized-restore', { title: openTitle, order, version })
          const [ep, sb] = await Promise.all([
            api('episode-read', { title: openTitle, order }),
            api('storyboard-get', { title: openTitle, order }),
          ])
          // 回滚后本地内容 = 磁盘该版本内容：同步载入态（否则空覆盖守卫会拦截后续保存）
          applyEpisodeLoaded(Number(order) || 1, ep.text || '')
          applyShotsLoaded(Number(order) || 1, sb)
          setSaveBlock(null)
          say(`已回滚第 ${order} 集到 v${version}：${result.restored.restored.join('、')}`)
        })

      // P1-D：指定版本回滚（宿主 finalized-restore 已支持 version；面板此前只能回滚「最新」）
      const restoreFinalizedVersion = (record) =>
        guard(async () => {
          const latest = Number(record.version) || 1
          const raw = window.prompt(
            `第 ${record.order} 集回滚到哪个版本？\n\n已有版本：v1 ~ v${latest}（最新）\n回滚会用该版本覆盖当前剧本与分镜，覆盖前自动留快照。`,
            String(latest),
          )
          if (raw == null) return
          const version = Number(raw)
          if (!Number.isInteger(version) || version < 1 || version > latest) {
            throw new Error(`版本号需为 1~${latest} 之间的整数`)
          }
          if (!window.confirm(`确认把第 ${record.order} 集回滚到 v${version}？`)) return
          await restoreFinalized(record.order, version)
        })

      /* ------------------------------------------------------ 账本 / 导入 */

      const loadLedger = (options) =>
        guard(async () => {
          const renderFile = Boolean(options && options.renderFile === true)
          try {
            const result = await api('ledger-get', { title: openTitle, ...(renderFile ? { renderFile: true } : {}) })
            setLedger(result.ledger)
            if (renderFile) {
              if (result && result.rendered === true) {
                setLedgerRendered(true)
                say('已渲染到项目账本')
              } else {
                setLedgerRendered(false)
                say(LEDGER_RENDER_FAIL_TEXT)
              }
            } else {
              setLedgerRendered(false)
            }
          } catch (error) {
            if (!renderFile) throw error
            const code = String((error && error.code) || '')
            const message = String((error && error.message) || '')
            if (code === 'invalid-args' && /renderFile|未知|不支持/.test(message)) {
              setM3Supported(false)
              say('当前插件版本不支持渲染账本文件，已保持只读')
            } else {
              say(LEDGER_RENDER_FAIL_TEXT)
            }
          }
        })
      const renderLedgerFile = () => loadLedger({ renderFile: true })

      const previewImport = () =>
        guard(async () => {
          const result = await api('import-preview', { text: importText })
          setImportPreview(result)
        })

      const applyImport = () =>
        guard(async () => {
          if (!openTitle) return
          const result = await api('import-apply', { title: openTitle, text: importText })
          setImportPreview(result)
          const eps = await api('episodes-list', { title: openTitle })
          setEpisodes(eps.episodes || [])
          say(`已导入 ${result.written.length} 集${result.skipped.length ? `，跳过 ${result.skipped.length} 集` : ''}`)
        })

      /* ------------------------------------------------------ 阶段二生成 */

      const loadGenerate = () =>
        guard(async () => {
          const [status, budget, tasks] = await Promise.all([
            api('canvas-status', { title: openTitle, backend: 'libtv' }),
            api('budget-get', { title: openTitle }),
            api('tasks-list', { title: openTitle }),
          ])
          setGenCanvas(status)
          setGenBudget(budget.budget)
          setGenTasks(tasks.tasks || [])
          setGenBackends(status.canvases || [])
        })

      const bindCanvas = (uuid) =>
        guard(async () => {
          if (!window.confirm('把本项目绑定到这张画布？\n\n绑定后本项目下的生成都会落到该画布。')) return
          const result = await api('canvas-bind', { title: openTitle, backend: 'libtv', uuid })
          setGenCanvas((prev) => ({ ...(prev || {}), binding: result.binding }))
          await loadGenerate()
          say('已绑定画布')
        })

      const saveBudget = () =>
        guard(async () => {
          const raw = genLimit.trim()
          const limit = raw === '' ? null : Number(raw)
          if (raw !== '' && (!Number.isFinite(limit) || limit < 0)) throw new Error('预算上限必须是非负数')
          const result = await api('budget-set', { title: openTitle, limitPoints: limit })
          setGenBudget(result.budget)
          say(limit == null ? '已取消预算上限' : `预算上限设为 ${limit}`)
        })

      const planBatch = () =>
        guard(async () => {
          const result = await api('plan-batch', {
            title: openTitle,
            plan: { episode: episodeOrder, kind: genKind, backend: 'libtv', model: genModel.trim() || undefined },
          })
          setGenPlan(result.plan)
          await loadGenerate()
          say(`已规划 ${result.plan.count} 项（未触发）`)
        })

      const submitBatch = () =>
        guard(async () => {
          if (!genPlan) return
          if (!window.confirm(`提交 ${genPlan.count} 项生成？\n\n这会真实消耗平台积分。提交前请确认该画布的网页端已关闭。`)) return
          const result = await api('submit-batch', {
            title: openTitle,
            batch: { backend: 'libtv', kind: genKind, model: genModel.trim() || undefined, items: genPlan.items },
          })
          await loadGenerate()
          say(`已提交 ${result.submitted} 项${result.failed ? `，失败 ${result.failed} 项` : ''}`)
        })

      const collectBatch = () =>
        guard(async () => {
          const result = await api('collect-batch', { title: openTitle, batch: { backend: 'libtv' } })
          await loadGenerate()
          const drift = result.details && result.details.collected
          say(`收敛完成：产出 ${result.collected}，在途 ${result.pending}，失败 ${result.failed}${drift ? '' : ''}`)
        })

      /* ---------------- v0.12.2（task-20 / M4 批1）：5 条既有路由面板接线 ---------------- */
      // 全部为用户显式点击才调用（打开项目/切页签/刷新状态/loadList/loadGenerate 均不触发）：
      //   estimate-generation：后端目录/价目查询（不生成、不消耗）
      //   search-context：本地检索（无模型）
      //   canvas-reconcile：CLI 只读快照（不改画布）
      //   task-create / task-update：仅写 .aidrama/tasks.json 台账（不提交生成）
      const estimateGeneration = async () => {
        if (genEstimateBusy) return
        setGenEstimateBusy(true)
        setGenEstimate(null)
        try {
          const unitCount = Math.max(1, Array.isArray(shots) && shots.length ? shots.length : (genPlan && Number(genPlan.count)) || 1)
          const result = await api('estimate-generation', {
            title: openTitle,
            kind: genKind,
            model: genModel.trim() || undefined,
            count: unitCount,
            episode: episodeOrder,
          })
          setGenEstimate({ ...(result && typeof result === 'object' ? result : {}), unitCount })
        } catch (error) {
          setGenEstimate({ ok: false, estimates: [], error: error.message, unitCount: 0 })
        } finally {
          setGenEstimateBusy(false)
        }
      }

      const searchProjectContext = async () => {
        if (genSearchBusy) return
        const query = genSearchQuery.trim()
        if (!query) {
          setGenSearchResult({ emptyQuery: true, hits: [] })
          return
        }
        setGenSearchBusy(true)
        setGenSearchResult(null)
        try {
          const topK = Math.min(20, Math.max(1, Number(genSearchTopK) || 5))
          const result = await api('search-context', { title: openTitle, query, topK })
          setGenSearchResult(result && typeof result === 'object' ? result : { hits: [] })
        } catch (error) {
          setGenSearchResult({ hits: [], error: error.message })
        } finally {
          setGenSearchBusy(false)
        }
      }

      const reconcileCanvas = async () => {
        if (reconcileBusy) return
        setReconcileBusy(true)
        setReconcileResult(null)
        try {
          const result = await api('canvas-reconcile', { title: openTitle, backend: 'libtv', episode: episodeOrder })
          setReconcileResult(result && typeof result === 'object' ? result : { ok: false, reason: 'empty', detail: '对账返回为空' })
        } catch (error) {
          setReconcileResult({ ok: false, reason: 'error', detail: error.message })
        } finally {
          setReconcileBusy(false)
        }
      }

      const createTaskRecord = async () => {
        if (taskRecordBusy) return
        setTaskRecordBusy(true)
        setTaskNotice('')
        try {
          const result = await api('task-create', {
            title: openTitle,
            task: {
              kind: genKind,
              backend: taskRecordBackend,
              episode: episodeOrder,
              model: genModel.trim() || undefined,
              prompt: taskRecordPrompt.trim() || undefined,
            },
          })
          setTaskRecordPrompt('')
          setTaskNotice(result && result.task ? '已登记任务 ' + String(result.task.id || '') + '（仅台账，未提交生成）' : '已登记任务（仅台账，未提交生成）')
          const tasks = await api('tasks-list', { title: openTitle })
          setGenTasks((tasks && tasks.tasks) || [])
        } catch (error) {
          setTaskNotice('登记失败：' + error.message + '（不阻塞，可重试）')
        } finally {
          setTaskRecordBusy(false)
        }
      }

      const updateTaskStatus = async (task) => {
        if (taskRecordBusy || !task || !task.id) return
        setTaskRecordBusy(true)
        setTaskNotice('')
        try {
          const draft = taskStatusDraft[task.id] || task.status
          const result = await api('task-update', { title: openTitle, id: task.id, patch: { status: draft } })
          setTaskNotice(result && result.task ? '已更新任务状态：' + result.task.status + '（仅台账）' : '任务状态已更新（仅台账）')
          const tasks = await api('tasks-list', { title: openTitle })
          setGenTasks((tasks && tasks.tasks) || [])
        } catch (error) {
          setTaskNotice('更新失败：' + error.message + '（不阻塞，可重试）')
        } finally {
          setTaskRecordBusy(false)
        }
      }


      // v0.16.1（task-139 / C-6）：产物入库三模式 —— 本地文件→assets-import（不关联生成任务）；项目内路径/URL→intake-artifact（保持任务关联）
      const artifactMode = artifactModeOf(artifactFile, artifactSource)
      const pickArtifactFile = () => {
        if (artifactBusy || importSupported !== true) return
        const input = typeof document !== 'undefined' && typeof document.getElementById === 'function' ? document.getElementById('ad-artifact-file-input') : null
        if (input && typeof input.click === 'function') input.click()
      }
      const clearArtifactFile = () => {
        setArtifactFile(null)
        setArtifactFileName('')
        setArtifactFileSize(0)
        const input = typeof document !== 'undefined' && typeof document.getElementById === 'function' ? document.getElementById('ad-artifact-file-input') : null
        if (input) {
          try { input.value = '' } catch { /* 允许重新选择同一文件 */ }
        }
      }
      const pickArtifactFileChange = (event) => {
        if (artifactBusy) return
        const files = event && event.target && event.target.files ? Array.prototype.slice.call(event.target.files) : []
        if (!files.length) return
        const file = files[0]
        const name = String((file && file.name) || '').trim() || '未命名文件'
        const size = Number(file && file.size) || 0
        setArtifactResult(null)
        if (size > IMPORT_MAX_BYTES) {
          clearArtifactFile()
          setArtifactResult({ ok: false, error: ARTIFACT_LOCAL_TOO_LARGE, fixed: true })
          return
        }
        if (!importKindOf(name)) {
          clearArtifactFile()
          setArtifactResult({ ok: false, error: ARTIFACT_LOCAL_BAD_TYPE, fixed: true })
          return
        }
        setArtifactFile(file)
        setArtifactFileName(name)
        setArtifactFileSize(size)
        if (!artifactName.trim()) setArtifactName(name)
      }
      const importArtifactLocalFile = async () => {
        const file = artifactFile
        if (!file || artifactBusy) return
        setArtifactBusy(true)
        setArtifactResult(null)
        try {
          const expectedSha256 = await importSha256Of(file)
          const base64 = await importReadBase64(file)
          const category = artifactCategory || ARTIFACT_CATEGORY_DEFAULT
          const buildPayload = (withCategory) => {
            const payload = { title: openTitle, fileName: file.name, base64 }
            if (withCategory) payload.targetCategory = category
            if (expectedSha256) payload.expectedSha256 = expectedSha256
            return payload
          }
          let result
          let fallbackCategory = false
          try {
            result = await api('assets-import', buildPayload(true))
          } catch (error) {
            const code = String((error && error.code) || '')
            const raw = String((error && error.message) || '')
            // 兼容：host 尚未把「生成」加入 import 白名单 → 回退不带 targetCategory（host 默认 导入_YYYYMMDD）
            if (category === ARTIFACT_CATEGORY_DEFAULT && code === 'invalid-args' && /targetCategory|不支持|白名单|分类/.test(raw)) {
              result = await api('assets-import', buildPayload(false))
              fallbackCategory = true
            } else {
              throw error
            }
          }
          setArtifactResult({
            ok: true,
            relative: result && result.path ? String(result.path) : '',
            name: result && result.name ? String(result.name) : file.name,
            bytes: result && result.bytes != null ? result.bytes : file.size,
            sha256: result && result.sha256 ? String(result.sha256) : '',
            assetId: result && result.asset && result.asset.id ? String(result.asset.id) : '',
            fallbackCategory,
          })
          clearArtifactFile()
          say('本地文件已导入素材库')
          await loadAssets({ scan: true })
        } catch (error) {
          const code = String((error && error.code) || '')
          const raw = String((error && error.message) || '')
          let message = ''
          if (code === 'conflict') message = '素材已存在（相同内容），未重复导入'
          else if (code === 'too-large') message = ARTIFACT_LOCAL_TOO_LARGE
          else if (code === 'not-found' && /未知方法|未注册|不支持/.test(raw)) message = '当前插件版本不支持本地文件导入，请升级插件后重试'
          else message = '导入失败：' + hideProjectExternalPaths(raw || '未知错误', projectRoot)
          setArtifactResult({ ok: false, error: message, fixed: true })
        } finally {
          setArtifactBusy(false)
        }
      }
      // v0.12.3（task-21 / M4 批2）：产物入库 —— 项目内路径/URL 模式沿用既有 intake-artifact（保持任务关联语义）
      const intakeGeneratedArtifact = async () => {
        if (artifactBusy) return
        const mode = artifactModeOf(artifactFile, artifactSource)
        if (mode === 'file') {
          await importArtifactLocalFile()
          return
        }
        const source = artifactSource.trim()
        if (!source) {
          setArtifactResult({ ok: false, error: '请输入项目内路径或 http(s) 直链' })
          return
        }
        setArtifactBusy(true)
        setArtifactResult(null)
        try {
          const result = await api('intake-artifact', {
            title: openTitle,
            artifact: {
              ...(mode === 'url' ? { url: source } : { file: source }),
              kind: artifactKind,
              ...(artifactName.trim() ? { name: artifactName.trim() } : {}),
            },
          })
          setArtifactResult(result && typeof result === 'object' ? result : { ok: false, error: '入库返回为空' })
        } catch (error) {
          const fixed = mode === 'url' ? mapArtifactUrlError(error) : mapArtifactPathError(error)
          if (fixed) setArtifactResult({ ok: false, error: fixed, fixed: true })
          else setArtifactResult({ ok: false, error: '入库失败：' + hideProjectExternalPaths(String((error && error.message) || '未知错误'), projectRoot) })
        } finally {
          setArtifactBusy(false)
        }
      }

      /* ---------------------- v0.11.5（task-4 · P0-1）：未保存守卫 / 全局保存 / 关窗保护 ---------------------- */

      // 7 个可保存页签 → 保存函数映射（全局 Ctrl/⌘+S 按当前页签派发；文档栏聚焦时优先保存文档）
      const SAVEABLE_TABS = {
        contract: saveContract,
        outline: saveOutline,
        characters: saveCharacters,
        world: saveWorld,
        memory: saveMemory,
        episode: saveEpisode,
        storyboard: saveShots,
      }

      // 「保存并离开」：先保存全部脏 scope（文档 + 7 页签），任一失败则留在原处（错误/守卫提示由各自保存函数负责）
      const saveDirtyScopes = async () => {
        let allOk = true
        if (docDirty) {
          if (!docPath || docUnavailable) {
            say('文档尚未载入，无法保存文档修改')
            allOk = false
          } else {
            const docOk = await saveDoc()
            if (!docOk) allOk = false
          }
        }
        if (allOk) {
          for (const key of DIRTY_KEYS) {
            if (!dirty[key]) continue
            const saveFn = SAVEABLE_TABS[key]
            if (!saveFn) continue
            const ok = await saveFn()
            if (!ok) {
              allOk = false
              break
            }
          }
        }
        return allOk
      }

      const confirmLeaveSave = async () => {
        if (leaveSaving) return
        const action = leavePrompt && leavePrompt.action
        setLeaveSaving(true)
        try {
          const saved = await saveDirtyScopes()
          if (saved) {
            setLeavePrompt(null)
            if (typeof action === 'function') action()
          } else {
            // 保存被守卫拦截或失败：留在原处并关闭对话框，让用户看到面板内错误/守卫提示（不离开、不丢草稿）
            setLeavePrompt(null)
          }
        } finally {
          setLeaveSaving(false)
        }
      }
      const confirmLeaveDiscard = () => {
        if (leaveSaving) return
        const action = leavePrompt && leavePrompt.action
        resetAllDirty()
        setLeavePrompt(null)
        if (typeof action === 'function') action()
      }
      const cancelLeave = () => {
        if (!leaveSaving) setLeavePrompt(null)
      }

      // 焦点是否在右栏文档区内（含 textarea / 下拉 / 按钮；文档栏聚焦时 Ctrl/⌘+S 优先保存文档）
      const focusInsideDocPane = () => {
        try {
          const active = document.activeElement
          return Boolean(active && typeof active.closest === 'function' && active.closest('.ad-doc'))
        } catch {
          return false
        }
      }
      const saveCurrentTab = () => {
        if (busy) {
          say('正在处理中，请稍候…')
          return
        }
        const saveFn = phase === 'project' ? SAVEABLE_TABS[tab] : null
        if (!saveFn) {
          say('本页没有可保存的修改')
          return
        }
        saveFn()
      }
      // 全局 Ctrl/⌘+S：按 phase/tab 派发保存；仅当「当前上下文有可保存内容」时 preventDefault（不干扰宿主其它快捷键）
      // 两处既有 textarea onKeyDown 会先 preventDefault，本监听用 e.defaultPrevented 去重，不会重复保存。
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (leavePrompt) return
          if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
          if (String(event.key || '').toLowerCase() !== 's') return
          if (event.defaultPrevented) return
          const focusedInDoc = Boolean(docOpen && docPath && !docUnavailable && focusInsideDocPane())
          const canSaveTab = phase === 'project' && Boolean(SAVEABLE_TABS[tab])
          if (!focusedInDoc && !canSaveTab) {
            // 不阻断宿主默认快捷键（Lead 约束：仅「当前页签有可保存内容」时 preventDefault），但面板内不静默
            if (phase === 'project') say('本页没有可保存的修改')
            return
          }
          event.preventDefault()
          if (focusedInDoc) {
            if (docBusy) say('文档处理中，请稍候…')
            else saveDoc()
            return
          }
          saveCurrentTab()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      })
      // P0-1：关窗/刷新保护（beforeunload 只能走浏览器原生确认，无法面板内三选一；仅在有未保存修改时挂监听 = 尽力保护）
      React.useEffect(() => {
        if (!hasUnsavedChanges()) return undefined
        const onBeforeUnload = (event) => {
          const message = '有未保存的修改，确定离开吗？'
          event.preventDefault()
          event.returnValue = message
          return message
        }
        window.addEventListener('beforeunload', onBeforeUnload)
        return () => window.removeEventListener('beforeunload', onBeforeUnload)
      })
      // 未保存守卫对话框：Esc = 取消（安全出口）
      React.useEffect(() => {
        if (!leavePrompt) return
        const onEscape = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (!leaveSaving) setLeavePrompt(null)
          }
        }
        window.addEventListener('keydown', onEscape)
        return () => window.removeEventListener('keydown', onEscape)
      })
      // v0.12.1（task-8）：两棵 React 树状态同步 —— 宿主设置页/项目设置浮层关闭后窗口重新获得焦点时，静默重读 settings-get
      // （仅既有调用点；失败忽略，降级为回主列表时 loadList 已重读）
      React.useEffect(() => {
        const refreshSettingsOnFocus = () => {
          if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return
          api('settings-get').then((result) => setSettings(normalizeSettings(result.settings))).catch(() => {})
        }
        window.addEventListener('focus', refreshSettingsOnFocus)
        return () => window.removeEventListener('focus', refreshSettingsOnFocus)
      })
      // 项目页设置浮层：Esc = 关闭（与未保存离开守卫互不影响）
      React.useEffect(() => {
        if (!settingsOverlay) return
        const onEscape = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setSettingsOverlay(false)
          }
        }
        window.addEventListener('keydown', onEscape)
        return () => window.removeEventListener('keydown', onEscape)
      })

      // v0.12.4（task-24 / M5-A）：离开守卫对话框焦点陷阱（初始焦点进入 / Tab 循环 / 关闭归还）
      React.useEffect(() => {
        if (!leavePrompt) return undefined
        return installDialogFocusTrap('ad-leave-dialog')
      }, [Boolean(leavePrompt)])
      // v0.12.4（task-24 / M5-A）：项目页设置浮层焦点陷阱（与 Esc/遮罩关闭互不影响）
      React.useEffect(() => {
        if (!settingsOverlay) return undefined
        return installDialogFocusTrap('ad-settings-dialog')
      }, [Boolean(settingsOverlay)])
      // v0.14.0（task-38 / M6-1）：交给 Agent（C 路径）动作
      const openHandoff = () => {
        if (busy) return
        setHandoffOpen(true)
        setHandoffBusy(true)
        setHandoffCopied(false)
        setHandoffCopyError('')
        setHandoffInstr('')
        window.setTimeout(() => {
          setHandoffInstr(buildHandoffInstruction({
            title: openTitle,
            sourcePath: sourcePath,
            tab,
            tabLabel: tabLabelOfKey(tab),
            summaryLines: handoffSummaryLinesOf(tab, {
              contract, rows, characters, world, episodes, episodeOrder, episodeText, shots,
              dialogue, assets, memory, draftList, ledger, genTasks, report, reviewReport, exported, finalized, tree,
            }),
          }))
          setHandoffBusy(false)
        }, 0)
      }
      const closeHandoff = () => {
        setHandoffOpen(false)
        setHandoffBusy(false)
        setHandoffCopyError('')
      }
      const copyHandoff = () => {
        const text = handoffInstr
        const fail = (err) => {
          setHandoffCopied(false)
          setHandoffCopyError(String((err && err.message) || err || '剪贴板不可用'))
        }
        try {
          if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            fail('剪贴板不可用')
            return
          }
          const pending = navigator.clipboard.writeText(text)
          if (pending && typeof pending.then === 'function') {
            pending.then(() => { setHandoffCopied(true); setHandoffCopyError('') }).catch(fail)
          } else {
            setHandoffCopied(true)
            setHandoffCopyError('')
          }
        } catch (err) {
          fail(err)
        }
      }
      // 弹窗 Esc 关闭（仅打开时）
      React.useEffect(() => {
        if (!handoffOpen) return
        const onEscape = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setHandoffOpen(false)
            setHandoffBusy(false)
            setHandoffCopyError('')
          }
        }
        window.addEventListener('keydown', onEscape)
        return () => window.removeEventListener('keydown', onEscape)
      })
      // 弹窗焦点陷阱（初始焦点进入 / Tab 循环 / 关闭归还触发按钮）
      React.useEffect(() => {
        if (!handoffOpen) return undefined
        return installDialogFocusTrap('ad-agent-dialog')
      }, [Boolean(handoffOpen)])
      /* ---------------- v0.16.6（C2-C / E15+H-7）：视觉圣经定向/冻结动作（style-save） ---------------- */
      const currentStyleDirection = normalizeStyleDirection(styleDirection)
      const styleStatus = currentStyleDirection.status
      const styleFrozen = styleStatus === 'frozen'
      const styleSavedDraft = styleDraftOf(visualStyle)
      const styleDraftPayload = () => {
        const payload = {}
        for (const [key] of STYLE_DIMENSION_ORDER) payload[key] = String(styleDraft[key] == null ? '' : styleDraft[key]).trim().slice(0, VISUAL_STYLE_TEXT_MAX)
        return payload
      }
      const styleHasAnyContent = () => STYLE_DIMENSION_ORDER.some(([key]) => String(styleDraft[key] == null ? '' : styleDraft[key]).trim())
      const styleDraftChanged = () => STYLE_DIMENSION_ORDER.some(([key]) => String(styleDraft[key] == null ? '' : styleDraft[key]).trim() !== String(styleSavedDraft[key] == null ? '' : styleSavedDraft[key]).trim())
      const applyStyleResult = (result) => {
        if (result && result.style) {
          setVisualStyle(normalizeVisualStyle(result.style))
          setStyleDraft(styleDraftOf(result.style))
        }
        if (result && result.state) setStyleDirection(normalizeStyleDirection(result.state))
      }
      const styleErrorMessage = (error) => {
        const code = String((error && error.code) || '')
        if (code === 'conflict') return '已被其他写入修改，请刷新后重试。'
        if (code === 'state-conflict') return '当前状态不允许该操作，请刷新状态后重试。'
        if (code === 'style-locked') return '风格已冻结，需先解冻。'
        if (code === 'invalid-args') return String((error && error.message) || '风格参数不合法')
        if (code === 'not-found') return '项目不存在或已返回列表，请重新打开项目后重试。'
        return String((error && error.message) || '风格保存失败，请重试。')
      }
      const applyStyleError = (error) => {
        const detail = error && error.detail
        if (detail && detail.state) setStyleDirection(normalizeStyleDirection(detail.state))
        setStyleError(styleErrorMessage(error))
        setStyleNotice('')
      }
      const postStyleSave = async (payload) => {
        try {
          return await api('style-save', Object.assign({ title: openTitle }, payload))
        } catch (error) {
          applyStyleError(error)
          throw error
        }
      }
      const refreshStyleState = async () => {
        if (!openTitle || busy || styleBusy) return
        setStyleBusy(true)
        setStyleNotice('')
        setStyleError('')
        try {
          const result = await api('assets-get', { title: openTitle })
          setVisualStyle(normalizeVisualStyle(result.styleDNA))
          setStyleDraft(styleDraftOf(result.styleDNA))
          setStyleDirection(normalizeStyleDirection(result.styleDirection))
          setStyleNotice('已刷新风格状态。')
        } catch (error) {
          setStyleError(styleErrorMessage(error))
        } finally {
          setStyleBusy(false)
        }
      }
      const saveStyle = async (action, options) => {
        if (styleBusy || !openTitle) return
        const opts = options || {}
        if (styleFrozen && (action === 'save' || action === 'direct')) {
          setStyleError('风格已冻结，需先解冻。')
          return
        }
        setStyleBusy(true)
        setStyleNotice('')
        setStyleError('')
        try {
          const payload = styleDraftPayload()
          if (action === 'save') {
            if (!styleHasAnyContent() && styleStatus === 'directed') throw new Error('已定向风格微调需至少保留一维非空内容')
            const request = { action: 'save', style: payload }
            if (currentStyleDirection.hash) request.expectedHash = currentStyleDirection.hash
            const result = await postStyleSave(request)
            applyStyleResult(result)
            setStyleNotice(styleStatus === 'directed' ? '微调已保存。' : '风格草稿已保存。')
          } else if (action === 'direct') {
            if (!styleHasAnyContent()) throw new Error('请至少填写一维风格后再定向')
            if (styleDraftChanged() || !currentStyleDirection.hash) {
              const saveRequest = { action: 'save', style: payload }
              if (currentStyleDirection.hash) saveRequest.expectedHash = currentStyleDirection.hash
              const saveResult = await postStyleSave(saveRequest)
              applyStyleResult(saveResult)
            }
            const result = await postStyleSave({ action: 'direct' })
            applyStyleResult(result)
            setStyleNotice('已定向：后续进入受控微调。')
          } else if (action === 'freeze') {
            if (styleDraftChanged()) {
              const saveRequest = { action: 'save', style: payload }
              if (currentStyleDirection.hash) saveRequest.expectedHash = currentStyleDirection.hash
              const saveResult = await postStyleSave(saveRequest)
              applyStyleResult(saveResult)
            }
            const note = String(opts.reason == null ? '' : opts.reason).trim().slice(0, STYLE_REASON_MAX)
            const result = await postStyleSave(note ? { action: 'freeze', reason: note } : { action: 'freeze' })
            applyStyleResult(result)
            setStyleNotice('风格已冻结（只读）。')
          } else if (action === 'unfreeze') {
            const reason = String(opts.reason == null ? '' : opts.reason).trim()
            if (reason.length < STYLE_REASON_MIN || reason.length > STYLE_REASON_MAX) {
              setStyleReasonError('解冻原因需 ' + STYLE_REASON_MIN + '–' + STYLE_REASON_MAX + ' 字（当前 ' + reason.length + ' 字）')
              return
            }
            if (!currentStyleDirection.hash) throw new Error('缺少当前风格 hash，请先刷新状态')
            const result = await postStyleSave({ action: 'unfreeze', reason: reason, expectedHash: currentStyleDirection.hash })
            applyStyleResult(result)
            setStyleNotice('已解冻，风格恢复为可微调。')
          }
          setStyleDialog(null)
          setStyleReason('')
          setStyleReasonError('')
        } catch (error) {
          if (!(error && error.code)) setStyleError(String((error && error.message) || '风格保存失败，请重试。'))
        } finally {
          setStyleBusy(false)
        }
      }
      const openStyleDialog = (type) => {
        setStyleDialog(type)
        setStyleReason('')
        setStyleReasonError('')
        setStyleNotice('')
        setStyleError('')
      }
      const closeStyleDialog = () => {
        if (styleBusy) return
        setStyleDialog(null)
        setStyleReason('')
        setStyleReasonError('')
      }
      const confirmStyleDialog = () => {
        if (styleDialog === 'direct') saveStyle('direct')
        else if (styleDialog === 'micro') saveStyle('save')
        else if (styleDialog === 'freeze') saveStyle('freeze', { reason: styleReason })
        else if (styleDialog === 'unfreeze') saveStyle('unfreeze', { reason: styleReason })
      }
      React.useEffect(() => {
        if (!styleDialog) return
        const onEscape = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (!styleBusy) setStyleDialog(null)
          }
        }
        window.addEventListener('keydown', onEscape)
        return () => window.removeEventListener('keydown', onEscape)
      })
      React.useEffect(() => {
        if (!styleDialog) return undefined
        return installDialogFocusTrap('ad-style-dialog')
      }, [Boolean(styleDialog)])
      // v0.16.9（C3-C / E16+H-8）：审核对话框 Esc 关闭 + 焦点陷阱（复用 installDialogFocusTrap）
      React.useEffect(() => {
        if (!assetReviewDialog) return undefined
        const onEscape = (event) => {
          if (event.key !== 'Escape' || assetReviewBusy) return
          event.preventDefault()
          setAssetReviewDialog(null)
          setAssetReviewReason('')
          setAssetReviewReasonError('')
          setAssetReviewError('')
        }
        window.addEventListener('keydown', onEscape)
        return () => window.removeEventListener('keydown', onEscape)
      })
      React.useEffect(() => {
        if (!assetReviewDialog) return undefined
        return installDialogFocusTrap('ad-review-dialog')
      }, [Boolean(assetReviewDialog)])
      // v0.12.4（task-28 / M5-H hotfix）：设置浮层运行期可读性自愈 —— 若主题派生背景在该渲染上下文未解析为不透明色
      // （g2 证据：遮罩正常、面板 background 未绘制）。取值优先级：①同页 .ad-shell 的 computed background/color（与宿主主题一致）
      // → ②系统色 Canvas/CanvasText 兜底（浅/深自适应、0 hex、不新增 token）。只加 inline style 与诊断属性，
      // 不改 DOM 结构、不绑事件、不影响 Esc/遮罩关闭/焦点 trap/保存逻辑。
      React.useEffect(() => {
        if (!settingsOverlay) return undefined
        const readComputed = (el) => {
          try {
            if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null
            const style = window.getComputedStyle(el)
            if (!style) return null
            return {
              background: typeof style.backgroundColor === 'string' ? style.backgroundColor : '',
              color: typeof style.color === 'string' ? style.color : '',
            }
          } catch {
            return null
          }
        }
        const isTransparentColor = (value) => !value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)' || value === 'rgba(0,0,0,0)'
        const isOpaqueColor = (value) => Boolean(value) && !isTransparentColor(value)
        try {
          if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return undefined
          const panel = document.getElementById('ad-settings-dialog')
          if (!panel) return undefined
          const backdrop = panel.parentElement || null
          const shell = typeof panel.closest === 'function' ? panel.closest('.ad-shell') : null
          const panelStyle = readComputed(panel)
          const backdropStyle = readComputed(backdrop)
          const shellStyle = readComputed(shell)
          const panelBg = panelStyle ? panelStyle.background : ''
          const backdropBg = backdropStyle ? backdropStyle.background : ''
          // 自愈取值优先级：同页 .ad-shell computed 值 → Canvas 系统色
          const shellBg = shellStyle ? shellStyle.background : ''
          const shellColor = shellStyle ? shellStyle.color : ''
          const adoptedBg = isOpaqueColor(shellBg) ? 'shell:' + shellBg : 'canvas:Canvas'
          const adoptedColor = isOpaqueColor(shellColor) ? 'shell:' + shellColor : 'canvas:CanvasText'
          // 诊断属性：记录实测色值与实际采用值（仅色值语义，无敏感信息），供 GUI/DevTools 核对根因与自愈是否生效
          try {
            panel.setAttribute('data-ad-overlay-bg', 'panel=' + (panelBg || 'unknown') + ';backdrop=' + (backdropBg || 'unknown') + ';shell=' + (shellBg || 'unknown') + ';adopted=' + (isTransparentColor(panelBg) ? adoptedBg : 'native:' + panelBg))
          } catch {
            /* setAttribute 不可用时忽略 */
          }
          if (isTransparentColor(panelBg) && panel.style) {
            panel.style.background = isOpaqueColor(shellBg) ? shellBg : 'Canvas'
            panel.style.color = isOpaqueColor(shellColor) ? shellColor : 'CanvasText'
          }
          if (backdrop && isTransparentColor(backdropBg) && backdrop.style) {
            backdrop.style.background = 'rgba(0,0,0,.4)'
          }
        } catch {
          /* 自愈失败不抛错、不影响交互 */
        }
        return undefined
      }, [Boolean(settingsOverlay)])

      // v0.12.4（task-26 / M5-C）：审读派生数据 memo（纯派生、无副作用；避免无关 state 更新时对全部 findings 重复 filter/sort/group）
      const reviewFindingsMemo = React.useMemo(() => (reviewReport && reviewReport.findings) || [], [reviewReport])
      const reviewFilteredMemo = React.useMemo(
        () => reviewFindingsMemo.filter((finding) => !reviewDimensionFilter || finding.dimension === reviewDimensionFilter),
        [reviewFindingsMemo, reviewDimensionFilter],
      )
      const reviewSortedMemo = React.useMemo(() => sortReviewFindings(reviewFilteredMemo, reviewSort), [reviewFilteredMemo, reviewSort])
      const reviewGroupsMemo = React.useMemo(
        () => REVIEW_SEVERITY_ORDER
          .map((sevKey) => ({ sev: sevKey, items: reviewSortedMemo.filter((finding) => finding.severity === sevKey) }))
          .filter((group) => group.items.length),
        [reviewSortedMemo],
      )
      const reviewDimensionOptionsMemo = React.useMemo(
        () => Object.entries(REVIEW_DIMENSION_LABELS)
          .map(([key, label]) => ({ key, label, count: reviewFindingsMemo.filter((finding) => finding.dimension === key).length }))
          .filter((option) => option.count > 0),
        [reviewFindingsMemo],
      )
      const reviewSeverityCountsMemo = React.useMemo(
        () => REVIEW_SEVERITY_ORDER.reduce((counts, sevKey) => {
          counts[sevKey] = reviewFindingsMemo.filter((finding) => finding.severity === sevKey).length
          return counts
        }, {}),
        [reviewFindingsMemo],
      )
      // v0.12.4（task-26 / M5-C）：分镜高级字段扫描 memo + 景别 option 元素复用（100 镜头场景减少无关重算）
      const shotExtraEntriesMemo = React.useMemo(() => shots.map((shot) => storyboardExtraEntries(shot)), [shots])
      const shotSizeOptionEls = React.useMemo(() => SHOT_SIZES.map((s) => h('option', { key: s, value: s }, s)), [])
      // v0.12.4（task-26 / M5-C）：工具卡片页派生统计 memo（重页，避免无关渲染重算）
      const toolcardsDerived = React.useMemo(() => {
        const draftPending = draftList.filter((draft) => draft.status === 'pending').length
        const receipts = [
          ['剧集契约', contract ? `${contract.platform || '未定平台'} · 目标 ${contract.targetEpisodes || 0} 集` : '—'],
          ['分集大纲', `${rows.length} 行`],
          ['人物设定卡', `${characters.length} 人${characters.length ? '：' + characters.slice(0, 6).map((card) => card.name).filter(Boolean).join('、') : ''}`],
          ['世界观', `${world.length} 条`],
          ['本剧记忆', `${memory.length} 条（未回收 ${memory.filter((m) => m.status === 'open').length}）`],
        ]
        const episodeSceneCount = parseEpisodeScenes(episodeText).length
        const episodeLineCount = episodeText ? episodeText.split(/\r?\n/).length : 0
        const episodeCharCount = episodeText.replace(/\s/g, '').length
        return { draftPending, receipts, episodeSceneCount, episodeLineCount, episodeCharCount }
      }, [contract, rows, characters, world, memory, draftList, episodeText])

      // v0.13.0（task-31 / M6-0a）：列表页项目卡（影视内容风；封面 button 内仅 span/装饰，禁止嵌套 button/a）
      const renderProjectCard = (project) => {
        const count = Number(project.episodeCount) || 0
        const target = Number(settings && settings.defaultTargetEpisodes) || 0
        const status = projectStatusOf(project, target)
        const progressPercent = target > 0 ? Math.max(0, Math.min(100, Math.round((count / target) * 100))) : 0
        const title = String(project.title == null ? '' : project.title)
        return h('div', { className: 'ad-project-card', key: project.path, 'data-ad-surface': 'card' },
          h('button', {
            className: 'ad-project-cover',
            'data-cover': projectCoverVariant(title),
            'data-initial': projectInitialOf(title),
            'aria-label': '打开短剧《' + title + '》',
            title: project.path,
            onClick: () => openProject(title),
            disabled: busy,
          },
            h('span', { className: 'ad-project-badge', 'data-ad-surface': 'badge', 'data-state': status.key, title: status.hint }, status.label),
            h('span', { className: 'ad-project-chip', 'aria-hidden': 'true' }, count + ' 集')),
          h('div', { className: 'ad-project-body' },
            h('div', { className: 'ad-project-title', title }, title),
            h('div', { className: 'ad-project-meta', title: project.path }, '最近修改 · ' + formatProjectUpdatedAt(project.updatedAt)),
            target > 0
              ? h('div', { className: 'ad-project-progress-wrap' },
                  h('div', {
                    className: 'ad-project-progress',
                    role: 'progressbar',
                    'aria-valuemin': 0,
                    'aria-valuemax': target,
                    'aria-valuenow': Math.min(count, target),
                    'aria-label': '进度 ' + Math.min(count, target) + ' / ' + target + ' 集（按默认目标估算）',
                    title: '按默认目标 ' + target + ' 集估算，项目契约可单独设置目标集数',
                  },
                    h('div', { className: 'ad-project-progress-bar', style: { width: progressPercent + '%' } })),
                  h('span', { className: 'ad-project-progress-label' }, Math.min(count, target) + ' / ' + target + ' 集'))
              : null,
            h('div', { className: 'ad-project-actions' },
              h('button', { className: 'ad-btn ad-primary ad-sm', onClick: () => openProject(title), disabled: busy }, '打开'),
              h('details', { className: 'ad-project-more' },
                h('summary', { className: 'ad-btn ad-sm ad-icon-btn', 'aria-label': '更多操作', title: '更多操作' }, icon('ellipsis')),
                h('div', { className: 'ad-project-more-panel', role: 'menu', 'aria-label': '短剧《' + title + '》操作' },
                  h('button', { className: 'ad-project-more-item', role: 'menuitem', onClick: () => renameProject(title), disabled: busy }, icon('pencil'), '重命名'),
                  h('button', { className: 'ad-project-more-item ad-project-more-danger', role: 'menuitem', onClick: () => deleteProject(title), disabled: busy }, icon('trash'), '删除'),
                  h('div', { className: 'ad-project-more-path', title: project.path }, icon('folder'), '所在目录：' + project.path))))))
      }

      /* ---------------------------------------------------------------- 渲染 */

      const children = [h(Styles, { key: 'styles' })]

      const headLeft = []
      const headRight = []
      if (flash) headRight.push(h('span', { className: 'ad-flash', key: 'flash', role: 'status', 'aria-live': 'polite' }, flash))
      if (phase === 'project') {
        // P0-1（task-4）：页头常驻保存态（未保存修改 / 已保存）
        const unsaved = hasUnsavedChanges()
        headRight.push(h('span', {
          className: unsaved ? 'ad-save-state ad-dirty' : 'ad-save-state ad-ok',
          key: 'save-state',
          role: 'status',
          'aria-live': 'polite',
          title: unsaved
            ? '当前项目有未保存修改：Ctrl/⌘+S 可保存当前页签或文档栏，离开前会提示'
            : '当前项目没有未保存修改',
        }, unsaved ? '● 未保存修改' : '✓ 已保存'))
        headRight.push(h('button', {
          className: 'ad-btn ad-sm ad-agent-entry',
          key: 'agent-handoff',
          'aria-label': '生成交接指令并复制，交给 Agent',
          title: '生成交接指令并复制，交给 Agent',
          'aria-haspopup': 'dialog',
          'aria-expanded': handoffOpen ? 'true' : 'false',
          disabled: busy,
          onClick: () => openHandoff(),
        }, icon('send'), h('span', { className: 'ad-agent-label' }, '交给 Agent')))
        // v0.16.5（task-45）：剧集契约整页入口（从创作页签组上移到页头；复用 switchTab，含未保存守卫）
        headRight.push(h('button', {
          className: 'ad-btn ad-sm ad-head-entry',
          key: 'contract-entry',
          id: 'ad-tab-contract',
          'aria-label': tab === 'contract' ? '剧集契约（当前页）' : '剧集契约',
          title: '剧集契约（项目级约束设置）',
          'aria-current': tab === 'contract' ? 'page' : undefined,
          'data-on': tab === 'contract' ? '1' : '0',
          disabled: busy,
          onClick: () => { if (tab !== 'contract') switchTab('contract') },
        }, h('span', { className: 'ad-head-entry-full' }, '剧集契约'), h('span', { className: 'ad-head-entry-short', 'aria-hidden': 'true' }, '契约')))
        headRight.push(h('button', {
          className: 'ad-btn ad-sm',
          key: 'settings',
          onClick: () => setSettingsOverlay(true),
          disabled: busy,
          'aria-haspopup': 'dialog',
          'aria-expanded': settingsOverlay ? 'true' : 'false',
          title: 'AI 短剧设置（默认契约 / 模型 / 任务模型 / 提示词模板 / 存储位置 + 环境诊断）',
        }, '设置'))
        headRight.push(h('button', {
          className: 'ad-btn',
          key: 'doc',
          onClick: toggleDocPane,
          disabled: busy,
          'aria-pressed': docOpen ? 'true' : 'false',
          title: '面板内右栏文档编辑器（T7 / E1；不接管原生 documentpreview）',
        }, docOpen ? '收起文档' : '文档'))
        headLeft.push(h('button', { className: 'ad-btn', key: 'back', onClick: () => requestLeave(goBackToList), disabled: busy, 'aria-label': '返回短剧列表' }, '← 返回'))
      } else {
        headRight.push(h('button', { className: 'ad-btn', key: 'refresh', onClick: loadList, disabled: busy, 'aria-label': '刷新短剧列表' }, icon('refresh'), '刷新'))
      }

      children.push(
        h(
          'div',
          { className: 'ad-head', key: 'head' },
          headLeft,
          h(DramaIcon, { size: 18 }),
          h('div', null,
            h('div', { className: 'ad-title' }, phase === 'project' ? openTitle : 'AI 短剧',
              sourcePath
                ? h('span', { className: 'ad-count', style: { marginLeft: 8, fontWeight: 400 } }, '数据源：' + shortSourcePath(sourcePath))
                : null),
            h('div', { className: 'ad-sub' }, '短剧创作中枢')),
          h('div', { style: { flex: 1 } }),
          headRight,
        ),
      )

      const body = []
      if (error) {
        // P2-8：错误可读化 —— 失败码 → 用户文案 +「下一步」+ 可操作恢复按钮
        const info = errorInfo || friendlyErrorInfo({ code: 'unknown', message: error })
        const actions = [
          h('button', {
            className: 'ad-btn ad-sm ad-primary',
            key: 'retry',
            onClick: retryLastAction,
            disabled: busy || !retryAction,
            title: retryAction ? '重试上一次失败的操作' : '没有可重试的操作',
          }, info.recovery === 'reload' ? '重试（先重新载入）' : '重试'),
        ]
        if (info.recovery === 'reload') {
          actions.push(h('button', {
            className: 'ad-btn ad-sm',
            key: 'reload',
            onClick: () => { if (openTitle) openProject(openTitle); else loadList() },
            disabled: busy,
          }, '重新载入'))
        }
        if (phase === 'project') {
          actions.push(h('button', {
            className: 'ad-btn ad-sm',
            key: 'back-list',
            onClick: () => requestLeave(goBackToList),
            disabled: busy,
          }, '返回列表'))
        }
        body.push(h('div', { className: 'ad-err-box', key: 'e', role: 'alert' },
          h('div', { className: 'ad-err-head' }, `失败 · ${info.label}（${info.code}）`),
          h('div', { className: 'ad-err' }, error),
          h('div', { className: 'ad-err-next' }, `下一步：${info.next}`),
          h('div', { className: 'ad-err-actions' }, actions)))
      }
      if (phase === 'loading') {
        // P2-8/v0.6.3：加载骨架（不空白屏）
        body.push(h('div', { className: 'ad-skeleton', key: 'l', role: 'status', 'aria-label': '加载中骨架' },
          h('div', { className: 'ad-skeleton-line w60' }),
          h('div', { className: 'ad-skeleton-line w90' }),
          h('div', { className: 'ad-skeleton-line w80' }),
          h('div', { className: 'ad-skeleton-line w40' }),
          h('div', { className: 'ad-project-grid', key: 'skel-grid', 'aria-hidden': 'true' },
            [0, 1, 2].map((index) => h('div', { className: 'ad-project-skeleton-card', key: index },
              h('div', { className: 'ad-project-skeleton-cover' }),
              h('div', { className: 'ad-skeleton-line w60' }),
              h('div', { className: 'ad-skeleton-line w40' }))))))
      } else if (phase === 'error') {
        body.push(h('button', { className: 'ad-btn', key: 'retry', onClick: loadList }, '重试'))
      } else if (phase === 'ready') {
        // P2-1 多数据源：数据源选择器（B 阶段：宿主 sources-list；旧宿主降级 A：工作区枚举）
        body.push(
          h('div', { className: 'ad-row ad-source-row', key: 'source', style: { marginBottom: 12, flexWrap: 'wrap' } },
            h('span', { className: 'ad-sec', style: { margin: 0 } }, '数据源'),
            h('select', {
              className: 'ad-select',
              style: { flex: '0 1 460px', maxWidth: 460, minWidth: 220 },
              value: sourcePath,
              'aria-label': '选择数据源（切换会重置当前视图）',
              onChange: (e) => selectSource(e.target.value),
              disabled: busy || sourceBusy,
            },
            sources.length ? null : h('option', { value: '' }, sourcesMode === 'loading' ? '枚举数据源中…' : '（使用宿主默认数据源）'),
            sources.map((item, index) => h('option', { key: item.path, value: item.path }, sourceLabelOf(item, index)))),
            h('button', { className: 'ad-btn ad-sm', onClick: () => refreshSources(), disabled: busy || sourceBusy }, icon('refresh'), sourceBusy ? '刷新中…' : '刷新数据源'),
            sourcesMode === 'legacy' ? h('span', { className: 'ad-count' }, '旧宿主降级：仅工作区') : null,
            sourcesMode === 'host' ? h('span', { className: 'ad-count' }, `共 ${sources.length} 个源`) : null,
            sourcesDegraded ? h('span', { className: 'ad-count', style: { color: 'var(--ad-warn)' } }, '部分数据源不可用') : null,
            sourcePath ? h('span', { className: 'ad-count' }, `当前：${shortSourcePath(sourcePath)}`) : null,
            !sources.length && sourcesMode !== 'loading'
              ? h('span', { className: 'ad-hint-next' }, '未枚举到数据源：将使用宿主默认源；切到含短剧项目的目录后可点「刷新数据源」')
              : null),
        )

        body.push(
          h('div', { className: 'ad-list-toolbar ad-create-hero', key: 'new', 'data-ad-surface': 'hero' },
            h('input', {
              className: 'ad-input',
              'aria-label': '新建短剧名称',
              placeholder: '新建短剧，例如：万界倒爷：先发育再屠神',
              value: draftTitle,
              onChange: (e) => setDraftTitle(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') createProject() },
            }),
            h('button', { className: 'ad-btn ad-primary ad-cta', onClick: createProject, disabled: busy || !draftTitle.trim() }, '新建短剧')),
        )

        body.push(
          h('div', { className: 'ad-list-toolbar', key: 'search' },
            h('input', {
              className: 'ad-input',
              'aria-label': '搜索短剧名称或正文内容',
              placeholder: '搜索短剧名或正文内容…',
              value: query,
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') doSearch() },
            }),
            h('button', { className: 'ad-btn', onClick: doSearch, disabled: busy || !query.trim() }, '搜索'),
            hits ? h('button', { className: 'ad-btn', onClick: () => setHits(null) }, '清除') : null),
        )

        if (hits) {
          body.push(h('div', { className: 'ad-sec', key: 'sh' }, `搜索结果 · ${hits.hits.length}${hits.truncated ? '+' : ''}`))
          body.push(
            h('div', { className: 'ad-hits', key: 'shl' },
              hits.hits.length
                ? hits.hits.map((hit, i) =>
                    h('div', { className: 'ad-hit', key: i },
                      h('div', { className: 'ad-hit-path' }, `${hit.path}${hit.line ? ':' + hit.line : ''}`),
                      h('div', null, hit.text)))
                : emptyState({ key: 'search-empty', title: '没有命中', description: '换个关键词，或检查数据源是否包含目标项目目录。', next: '修改关键词后重新搜索（Enter）', actions: [{ label: '清除搜索', onClick: () => setHits(null) }] })),
          )
        }

        body.push(h('div', { className: 'ad-list-head', key: 'sec' },
          h('span', { className: 'ad-sec', style: { margin: 0 } }, `我的短剧 · ${projects.length}`),
          h('span', { className: 'ad-count' }, '按最近修改')))
        if (!projects.length) {
          body.push(h('div', { className: 'ad-empty-poster', key: 'empty-poster', 'data-ad-surface': 'poster' },
            emptyState({
              key: 'empty',
              title: '还没有短剧项目',
              description: '新建后会在工作区下生成 AI短剧/<短剧名>/ 及固定创作目录（项目 / 大纲 / 人物 / 分集剧本 / 分镜 / 导出）。',
              next: '在上方输入短剧名并点「新建短剧」；若短剧在别的目录，先切换数据源',
            })))
        } else {
          body.push(h('div', { className: 'ad-project-grid', key: 'grid' }, projects.map((project) => renderProjectCard(project))))
        }

        // 共享资料（跨项目复用，FR-A05）
        body.push(
          h('div', { key: 'shared', id: 'ad-shared-surface', 'data-ad-surface': 'shared' },
            h('div', { className: 'ad-row', style: { margin: '18px 0 8px' } },
              h('span', { className: 'ad-sec', style: { margin: 0 } }, '共享资料'),
              h('div', { style: { flex: 1 } }),
              h('button', { className: 'ad-btn ad-sm', onClick: () => loadList(), disabled: busy }, icon('refresh'), '刷新')),
            shared && shared.entries && shared.entries.length
              ? h('div', { className: 'ad-shared-grid' },
                  shared.entries.map((entry) =>
                    h('button', {
                      key: entry.name,
                      className: 'ad-shared-card',
                      onClick: () => (entry.kind === 'dir' ? null : openShared(entry.name)),
                    }, (entry.kind === 'dir' ? '📁 ' : '📄 ') + entry.name)))
              : h('div', { className: 'ad-shared-empty', key: 'shared-empty-wrap' },
                  emptyState({ key: 'shared-empty', title: '共享资料为空', description: '共享资料是跨项目复用的空间（题材库、平台规范、参考桥段）。', next: '把文件放到工作区共享资料目录后点「刷新」', actions: [{ label: '刷新', onClick: () => loadList(), disabled: busy }] })),
            sharedPath
              ? h('div', { style: { marginTop: 10 } },
                  h('div', { className: 'ad-row', style: { marginBottom: 6 } },
                    h('span', { className: 'ad-sub' }, sharedPath),
                    h('div', { style: { flex: 1 } }),
                    h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveShared, disabled: busy }, '保存'),
                    h('button', { className: 'ad-btn ad-sm', onClick: () => { setSharedPath(''); setSharedText('') } }, '关闭')),
                  h('textarea', { className: 'ad-area', rows: 8, value: sharedText, onChange: (e) => setSharedText(e.target.value) }))
              : null,
          ),
        )

        // v0.12.1（task-8）：设置区块 + 环境信息已迁入宿主「设置 → AI 短剧」独立设置页；列表页仅保留主任务
        body.push(
          h('div', { className: 'ad-path', key: 'settings-moved' },
            '设置与环境信息已移至：侧栏「设置」→「AI 短剧」；项目页右上「设置」可直接打开面板内设置（同一组件、同一 settings 数据）。'),
        )

      } else if (phase === 'project') {
        const tabs = [
          ['world', '世界观'],
          ['outline', '总纲'],
          ['characters', '人物'],
          ['episode', '剧本'],
          ['storyboard', '分镜'],
          ['dialogue', '台词与音效'],
          ['assets', '素材库'],
          ['memory', '本剧记忆'],
          ['drafts', '草稿' + (draftList.length ? ` (${draftList.length})` : '')],
          ['ledger', '账本'],
          ['generate', '生成'],
          ['check', '检查 / 导出'],
          ['tree', '目录'],
          ['toolcards', '工具卡片'],
        ]
        // v0.12.0（task-7）：15 页签 4 组 + 窄窗「更多」收纳；aria：tablist/tab/aria-selected 保留，内容区统一 tabpanel
        const tabLabelOf = new Map(tabs)
        const groupedTabs = TAB_GROUPS.map((group) => ({ ...group, items: group.tabs.map((key) => [key, tabLabelOf.get(key)]) }))
        // v0.16.5（task-45）：13 个可见页签键（页签条/更多菜单/键盘 roving 均以此为准；contract 为内部合法键但不在其中）
        const visibleTabKeys = groupedTabs.flatMap((group) => group.items.map(([key]) => key))
        const rovingTabKey = visibleTabKeys.includes(tab) ? tab : (visibleTabKeys[0] || 'outline')
        // v0.12.4（task-24 / M5-A）：页签 roving tabindex + ←/→/Home/End 仅移动焦点（manual activation：不调用 switchTab，避免误触发未保存守卫）
        const focusTabByKey = (targetKey) => {
          if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return
          const el = document.getElementById('ad-tab-' + targetKey)
          if (el && typeof el.focus === 'function') {
            try {
              el.focus()
            } catch {
              /* 隐藏分组/不可聚焦元素安全跳过 */
            }
          }
        }
        const onTabKeyDown = (event, key) => {
          const keyName = String((event && event.key) || '')
          if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(keyName)) return
          const index = visibleTabKeys.indexOf(key)
          if (index < 0) return
          let nextIndex = index
          if (keyName === 'Home') nextIndex = 0
          else if (keyName === 'End') nextIndex = visibleTabKeys.length - 1
          else nextIndex = (index + (keyName === 'ArrowRight' ? 1 : -1) + visibleTabKeys.length) % visibleTabKeys.length
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          focusTabByKey(visibleTabKeys[nextIndex])
        }
        const renderMainTab = (key, label) => h('button', {
          key,
          id: 'ad-tab-' + key,
          className: 'ad-tab',
          role: 'tab',
          'aria-selected': tab === key ? 'true' : 'false',
          'aria-controls': 'ad-tabpanel',
          'data-on': tab === key ? '1' : '0',
          tabIndex: rovingTabKey === key ? 0 : -1,
          onKeyDown: (event) => onTabKeyDown(event, key),
          onClick: () => switchTab(key),
        }, label,
        dirty[key] ? h('span', { className: 'ad-tab-dirty', 'aria-label': '未保存修改', title: '有未保存修改' }, '●') : null)
        const tabsNode = h('div', { className: 'ad-tabs', key: 'tabs' },
          h('div', { className: 'ad-tab-groups', role: 'tablist', 'aria-label': '短剧工作区页签' },
            groupedTabs.map((group) => h('div', { className: 'ad-tab-group', key: group.id, role: 'presentation' },
              h('span', { className: 'ad-tab-group-label' }, group.label),
              group.items.map(([key, label]) => renderMainTab(key, label))))),
          h('div', { className: 'ad-tabs-more', key: 'tabs-more' },
            h('button', {
              className: 'ad-btn ad-sm',
              'aria-expanded': tabsMoreOpen ? 'true' : 'false',
              'aria-haspopup': 'true',
              title: '窄窗页签收纳（当前：' + (tabLabelOf.get(tab) || tabLabelOfKey(tab)) + '）',
              onClick: () => setTabsMoreOpen((open) => !open),
              'aria-label': '更多页签',
            }, icon('ellipsis')),
            tabsMoreOpen
              ? h('div', { className: 'ad-tabs-more-panel', role: 'menu', 'aria-label': '全部页签' },
                  visibleTabKeys.map((key) => h('button', {
                    key,
                    className: tab === key ? 'ad-btn ad-sm ad-primary' : 'ad-btn ad-sm',
                    role: 'menuitem',
                    'data-on': tab === key ? '1' : '0',
                    onClick: () => { setTabsMoreOpen(false); switchTab(key) },
                  }, tabLabelOf.get(key) || tabLabelOfKey(key))))
              : null),
          h('div', { className: 'ad-tabs-agent', key: 'tabs-agent' },
            h('button', {
              className: 'ad-btn ad-sm',
              'aria-label': '生成交接指令并复制，交给 Agent',
              title: '生成交接指令并复制，交给 Agent',
              'aria-haspopup': 'dialog',
              'aria-expanded': handoffOpen ? 'true' : 'false',
              disabled: busy,
              onClick: () => openHandoff(),
            }, icon('send'), h('span', { className: 'ad-agent-label' }, '交给 Agent'))))
        body.push(tabsNode)


        // P2-3：审读定位横幅（跨页签可见，跳转后仍显示目标位置，可一键清除）
        if (reviewJump) {
          body.push(h('div', { className: 'ad-flow-stale', key: 'rv-jump-global', role: 'status' },
            `审读定位：${reviewLocationText(reviewJump)}（已切换到对应页签；镜号可在分镜表查看，场次可在剧本正文查看）`,
            h('button', { className: 'ad-btn ad-sm', style: { marginLeft: 10 }, onClick: () => setReviewJump(null) }, '清除定位')))
        }

        if (tab === 'contract' && contract) {
          body.push(
            h('div', { key: 'c' },
              h('div', { className: 'ad-form-group' },
                h('div', { className: 'ad-sec' }, '基本信息'),
                h(Field, { label: '平台', value: contract.platform, placeholder: '抖音 / 快手 / 红果 / 微信小程序', onChange: (v) => updateContract({ ...contract, platform: v }) }),
                h(Field, { label: '受众', value: contract.audience, onChange: (v) => updateContract({ ...contract, audience: v }) }),
                h('div', { className: 'ad-field' },
                  h('label', null, '单集时长(秒)'),
                  h('input', { className: 'ad-input', type: 'number', value: contract.episodeDurationSec[0], onChange: (e) => updateContract({ ...contract, episodeDurationSec: [Number(e.target.value), contract.episodeDurationSec[1]] }) }),
                  h('span', null, '~'),
                  h('input', { className: 'ad-input', type: 'number', value: contract.episodeDurationSec[1], onChange: (e) => updateContract({ ...contract, episodeDurationSec: [contract.episodeDurationSec[0], Number(e.target.value)] }) })),
                h(Field, { label: '目标集数', value: contract.targetEpisodes, onChange: (v) => updateContract({ ...contract, targetEpisodes: Number(v) || 0 }) }),
                h('div', { className: 'ad-field' },
                  h('label', null, '画幅'),
                  h('select', { className: 'ad-select', value: contract.orientation, onChange: (e) => updateContract({ ...contract, orientation: e.target.value }) },
                    h('option', { value: 'portrait' }, '竖屏'), h('option', { value: 'landscape' }, '横屏')))),
              h('div', { className: 'ad-form-group' },
                h('div', { className: 'ad-sec' }, '创作约束'),
                h(TextField, { label: '钩子密度', rows: 2, value: contract.hookDensity, placeholder: '例如：每 30 秒一个钩子（可多行）', onChange: (v) => updateContract({ ...contract, hookDensity: v }) })),
              h('div', { className: 'ad-form-group' },
                h('div', { className: 'ad-sec' }, '审核红线'),
                h(TextField, { label: '审核红线', rows: 4, value: contract.redlines, onChange: (v) => updateContract({ ...contract, redlines: v }) })),
              h('details', { className: 'ad-form-group ad-contract-world', key: 'contract-world' },
                h('summary', { className: 'ad-contract-world-summary' },
                  '八大设定（可选）',
                  h('span', { className: 'ad-count' }, contractWorldFilledCount(contract) > 0 ? `已填 ${contractWorldFilledCount(contract)}/8` : '未填写')),
                h('div', { className: 'ad-path', style: { marginTop: 8 } }, '世界观型长文本设定（可选，留空不落盘）。建议优先：灵魂/生死/因果、力量体系、地理与空间。'),
                h('div', { className: 'ad-contract-world-grid' },
                  CONTRACT_WORLD_FIELDS.map(([key, label, limit, placeholder]) => {
                    const value = contractWorldValue(contract, key)
                    const trimmedLength = value.trim().length
                    return h('div', { className: 'ad-field', key },
                      h('label', null, label, ' ',
                        h('span', { className: 'ad-count', 'data-over': trimmedLength > limit ? '1' : '0' }, `${trimmedLength}/${limit}`)),
                      h('textarea', {
                        className: 'ad-area',
                        rows: 3,
                        value,
                        placeholder,
                        'aria-label': `${label}（上限 ${limit} 字）`,
                        onChange: (e) => updateContract({ ...contract, [key]: e.target.value }),
                      }))
                  }))),
              h('div', { className: 'ad-form-group ad-contract-footer', key: 'contract-save' },
                h('div', { className: 'ad-row', style: { gap: 8, flexWrap: 'wrap' } },
                  h('button', { className: 'ad-btn ad-primary', onClick: saveContract, disabled: busy, 'aria-keyshortcuts': 'Control+S Meta+S' }, '保存契约'),
                  dirty.contract ? dirtyMark('contract') : null,
                  h('span', { className: 'ad-sub' }, 'Ctrl/⌘+S 保存本页')),
                h('div', { className: 'ad-path', style: { marginTop: 6 } }, '剧集契约是后续 AI 生成时的强约束输入（FR-B01），同时会渲染到 剧集契约.md。')),
            ),
          )
        }

        if (tab === 'contract' && !contract) {
          body.push(emptyState({
            key: 'c-empty',
            title: '未读取到剧集契约',
            description: '契约文件缺失或读取失败；重新载入项目数据后可重试。',
            next: '重新载入项目数据（只读，不会修改磁盘文件）',
            actions: [{ label: '重新载入项目', onClick: () => openProject(openTitle), disabled: busy }],
          }))
        }

        if (tab === 'outline') {
          body.push(
            h('div', { key: 'o' },
              h('div', { className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap' } },
                h('button', { className: 'ad-btn ad-sm', onClick: addRow, disabled: busy }, icon('plus'), '增加一集'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveOutline, disabled: busy, 'aria-keyshortcuts': 'Control+S Meta+S' }, '保存总纲'),
                dirty.outline ? dirtyMark('outline') : null,
                h('span', { className: 'ad-sub' }, 'Ctrl/⌘+S 保存本页')),
              h('table', { className: 'ad-table' },
                h('caption', { className: 'ad-sr-only' }, '总纲分集表'),
                h('thead', null, h('tr', null,
                  ['集数', '标题', '一句话梗概', '开场钩子', '中段反转', '结尾悬念', '时长(秒)', ''].map((t, i) => h('th', { key: i, scope: 'col' }, t)))),
                h('tbody', null,
                  rows.length
                    ? rows.map((row, i) =>
                        h('tr', { key: i },
                          h('td', null, h('input', { value: row.order, onChange: (e) => setRow(i, 'order', Number(e.target.value) || 0) })),
                          h('td', null, h('input', { value: row.title, onChange: (e) => setRow(i, 'title', e.target.value) })),
                          h('td', null, h('input', { value: row.logline, onChange: (e) => setRow(i, 'logline', e.target.value) })),
                          h('td', null, h('input', { value: row.hook, onChange: (e) => setRow(i, 'hook', e.target.value) })),
                          h('td', null, h('input', { value: row.twist, onChange: (e) => setRow(i, 'twist', e.target.value) })),
                          h('td', null, h('input', { value: row.cliffhanger, onChange: (e) => setRow(i, 'cliffhanger', e.target.value) })),
                          h('td', null, h('input', { value: row.estDurationSec, onChange: (e) => setRow(i, 'estDurationSec', Number(e.target.value) || 0) })),
                          h('td', null, h('button', { type: 'button', className: 'ad-btn ad-sm ad-btn-danger ad-icon-btn ad-icon-btn-sm', 'data-tone': 'danger', 'aria-label': '删除该集', title: '删除该集', onClick: () => removeRow(i) }, icon('trash')))))
                    : h('tr', null, h('td', { colSpan: 8, className: 'ad-table-empty' }, '还没有分集，点「增加一集」开始'))),
              ),
              rows.length ? h('div', { className: 'ad-path' }, `合计 ${rows.reduce((s, r) => s + (Number(r.estDurationSec) || 0), 0)} 秒`) : null,
            ),
          )
        }

        if (tab === 'characters') {
          body.push(
            h('div', { key: 'ch' },
              h('div', { className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap' } },
                h('button', { className: 'ad-btn ad-sm', onClick: addCard, disabled: busy }, icon('plus'), '增加角色'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveCharacters, disabled: busy, 'aria-keyshortcuts': 'Control+S Meta+S' }, '保存人物卡'),
                dirty.characters ? dirtyMark('characters') : null,
                h('span', { className: 'ad-sub' }, 'Ctrl/⌘+S 保存本页')),
              h('div', { className: 'ad-grid' },
                characters.length
                  ? characters.map((card, i) =>
                      h('div', { className: 'ad-box', key: i },
                        h('div', { className: 'ad-row', style: { marginBottom: 8 } },
                          h('input', { className: 'ad-input', placeholder: '角色姓名', value: card.name, onChange: (e) => setCard(i, 'name', e.target.value) }),
                          h('select', { className: 'ad-select', value: card.role, onChange: (e) => setCard(i, 'role', e.target.value) },
                            ROLES.map((r) => h('option', { key: r, value: r }, r))),
                          h('button', { type: 'button', className: 'ad-btn ad-sm ad-icon-btn', 'data-tone': 'danger', 'aria-label': '删除人物', title: '删除人物', onClick: () => removeCard(i) }, h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' }, h('path', { d: 'M2.5 4.2h11M6 4.2V2.9c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.3M4.2 4.2l.5 8.6c0 .6.5 1 1.1 1h4.4c.6 0 1.1-.4 1.1-1l.5-8.6M6.6 6.8v4.4M9.4 6.8v4.4' })))),
                        h(Field, { label: '性格', value: (card.personality || []).join('、'), placeholder: '冷静、护短', onChange: (v) => setCard(i, 'personality', v) }),
                        h(Field, { label: '形象提示词', value: card.appearancePrompt, onChange: (v) => setCard(i, 'appearancePrompt', v) }),
                        h(Field, { label: '音色', value: card.voiceHint, onChange: (v) => setCard(i, 'voiceHint', v) }),
                        h(TextField, { label: '小传', rows: 3, value: card.bio, onChange: (v) => setCard(i, 'bio', v) })))
                  : emptyState({ key: 'characters-empty', title: '还没有角色', description: '先建主角/反派/配角，后续生成会引用人物卡。', next: '点上方「+ 增加角色」开始', actions: [{ label: '增加角色', onClick: addCard, disabled: busy }] })),
            ),
          )
        }

        if (tab === 'episode') {
          // v0.15.2（task-112）：剧本页内「正文 | 台词」视图（不新增页签；legacy dialogue 重定向落入台词视图）。
          body.push(
            h('div', { key: 'ep-viewtabs', className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap', gap: 8 } },
              h('button', { type: 'button', className: 'ad-btn ad-sm', 'aria-pressed': episodeView === 'text', onClick: () => { setEpisodeView('text'); setDialogueRedirectNotice(false) } }, '正文'),
              h('button', { type: 'button', className: 'ad-btn ad-sm', 'aria-pressed': episodeView === 'dialogue', onClick: () => setEpisodeView('dialogue') }, '台词'),
              h('span', { className: 'ad-sub' }, '剧本页内视图切换（原「台词与音效」页签已并入本页）')),
            dialogueRedirectNotice
              ? h('div', { className: 'ad-warn', key: 'dlg-redirect', role: 'status' }, '原「台词与音效」页签已并入「剧本」页 · 台词视图（无数据迁移）',
                  h('button', { type: 'button', className: 'ad-btn ad-sm', style: { marginLeft: 8 }, onClick: () => setDialogueRedirectNotice(false) }, '知道了'))
              : null,
          )
          if (episodeView === 'dialogue') {
            const dialogueLines = dialogue && Array.isArray(dialogue.lines) ? dialogue.lines : []
            const dialogueSfx = dialogue && Array.isArray(dialogue.sfx) ? dialogue.sfx : []
            const episodeOptions = [...new Set(dialogueLines.map((line) => Number(line.episode)).filter((order) => Number.isFinite(order) && order > 0))].sort((a, b) => a - b)
            const characterOptions = dialogue && Array.isArray(dialogue.byCharacter) ? dialogue.byCharacter.map((item) => item.character).filter(Boolean) : []
            const episodeFilterValue = dialogueEpisodeFilter === 'all' ? 'all' : String(dialogueEpisodeFilter)
            const characterFilterValue = dialogueCharacterFilter || 'all'
            const filteredLines = dialogueLines.filter((line) => (episodeFilterValue === 'all' || String(line.episode) === episodeFilterValue) && (characterFilterValue === 'all' || line.character === characterFilterValue))
            const filteredSfx = dialogueSfx.filter((item) => episodeFilterValue === 'all' || String(item.episode) === episodeFilterValue)
            body.push(
              h('div', { key: 'ep-dialogue', className: 'ad-episode-dialogue' },
                h('div', { className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap', gap: 8 } },
                  h('button', { className: 'ad-btn ad-primary ad-sm', onClick: loadDialogue, disabled: busy }, '刷新台词'),
                  h('button', { className: 'ad-btn ad-sm', onClick: exportVoiceScript, disabled: busy }, '导出配音稿'),
                  h('label', { className: 'ad-sub' }, '集数'),
                  h('select', { className: 'ad-input ad-sm', 'aria-label': '台词按集筛选', value: episodeFilterValue, onChange: (e) => setDialogueEpisodeFilter(e.target.value === 'all' ? 'all' : Number(e.target.value)) },
                    h('option', { value: 'all' }, '全部集'),
                    episodeOptions.map((order) => h('option', { key: order, value: String(order) }, `第 ${order} 集`))),
                  h('label', { className: 'ad-sub' }, '角色'),
                  h('select', { className: 'ad-input ad-sm', 'aria-label': '台词按角色筛选', value: characterFilterValue, onChange: (e) => setDialogueCharacterFilter(e.target.value) },
                    h('option', { value: 'all' }, '全部角色'),
                    characterOptions.map((character) => h('option', { key: character, value: character }, character))),
                  h('span', { className: 'ad-sub' }, '从分集剧本自动抽取「角色：台词」；音效取自分镜表；只读')),
                dialogue
                  ? h('div', null,
                      h('div', { className: 'ad-sec', style: { marginTop: 4 } }, `角色戏份 · ${characterOptions.length} 人 / ${dialogueLines.length} 句 · 当前筛选 ${filteredLines.length} 句`),
                      h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 6, marginBottom: 12 } },
                        (dialogue.byCharacter || []).map((item) => h('span', { className: 'ad-count', key: item.character },
                          `${item.character} ${item.count} 句（第 ${item.episodes.join('、')} 集）`))),
                      h('div', { className: 'ad-sec' }, '逐句台词'),
                      filteredLines.length
                        ? h('div', { className: 'ad-hits', style: { maxHeight: 320, overflow: 'auto' } },
                            filteredLines.slice(0, 300).map((line, index) =>
                              h('div', { className: 'ad-hit', key: index },
                                h('div', { className: 'ad-hit-path' }, `第 ${line.episode} 集 · ${line.scene || '—'}`),
                                h('div', null, h('strong', null, line.character + '：'), line.text))))
                        : h('div', { className: 'ad-table-empty' }, dialogueLines.length ? '当前筛选没有台词（换个集数 / 角色试试）' : '还没有台词数据，点「刷新台词」从分集剧本抽取'),
                      filteredLines.length > 300 ? h('div', { className: 'ad-count' }, `（仅显示前 300 句，共 ${filteredLines.length} 句）`) : null,
                      filteredSfx.length
                        ? h('div', null,
                            h('div', { className: 'ad-sec' }, `音效 · ${filteredSfx.length} 条（只读，来自分镜表）`),
                            h('div', { className: 'ad-hits' },
                              filteredSfx.slice(0, 100).map((item, index) =>
                                h('div', { className: 'ad-hit', key: index },
                                  h('div', { className: 'ad-hit-path' }, `第 ${item.episode} 集 · ${item.shotNumber}`),
                                  h('div', null, item.sfx)))))
                        : null)
                  : emptyState({ key: 'dialogue-empty', title: '还没有台词数据', description: '从分集剧本自动抽取「角色：台词」，并生成可交付的配音稿。', next: '点上方「刷新台词」开始', actions: [{ label: '刷新台词', onClick: loadDialogue, disabled: busy }] })),
            )
          } else {
          const scenes = parseEpisodeScenes(episodeText)
          const episodeIsLoaded = loadedEpisodeOrder === (Number(episodeOrder) || 1)
          body.push(
            h('div', { key: 'ep' },
              h('div', { className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap' } },
                h('label', { className: 'ad-sub' }, '集数'),
                h('input', { className: 'ad-input', style: { maxWidth: 100 }, type: 'number', value: episodeOrder, onChange: (e) => setEpisodeOrder(Number(e.target.value) || 1) }),
                h('button', { className: 'ad-btn ad-sm', onClick: () => requestLeave(() => loadEpisode(episodeOrder)), disabled: busy }, '载入'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveEpisode, disabled: busy, 'aria-keyshortcuts': 'Control+S Meta+S', title: episodeIsLoaded ? '保存本集到磁盘' : '未载入时保存会被拦截（防止覆盖磁盘已有内容）' }, '保存本集'),
                dirty.episode ? dirtyMark('episode') : null,
                h('span', { className: 'ad-sub' }, 'Ctrl/⌘+S 保存'),
                episodes.length ? h('span', { className: 'ad-sub' }, `已有：${episodes.map((e) => '第' + e.order + '集').join('、')}`) : null),
              saveBlock && saveBlock.scope === 'episode'
                ? h('div', { className: 'ad-warn', key: 'ep-block', role: 'alert' }, saveBlock.text)
                : null,
              episodeLoadError
                ? h('div', { className: 'ad-warn', key: 'ep-load-err', role: 'alert' }, episodeLoadError,
                    h('button', { className: 'ad-btn ad-sm', style: { marginLeft: 8 }, onClick: () => requestLeave(() => loadEpisode(episodeOrder)), disabled: busy }, '重试载入'))
                : null,
              !episodeIsLoaded && !episodeLoadError
                ? h('div', { className: 'ad-hint-next', key: 'ep-unloaded' }, `第 ${episodeOrder} 集尚未载入：点「载入」可查看磁盘内容；若是新集，可直接保存创建（未载入且磁盘已有内容时保存会被拦截）。`)
                : null,
              h('textarea', {
                className: 'ad-area',
                rows: 22,
                placeholder: '## 场景 1：内景 - 当铺 - 夜\n\n动作：…\n\n林越：这钱，我三天还你。\n\n转场：切至',
                value: episodeText,
                onChange: (e) => {
                  setEpisodeText(e.target.value)
                  markDirty('episode')
                },
                onKeyDown: (e) => {
                  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                    e.preventDefault()
                    if (!busy) saveEpisode()
                  }
                },
              }),
              h('div', { className: 'ad-path' }, `保存到 分集剧本/第${String(episodeOrder).padStart(3, '0')}集.md`,
                dirty.episode ? h('span', { className: 'ad-dirty', style: { marginLeft: 8 } }, '● 尚未保存') : null),
              !episodes.length
                ? h('div', { className: 'ad-hint-next' }, `还没有分集文件：保存本集会创建第 ${episodeOrder} 集（集数可在上方修改）。`)
                : null,
              scenes.length
                ? h('div', null,
                    h('div', { className: 'ad-sec' }, `场次分块预览 · ${scenes.length} 场（只读）`),
                    h('div', { className: 'ad-scenes' },
                      scenes.map((scene, i) =>
                        h('div', { className: 'ad-scene', key: i },
                          h('div', { className: 'ad-scene-head' },
                            `${scene.interior ? '内景' : '外景'} · ${scene.location || '未标地点'}${scene.time ? ' · ' + scene.time : ''}`),
                          h('div', { className: 'ad-scene-meta' },
                            `场景 ${scene.no} · ${scene.dialogueCount} 句对白` +
                            `${scene.characters.length ? ' · ' + scene.characters.join('、') : ''} · ${scene.lines.length} 行`),
                          h('div', { className: 'ad-scene-line' },
                            scene.lines.join('\n').slice(0, 240) + (scene.lines.join('\n').length > 240 ? '…' : ''))))),
                    h('div', { className: 'ad-path' }, '按「## 场景 N：内景/外景 - 地点 - 时间」自动识别；P1 仅做只读预览（N-9 降级，场次级结构化编辑列 P2）。'))
                : (episodeText.trim()
                    ? h('div', { className: 'ad-path' }, '未识别到「## 场景 …」标题；在正文中加入场次标题后会自动分块预览。')
                    : null),
              h('div', { className: 'ad-sec' }, '定稿与回滚'),
              h('div', { className: 'ad-row', style: { marginBottom: 8 } },
                h('button', { className: 'ad-btn ad-sm', onClick: finalizeEpisode, disabled: busy }, `定稿第 ${episodeOrder} 集`),
                h('button', { className: 'ad-btn ad-sm', onClick: loadFinalized, disabled: busy }, icon('refresh'), '刷新定稿记录'),
                h('span', { className: 'ad-sub' }, '定稿会把当前剧本与分镜冻结成带版本号的快照，随时可回滚')),
              finalized.length
                ? h('table', { className: 'ad-table' },
                  h('caption', { className: 'ad-sr-only' }, '定稿版本记录表'),
                    h('thead', null, h('tr', null, ['集数', '最新版本', '定稿时间', '行数', '镜头数', '快照文件', '操作'].map((t, i) => h('th', { key: i, scope: 'col' }, t)))),
                    h('tbody', null,
                      finalized.map((f) =>
                        h('tr', { key: f.order },
                          h('td', null, `第 ${f.order} 集`),
                          h('td', null, 'v' + f.version),
                          h('td', null, String(f.finalizedAt || '').replace('T', ' ').slice(0, 19)),
                          h('td', null, String(f.lines)),
                          h('td', null, String(f.shots)),
                          h('td', { className: 'ad-count', style: { maxWidth: 220, wordBreak: 'break-all' } },
                            (f.files || []).join('、') || '—'),
                          h('td', null,
                            h('div', { className: 'ad-row', style: { gap: 4 } },
                              h('button', { className: 'ad-btn ad-sm ad-btn-danger', onClick: () => restoreFinalized(f.order, f.version), disabled: busy }, `回滚最新 v${f.version}`),
                              f.version > 1
                                ? h('button', { className: 'ad-btn ad-sm', onClick: () => restoreFinalizedVersion(f), disabled: busy }, '指定版本…')
                                : null))))))
                : emptyState({ key: 'finalized-empty', title: '还没有定稿记录', description: '剧本满意后点「定稿」，形成可回滚的版本。', next: '先在剧本页点「定稿第 N 集」' }),
              h('div', { className: 'ad-sec' }, '导入已有剧本'),
              h('div', { className: 'ad-row', style: { marginBottom: 8 } },
                h('button', { className: 'ad-btn ad-sm', onClick: () => setShowImport((v) => !v) }, showImport ? '收起导入' : '展开导入'),
                h('span', { className: 'ad-sub' }, '按「# 第N集」切分集数、「## 场景」识别场次；先预览再落盘')),
              showImport
                ? h('div', null,
                    h('textarea', {
                      className: 'ad-area',
                      rows: 8,
                      placeholder: '# 第1集 刀在颈侧\n\n## 场景 1：内景 - 当铺 - 夜\n\n动作：…\n\n林越：这钱我三天还你。',
                      value: importText,
                      onChange: (e) => setImportText(e.target.value),
                    }),
                    h('div', { className: 'ad-row', style: { marginTop: 8 } },
                      h('button', { className: 'ad-btn ad-sm', onClick: previewImport, disabled: busy || !importText.trim() }, '预览切分'),
                      h('button', { className: 'ad-btn ad-primary ad-sm', onClick: applyImport, disabled: busy || !importText.trim() }, '导入到项目'),
                      h('span', { className: 'ad-sub' }, '已存在的集默认跳过，不覆盖')),
                    importPreview
                      ? h('div', { style: { marginTop: 10 } },
                          h('div', { className: 'ad-count', style: { marginBottom: 6 } },
                            `识别到 ${importPreview.stats.episodes} 集 / ${importPreview.stats.scenes} 场 / ${importPreview.stats.lines} 行` +
                            (importPreview.written ? ` · 已写入 ${importPreview.written.length} 集` : '') +
                            (importPreview.skipped && importPreview.skipped.length ? ` · 跳过 ${importPreview.skipped.length} 集` : '')),
                          h('table', { className: 'ad-table' },
                            h('caption', { className: 'ad-sr-only' }, '导入切分预览表'),
                            h('thead', null, h('tr', null, ['集数', '标题', '场次', '行数', '角色'].map((t, i) => h('th', { key: i, scope: 'col' }, t)))),
                            h('tbody', null,
                              importPreview.episodes.map((e) =>
                                h('tr', { key: e.order },
                                  h('td', null, e.order),
                                  h('td', null, e.title || '—'),
                                  h('td', null, e.scenes),
                                  h('td', null, e.lines),
                                  h('td', null, (e.characters || []).join('、') || '—'))))))
                      : null)
                : null,
            ),
          )
          }
        }

        if (tab === 'storyboard') {
          const total = shots.reduce((s, x) => s + (Number(x.durationSec) || 0), 0)
          // v0.10.4（task-91）：v0.10.0 add-only per-shot 字段只读展示。
          // 仅当本集任一镜含新字段时才条件追加「详情」列/展开行；旧项目/无字段时表格与 v0.10.3 完全一致（10 列）。
          const shotExtraEntries = shotExtraEntriesMemo
          const hasExtraFields = shotExtraEntries.some((entries) => entries.length > 0)
          const columnCount = hasExtraFields ? 11 : 10
          const headerLabels = ['镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长(秒)', '提示词', '视频提示词', '操作']
          if (hasExtraFields) headerLabels.push('详情')
          const shotsAreLoaded = loadedShotsOrder === (Number(episodeOrder) || 1)
          body.push(
            h('div', { key: 'sb' },
              h('div', { className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap' } },
                h('label', { className: 'ad-sub' }, '集数'),
                h('input', { className: 'ad-input', style: { maxWidth: 100 }, type: 'number', value: episodeOrder, onChange: (e) => setEpisodeOrder(Number(e.target.value) || 1) }),
                h('button', { className: 'ad-btn ad-sm', onClick: () => requestLeave(() => loadShots(episodeOrder)), disabled: busy }, '载入'),
                h('button', { className: 'ad-btn ad-sm', onClick: addShot, disabled: busy }, icon('plus'), '增加镜头'),
                h('button', { className: 'ad-btn ad-sm', onClick: renumberShots, disabled: busy || !shots.length }, '自动重编号'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveShots, disabled: busy, 'aria-keyshortcuts': 'Control+S Meta+S', title: shotsAreLoaded ? '保存本集分镜到磁盘' : '未载入时保存会被拦截（防止覆盖磁盘分镜）' }, '保存分镜'),
                dirty.storyboard ? dirtyMark('storyboard') : null,
                h('span', { className: 'ad-sub' }, 'Ctrl/⌘+S 保存；↑↓ 调整顺序；保存后写入 分镜/第' + String(episodeOrder).padStart(3, '0') + '集.分镜')),
              saveBlock && saveBlock.scope === 'storyboard'
                ? h('div', { className: 'ad-warn', key: 'sb-block', role: 'alert' }, saveBlock.text)
                : null,
              shotsLoadError
                ? h('div', { className: 'ad-warn', key: 'sb-load-err', role: 'alert' }, shotsLoadError,
                    h('button', { className: 'ad-btn ad-sm', style: { marginLeft: 8 }, onClick: () => requestLeave(() => loadShots(episodeOrder)), disabled: busy }, '重试载入'))
                : null,
              !shotsAreLoaded && !shotsLoadError
                ? h('div', { className: 'ad-hint-next', key: 'sb-unloaded' }, `第 ${episodeOrder} 集分镜尚未载入：点「载入」确认磁盘内容后再保存（未载入时保存会被拦截）。`)
                : null,
              h('table', { className: 'ad-table' },
                h('caption', { className: 'ad-sr-only' }, '分镜表'),
                h('thead', null, h('tr', null,
                  headerLabels.map((t, i) => h('th', { key: i, scope: 'col' }, t)))),
                h('tbody', null,
                  shots.length
                    ? shots.flatMap((shot, i) => {
                        const extraEntries = shotExtraEntries[i] || []
                        const detailOpen = shotExtraOpen === i
                        const row = h('tr', { key: `shot-${i}` },
                          h('td', null, h('input', { value: shot.shotNumber, onChange: (e) => setShot(i, 'shotNumber', e.target.value) })),
                          h('td', null, h('select', { value: shot.shotSize, onChange: (e) => setShot(i, 'shotSize', e.target.value) }, shotSizeOptionEls)),
                          h('td', null, h('input', { value: shot.cameraMove, onChange: (e) => setShot(i, 'cameraMove', e.target.value) })),
                          h('td', null, h('textarea', { rows: 2, value: shot.description, onChange: (e) => setShot(i, 'description', e.target.value) })),
                          h('td', null, h('textarea', { rows: 2, value: shot.dialogue, onChange: (e) => setShot(i, 'dialogue', e.target.value) })),
                          h('td', null, h('input', { value: shot.sfx, onChange: (e) => setShot(i, 'sfx', e.target.value) })),
                          h('td', null, h('input', { value: shot.durationSec, onChange: (e) => setShot(i, 'durationSec', Number(e.target.value) || 0) })),
                          h('td', null, h('textarea', { rows: 2, value: shot.imagePrompt, onChange: (e) => setShot(i, 'imagePrompt', e.target.value) })),
                          h('td', null,
                            hostFlags.p1
                              ? h('textarea', { rows: 2, value: shot.videoPrompt || '', placeholder: '视频提示词（可选）', onChange: (e) => setShot(i, 'videoPrompt', e.target.value) })
                              : h('span', { className: 'ad-count', title: shot.videoPrompt || '宿主 v0.4.0+ 才持久化该字段' }, shot.videoPrompt || '—')),
                          h('td', null,
                            h('div', { className: 'ad-row', style: { gap: 4 } },
                              h('button', { className: 'ad-btn ad-sm', title: '上移', 'aria-label': '上移镜头', onClick: () => moveShot(i, -1), disabled: busy || i === 0 }, '↑'),
                              h('button', { className: 'ad-btn ad-sm', title: '下移', 'aria-label': '下移镜头', onClick: () => moveShot(i, 1), disabled: busy || i === shots.length - 1 }, '↓'),
                              h('button', { type: 'button', className: 'ad-btn ad-sm ad-btn-danger ad-icon-btn ad-icon-btn-sm', 'data-tone': 'danger', 'aria-label': '删除该镜', title: '删除该镜', onClick: () => removeShot(i), disabled: busy }, icon('trash')))),
                          hasExtraFields
                            ? h('td', null, extraEntries.length
                                ? h('button', {
                                    className: 'ad-btn ad-sm',
                                    'aria-label': `查看第 ${shot.shotNumber || i + 1} 镜高级字段`,
                                    title: '只读展示 v0.10.0 分镜高级字段（不写盘）',
                                    onClick: () => setShotExtraOpen(detailOpen ? null : i),
                                  }, detailOpen ? '收起 ▴' : '详情 ▾')
                                : null)
                            : null)
                        if (!hasExtraFields || !extraEntries.length || !detailOpen) return [row]
                        const detailRow = h('tr', { key: `detail-${i}` },
                          h('td', { colSpan: columnCount },
                            h('div', {
                              className: 'ad-shot-extras',
                              role: 'note',
                              'aria-label': `第 ${shot.shotNumber || i + 1} 镜高级字段（只读）`,
                            },
                              h('div', { className: 'ad-sub', style: { marginBottom: 4 } }, `第 ${shot.shotNumber || i + 1} 镜 · 高级字段（只读，来自宿主 v0.10.0+）`),
                              extraEntries.map(([label, value]) => h('div', { className: 'ad-shot-extra', key: label },
                                h('strong', null, label + '：'), value)))))
                        return [row, detailRow]
                      })
                    : h('tr', null, h('td', { colSpan: columnCount, className: 'ad-table-empty' }, '本集还没有镜头，点「增加镜头」或先载入已有分镜'))),
              ),
              // v0.11.2（task-99）：分镜分组（groups add-only）只读区；仅 groups 非空时渲染（旧项目零新显示）。
              shotGroups && shotGroups.length
                ? h('div', { className: 'ad-groups', 'aria-label': '分镜分组（只读）' },
                    h('div', { className: 'ad-row', style: { marginBottom: 6, alignItems: 'center', gap: 8 } },
                      h('span', { className: 'ad-sec', style: { margin: 0 } }, `分组 · ${shotGroups.length} 组（只读，来自宿主分组 sidecar）`),
                      shotGroupsTruncated ? h('span', { className: 'ad-count' }, '仅展示前 100 组') : null),
                    shotGroups.map((group, groupIndex) => h('div', {
                      className: 'ad-group',
                      key: `${group.groupId || 'group'}-${groupIndex}`,
                      'aria-label': `第 ${groupIndex + 1} 组${group.name ? `：${group.name}` : ''}（只读）`,
                    },
                      h('div', null,
                        group.groupId ? h('strong', null, `#${group.groupId} `) : null,
                        h('strong', null, group.name || '（未命名分组）'),
                        group.emotionCue ? h('span', { className: 'ad-count', style: { marginLeft: 8 } }, `情绪总控：${group.emotionCue}`) : null),
                      group.shotNumbers.length
                        ? h('div', { className: 'ad-count', style: { marginTop: 2 } },
                            `镜号：${group.shotNumbers.slice(0, 20).join('、')}${group.shotNumbers.length > 20 ? ` 等 ${group.shotNumbers.length} 镜` : ''}`)
                        : null,
                      group.groupPrompt
                        ? h('div', {
                            className: 'ad-group-prompt',
                            role: 'note',
                            'aria-label': `第 ${groupIndex + 1} 组草帽视图（只读）`,
                          },
                            h('div', { className: 'ad-sub', style: { marginBottom: 2 } }, '草帽视图（只读）'),
                            group.groupPrompt)
                        : null)))
                : null,
              !hostFlags.p1
                ? h('div', { className: 'ad-warn' }, '当前宿主版本 < 0.4.0：「视频提示词」列只读展示（宿主 v0.4.0+ 才持久化；升级插件后自动可编辑）。')
                : null,
              shots.length ? h('div', { className: 'ad-path' }, `共 ${shots.length} 个镜头，合计 ${total} 秒`) : null,
            ),
          )
        }

        if (tab === 'assets') {
          // v0.15.1（task-108 / B2S-C）：素材库分类 + 图片可见（只读，迭代 1）。
          // 数据：assets-get 响应 add-only `cards`（旧 assets 字段与旧视图原样保留；无 cards → 零新显示）。
          const visibleAssetCards = filterAssetCards(assetCards, assetTypeFilter, assetQuery)
          const typeCounts = new Map()
          for (const card of assetCards) {
            const typeKey = String(card.type || '').toUpperCase()
            typeCounts.set(typeKey, (typeCounts.get(typeKey) || 0) + 1)
          }
          const typeChips = ASSET_TYPE_ORDER.filter(([type]) => typeCounts.has(type))
          const selectedCard = assetCards.find((card) => card.id === assetSelectedId) || null
          const markBroken = (src) => setAssetBrokenImages((prev) => (prev[src] ? prev : { ...prev, [src]: true }))
          const assetPlaceholder = (text, className) => h('span', { className: className || 'ad-asset-placeholder' }, text)
          const assetImageNode = (raw, options) => {
            const opts = options || {}
            const src = assetImageSourceOf(raw)
            if (src.kind === 'http') {
              if (assetBrokenImages[src.value]) return assetPlaceholder('图片加载失败', opts.placeholderClass)
              return h('img', {
                className: opts.className || '',
                src: src.value,
                alt: opts.alt || '素材图片',
                loading: 'lazy',
                onError: () => markBroken(src.value),
              })
            }
            if (src.kind === 'relative') {
              const cached = assetImageCache[src.value]
              if (cached && cached.status === 'ok') return h('img', { className: opts.className || '', src: cached.dataUrl, alt: opts.alt || '素材图片', loading: 'lazy' })
              if (cached && cached.status === 'error') return assetPlaceholder('图片读取失败', opts.placeholderClass)
              return assetPlaceholder('加载中…', opts.placeholderClass)
            }
            if (src.kind === 'absolute') return assetPlaceholder('本地路径不可预览', opts.placeholderClass)
            return assetPlaceholder('无图', opts.placeholderClass)
          }
          const assetCardThumb = (card) => {
            const media = card.media || null
            const raw = media ? media.thumbnail || (media.images && media.images[0]) || '' : ''
            const src = assetImageSourceOf(raw)
            if (src.kind === 'http' && !assetBrokenImages[src.value]) {
              return h('span', { className: 'ad-asset-thumb' }, h('img', { src: src.value, alt: `${card.name} 缩略图`, loading: 'lazy', onError: () => markBroken(src.value) }))
            }
            if (src.kind === 'relative') {
              const cached = assetImageCache[src.value]
              if (cached && cached.status === 'ok') return h('span', { className: 'ad-asset-thumb' }, h('img', { src: cached.dataUrl, alt: `${card.name} 缩略图`, loading: 'lazy' }))
              if (cached && cached.status === 'error') return h('span', { className: 'ad-asset-thumb' }, h('span', { className: 'ad-asset-placeholder' }, '图片读取失败'))
              return h('span', { className: 'ad-asset-thumb' }, h('span', { className: 'ad-asset-placeholder' }, '加载中…'))
            }
            const fallbackText = src.kind === 'absolute' ? '本地路径不可预览' : src.kind === 'invalid' ? '图片地址无效' : '无图'
            return h('span', { className: 'ad-asset-thumb' }, h('span', { className: 'ad-asset-placeholder' }, `${assetTypeLabelOf(card.type)} · ${fallbackText}`))
          }
          const assetDetail = (card) => {
            const media = card.media || null
            const images = media && Array.isArray(media.images) ? media.images : []
            const candidates = images.length ? images : media && media.thumbnail ? [media.thumbnail] : []
            const currentIndex = Math.min(Math.max(assetImageIndex, 0), Math.max(candidates.length - 1, 0))
            const currentImage = candidates[currentIndex] || ''
            const fieldEntries = assetFieldEntries(card)
            return h('div', { className: 'ad-asset-detail', 'aria-label': `资产详情 ${card.id}` },
              h('div', { className: 'ad-asset-detail-head' },
                h('strong', null, `${card.id} ${card.name}`),
                h('span', { className: 'ad-asset-badge' }, assetTypeLabelOf(card.type)),
                h('span', { className: 'ad-count' }, `${card.status || '—'} · v${card.version || 1}`),
                h('div', { style: { flex: 1 } }),
                h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: () => setAssetSelectedId(null) }, '关闭详情')),
              candidates.length
                ? h('div', { className: 'ad-asset-detail-main' }, assetImageNode(currentImage, { className: 'ad-asset-detail-img', alt: `${card.name} 大图 ${currentIndex + 1}` }))
                : h('div', { className: 'ad-asset-detail-empty' }, '该资产暂无图片（media.images 为空）'),
              candidates.length > 1
                ? h('div', { className: 'ad-asset-detail-thumbs', role: 'group', 'aria-label': '切换图片' },
                    candidates.map((raw, index) => h('button', {
                      key: index,
                      type: 'button',
                      className: 'ad-asset-detail-thumb',
                      'aria-label': `查看第 ${index + 1} 张图片`,
                      'aria-pressed': index === currentIndex,
                      onClick: () => setAssetImageIndex(index),
                    }, assetImageNode(raw, { className: 'ad-asset-detail-thumb-img', alt: `${card.name} 第 ${index + 1} 张` }))))
                : null,
              // v0.15.2（task-112）：角色卡 media.audio 试听（数组；默认 audio[0]，可切换；不 autoplay、不提取时长）
              (() => {
                const audioCandidates = media && Array.isArray(media.audio) ? media.audio : []
                if (!audioCandidates.length) return null
                const currentAudioIndex = Math.min(Math.max(assetAudioIndex, 0), Math.max(audioCandidates.length - 1, 0))
                const audioSource = assetImageSourceOf(audioCandidates[currentAudioIndex] || '')
                const audioLabel = `${card.name} 音色试听第 ${currentAudioIndex + 1} 段`
                const audioNode = (() => {
                  if (audioSource.kind === 'http') {
                    if (assetBrokenAudios[audioSource.value]) return h('div', { className: 'ad-asset-detail-empty' }, '音频不可试听（加载失败）')
                    return h('audio', {
                      className: 'ad-asset-audio-el',
                      controls: true,
                      preload: 'metadata',
                      src: audioSource.value,
                      'aria-label': audioLabel,
                      onError: () => setAssetBrokenAudios((prev) => (prev[audioSource.value] ? prev : { ...prev, [audioSource.value]: true })),
                    })
                  }
                  if (audioSource.kind === 'relative') {
                    const cached = assetImageCache[audioSource.value]
                    if (cached && cached.status === 'ok') return h('audio', { className: 'ad-asset-audio-el', controls: true, preload: 'metadata', src: cached.dataUrl, 'aria-label': audioLabel })
                    if (cached && cached.status === 'error') return h('div', { className: 'ad-asset-detail-empty' }, '音频不可试听（读取失败）')
                    return h('div', { className: 'ad-asset-detail-empty' }, '音频加载中…')
                  }
                  if (audioSource.kind === 'absolute') return h('div', { className: 'ad-asset-detail-empty' }, '本地路径音频不可试听')
                  return h('div', { className: 'ad-asset-detail-empty' }, '音频不可试听')
                })()
                return h('div', { className: 'ad-asset-audio', role: 'group', 'aria-label': '音色参考（试听）' },
                  h('div', { className: 'ad-sec', style: { marginBottom: 4 } }, `音色参考（试听） · ${currentAudioIndex + 1}/${audioCandidates.length}`),
                  audioNode,
                  audioCandidates.length > 1
                    ? h('div', { className: 'ad-asset-detail-thumbs', role: 'group', 'aria-label': '切换音色片段' },
                        audioCandidates.map((raw, index) => h('button', {
                          key: index,
                          type: 'button',
                          className: 'ad-asset-detail-thumb',
                          'aria-label': `试听第 ${index + 1} 段音色`,
                          'aria-pressed': index === currentAudioIndex,
                          onClick: () => setAssetAudioIndex(index),
                        }, `片段 ${index + 1}`)))
                    : null)
              })(),
              fieldEntries.length
                ? h('div', { className: 'ad-asset-fields' }, fieldEntries.map(([label, value], index) => h('div', { className: 'ad-asset-field', key: index },
                    h('span', { className: 'ad-asset-field-label' }, label + '：'),
                    h('span', { className: 'ad-asset-field-value' }, value))))
                : null)
          }

          /* ---------------- v0.15.3（task-115 / VB-C）：视觉圣经只读专区（素材库内视图切换） ---------------- */
          const visualImages = collectVisualImages(assetCards)
          const visualCardById = new Map(assetCards.map((card) => [card.id, card]))
          const visualGroupCounts = new Map(VISUAL_WALL_GROUPS.map((group) => [group.key, visualImages.filter((entry) => visualWallGroupOf(entry.type) === group.key).length]))
          const hasVisualData = Boolean(visualStyle) || visualScenes.length > 0 || visualImages.length > 0
          const visualMatch = (value) => {
            const keyword = visualQuery.trim().toLowerCase()
            if (!keyword) return true
            return String(value == null ? '' : value).toLowerCase().includes(keyword)
          }
          const visualSortList = (list) => list.slice().sort((a, b) => {
            const left = String(a.id || a.cardId || '')
            const right = String(b.id || b.cardId || '')
            const result = left.localeCompare(right, 'en')
            return visualSort === 'id-desc' ? -result : result
          })
          const visualWallImages = visualSortList(visualImages.filter((entry) =>
            (visualType === 'all' || visualWallGroupOf(entry.type) === visualType) && (visualMatch(entry.cardId) || visualMatch(entry.cardName))))
          const visualSceneCards = visualSortList(visualScenes.filter((scene) =>
            (visualType === 'all' || visualType === 'scene') && (visualMatch(scene.id) || visualMatch(scene.name))))
          const visualCharacterCards = visualSortList(assetCards.filter((card) => card.type === 'CHR' &&
            (visualType === 'all' || visualType === 'char') &&
            (visualMatch(card.id) || visualMatch(card.name) || card.aliases.some((alias) => visualMatch(alias)))))
          const visualHeadImage = visualImages.length ? visualImages[0] : null
          const visualShowSceneSection = visualType === 'all' || visualType === 'scene'
          const visualShowCharacterSection = visualType === 'all' || visualType === 'char'
          const visualWallGroups = VISUAL_WALL_GROUPS.map((group) => ({
            key: group.key,
            label: group.label,
            entries: visualWallImages.filter((entry) => visualWallGroupOf(entry.type) === group.key),
          })).filter((group) => group.entries.length > 0)
          const visualGuidanceNode = (text, actions) => h('div', { className: 'ad-visual-empty ad-visual-guidance' },
            h('div', { className: 'ad-visual-guidance-text' }, text),
            Array.isArray(actions) && actions.length
              ? h('div', { className: 'ad-visual-guidance-actions' }, actions.map((action) => h('button', {
                  key: action.label,
                  type: 'button',
                  className: 'ad-btn ad-sm',
                  onClick: action.onClick,
                }, action.label)))
              : null)
          const ensureVisualAssets = () => {
            const paths = []
            for (const entry of visualWallImages.slice(0, 80)) paths.push(entry.src)
            for (const scene of visualSceneCards.slice(0, 40)) paths.push(sceneThumbOf(scene, visualCardById))
            for (const card of visualCharacterCards.slice(0, 40)) {
              if (!card.media) continue
              paths.push(card.media.thumbnail || '')
              for (const image of (card.media.images || []).slice(0, 2)) paths.push(image)
              for (const audio of (card.media.audio || []).slice(0, 2)) paths.push(audio)
            }
            ensureAssetImages(paths)
          }
          const visualImageThumb = (raw, alt) => {
            const src = assetImageSourceOf(raw)
            const broken = src.kind === 'http' && assetBrokenImages[src.value]
            const cached = src.kind === 'relative' ? assetImageCache[src.value] : null
            const openSrc = src.kind === 'http' && !broken ? src.value : cached && cached.status === 'ok' ? cached.dataUrl : ''
            const node = assetImageNode(raw, { className: 'ad-visual-thumb-img', alt })
            if (!openSrc) return h('span', { className: 'ad-visual-thumb' }, node)
            return h('button', {
              type: 'button',
              className: 'ad-visual-thumb',
              'aria-label': `查看大图：${alt}`,
              onClick: (event) => {
                lightboxTriggerEl = event && event.currentTarget ? event.currentTarget : null
                setVisualLightbox({ src: openSrc, alt })
              },
            }, node)
          }
          const visualAudioNode = (card) => {
            const audioCandidates = card.media && Array.isArray(card.media.audio) ? card.media.audio : []
            if (!audioCandidates.length) return null
            const currentIndex = Math.min(Math.max(Number(visualAudioIndex[card.id]) || 0, 0), Math.max(audioCandidates.length - 1, 0))
            const audioSource = assetImageSourceOf(audioCandidates[currentIndex] || '')
            const audioLabel = `${card.name} 音色试听第 ${currentIndex + 1} 段`
            const audioNode = (() => {
              if (audioSource.kind === 'http') {
                if (assetBrokenAudios[audioSource.value]) return h('div', { className: 'ad-visual-empty' }, '音频不可试听（加载失败）')
                return h('audio', {
                  className: 'ad-visual-audio',
                  controls: true,
                  preload: 'metadata',
                  src: audioSource.value,
                  'aria-label': audioLabel,
                  onError: () => setAssetBrokenAudios((prev) => (prev[audioSource.value] ? prev : { ...prev, [audioSource.value]: true })),
                })
              }
              if (audioSource.kind === 'relative') {
                const cached = assetImageCache[audioSource.value]
                if (cached && cached.status === 'ok') return h('audio', { className: 'ad-visual-audio', controls: true, preload: 'metadata', src: cached.dataUrl, 'aria-label': audioLabel })
                if (cached && cached.status === 'error') return h('div', { className: 'ad-visual-empty' }, '音频不可试听（读取失败）')
                return h('div', { className: 'ad-visual-empty' }, '音频加载中…')
              }
              if (audioSource.kind === 'absolute') return h('div', { className: 'ad-visual-empty' }, '本地路径音频不可试听')
              return h('div', { className: 'ad-visual-empty' }, '音频不可试听')
            })()
            return h('div', { className: 'ad-visual-audio-box', role: 'group', 'aria-label': `音色参考（试听）：${card.id}` },
              audioNode,
              audioCandidates.length > 1
                ? h('div', { className: 'ad-visual-audio-switches' }, audioCandidates.map((raw, index) => h('button', {
                    key: index,
                    type: 'button',
                    className: 'ad-asset-chip',
                    'aria-label': `试听 ${card.id} 第 ${index + 1} 段音色`,
                    'aria-pressed': index === currentIndex,
                    onClick: () => setVisualAudioIndex((prev) => ({ ...prev, [card.id]: index })),
                  }, `片段 ${index + 1}`)))
                : null)
          }
          const styleEditorNode = h('div', { className: 'ad-style-editor', key: 'style-editor' },
            h('div', { className: 'ad-style-status', role: 'status', 'aria-live': 'polite' },
              h('span', { className: 'ad-style-state' }, '风格状态：' + String(STYLE_DIRECTION_LABELS[styleStatus] || '草稿')),
              h('span', { className: 'ad-count' }, 'revision ' + String(currentStyleDirection.revision)),
              currentStyleDirection.directedAt ? h('span', null, '定向：' + styleMomentText(currentStyleDirection.directedAt)) : null,
              currentStyleDirection.frozenAt ? h('span', null, '冻结：' + styleMomentText(currentStyleDirection.frozenAt)) : null,
              currentStyleDirection.unfreezeCount > 0
                ? h('span', { className: 'ad-style-badge' }, '解冻 ' + String(currentStyleDirection.unfreezeCount) + ' 次' + (currentStyleDirection.unfreezeCount >= 3 ? ' ⚠️' : ''))
                : null),
            styleStatus === 'frozen'
              ? h('div', { className: 'ad-style-frozen', role: 'note' },
                  h('span', null, '已于 ' + styleMomentText(currentStyleDirection.frozenAt) + ' 冻结，风格只读' + (currentStyleDirection.freezeNote ? '：' + currentStyleDirection.freezeNote : '')),
                  h('button', { className: 'ad-btn ad-sm', onClick: () => openStyleDialog('unfreeze'), disabled: styleBusy }, '解冻'))
              : null,
            h('div', { className: 'ad-style-grid' },
              STYLE_DIMENSION_ORDER.map(([key, label]) => h('div', { className: 'ad-style-field', key },
                h('label', null, label, ' ',
                  h('span', { className: 'ad-style-count' }, String(String(styleDraft[key] == null ? '' : styleDraft[key]).length) + '/' + String(VISUAL_STYLE_TEXT_MAX))),
                h('textarea', {
                  className: 'ad-area',
                  rows: 2,
                  maxLength: VISUAL_STYLE_TEXT_MAX,
                  value: styleDraft[key] == null ? '' : styleDraft[key],
                  disabled: styleFrozen || styleBusy,
                  'aria-label': label + '（上限 ' + String(VISUAL_STYLE_TEXT_MAX) + ' 字）',
                  onChange: (event) => {
                    const value = event.target.value
                    setStyleDraft((prev) => Object.assign({}, prev, { [key]: value }))
                    if (styleError) setStyleError('')
                  },
                })))),
            h('div', { className: 'ad-style-actions' },
              styleStatus === 'draft'
                ? [h('button', { key: 'style-save-draft', className: 'ad-btn ad-primary ad-sm', onClick: () => saveStyle('save'), disabled: styleBusy }, styleBusy ? '保存中…' : '保存草稿'),
                   h('button', { key: 'style-direct', className: 'ad-btn ad-sm', onClick: () => openStyleDialog('direct'), disabled: styleBusy }, '定向确认')]
                : styleStatus === 'directed'
                  ? [h('button', { key: 'style-save-micro', className: 'ad-btn ad-primary ad-sm', onClick: () => openStyleDialog('micro'), disabled: styleBusy }, '保存微调'),
                     h('button', { key: 'style-freeze', className: 'ad-btn ad-sm', onClick: () => openStyleDialog('freeze'), disabled: styleBusy }, '冻结风格')]
                  : [h('button', { key: 'style-unfreeze', className: 'ad-btn ad-primary ad-sm', onClick: () => openStyleDialog('unfreeze'), disabled: styleBusy }, '解冻风格')],
              h('button', { key: 'style-refresh', className: 'ad-btn ad-sm', onClick: () => { refreshStyleState() }, disabled: busy || styleBusy }, '刷新状态')),
            styleNotice ? h('div', { className: 'ad-hint-next', role: 'status', 'aria-live': 'polite' }, styleNotice) : null,
            styleError
              ? h('div', { className: 'ad-err-box', role: 'alert' },
                  h('div', { className: 'ad-err-head' }, '风格操作失败'),
                  h('div', { className: 'ad-err' }, styleError),
                  h('div', { className: 'ad-err-next' }, '可刷新状态后重试；冻结状态需先解冻。'))
              : null)
          const visualStyleNode = h('div', { className: 'ad-visual-section', key: 'visual-style' },
            h('div', { className: 'ad-sec' }, '视觉基调'),
            visualStyle
              ? h('div', { className: 'ad-visual-style' },
                  visualHeadImage ? h('div', { className: 'ad-visual-style-head' }, visualImageThumb(visualHeadImage.src, '视觉基调头图')) : null,
                  h('div', { className: 'ad-visual-style-grid' },
                    STYLE_DIMENSION_ORDER.filter(([key]) => visualStyle[key]).map(([key, label]) => h('div', { className: 'ad-visual-style-dim', key },
                      h('div', { className: 'ad-visual-style-label' }, label),
                      h('div', { className: 'ad-visual-style-text' }, visualStyle[key])))))
              : visualGuidanceNode('暂无风格 DNA。可在下方填写五维风格并保存；也可先在卡片视图查看已登记参考图。', [
                  { label: '交给 Agent', onClick: openHandoff },
                  { label: '去卡片视图', onClick: () => setAssetView('cards') },
                ]),
            styleEditorNode)
          const visualScenesSectionNode = visualShowSceneSection
            ? h('div', { className: 'ad-visual-section', key: 'visual-scenes' },
                h('div', { className: 'ad-sec' }, `场景卡区 · ${visualSceneCards.length}`),
                visualSceneCards.length
                  ? h('div', { className: 'ad-visual-grid' }, visualSceneCards.map((scene) => {
                      const thumb = sceneThumbOf(scene, visualCardById)
                      const meta = [scene.interior, scene.timeOfDay, scene.weather, scene.location].filter(Boolean).join(' · ')
                      return h('div', { className: 'ad-visual-card', key: scene.id },
                        h('div', { className: 'ad-visual-thumb-wrap' }, thumb ? visualImageThumb(thumb, `${scene.id} ${scene.name}`) : h('span', { className: 'ad-visual-placeholder' }, '场景 · 无图')),
                        h('div', { className: 'ad-visual-card-body' },
                          h('strong', null, `${scene.id} ${scene.name}`),
                          meta ? h('div', { className: 'ad-visual-meta' }, meta) : null,
                          scene.lighting ? h('div', { className: 'ad-visual-meta' }, `光源：${scene.lighting.slice(0, 120)}`) : null))
                    }))
                  : visualScenes.length
                    ? h('div', { className: 'ad-visual-empty' }, '当前筛选没有场景卡')
                    : visualGuidanceNode('暂无场景卡。可让 Agent 生成场景卡；或先在素材库为场景资产登记参考图。', [
                        { label: '交给 Agent', onClick: openHandoff },
                        { label: '去卡片视图', onClick: () => setAssetView('cards') },
                      ]))
            : null
          const visualCharactersSectionNode = visualShowCharacterSection
            ? h('div', { className: 'ad-visual-section', key: 'visual-characters' },
                h('div', { className: 'ad-sec' }, `角色卡区 · ${visualCharacterCards.length}`),
                visualCharacterCards.length
                  ? h('div', { className: 'ad-visual-grid' }, visualCharacterCards.map((card) => {
                      const rawThumb = card.media ? card.media.thumbnail || (card.media.images && card.media.images[0]) || '' : ''
                      return h('div', { className: 'ad-visual-card', key: card.id },
                        h('div', { className: 'ad-visual-thumb-wrap' }, rawThumb ? visualImageThumb(rawThumb, `${card.id} ${card.name}`) : h('span', { className: 'ad-visual-placeholder' }, '角色 · 无图')),
                        h('div', { className: 'ad-visual-card-body' },
                          h('strong', null, `${card.id} ${card.name}`),
                          card.aliases.length ? h('div', { className: 'ad-visual-meta' }, `别名：${card.aliases.join('、')}`) : null,
                          visualAudioNode(card)))
                    }))
                  : assetCards.some((card) => card.type === 'CHR')
                    ? h('div', { className: 'ad-visual-empty' }, '当前筛选没有角色卡')
                    : visualGuidanceNode('暂无角色图片/音色。为角色资产卡添加图片或音频后会出现在这里；也可让 Agent 补充。', [
                        { label: '去卡片视图', onClick: () => setAssetView('cards') },
                        { label: '交给 Agent', onClick: openHandoff },
                      ]))
            : null
          const visualWallGroupNode = (group) => {
            const collapsed = Boolean(visualGroupCollapsed && visualGroupCollapsed[group.key])
            return h('div', { className: 'ad-visual-group', key: group.key },
              h('button', {
                type: 'button',
                className: 'ad-visual-group-head',
                'aria-expanded': !collapsed,
                'aria-label': `${group.label}参考图 ${group.entries.length} 张，点击${collapsed ? '展开' : '折叠'}`,
                onClick: () => setVisualGroupCollapsed((prev) => ({ ...prev, [group.key]: !prev[group.key] })),
              },
                h('span', { className: 'ad-visual-group-title' }, group.label),
                h('span', { className: 'ad-visual-group-count ad-count' }, group.entries.length),
                h('span', { className: 'ad-visual-group-symbol', 'aria-hidden': 'true' }, collapsed ? '▸' : '▾')),
              collapsed
                ? null
                : h('div', { className: 'ad-visual-wall ad-visual-wall-group', role: 'list', 'aria-label': `${group.label}参考图墙` },
                    group.entries.map((entry) => visualImageThumb(entry.src, `${entry.cardId} ${entry.cardName}`))))
          }
          const visualWallNode = h('div', { className: 'ad-visual-section', key: 'visual-wall' },
            h('div', { className: 'ad-sec' }, `关键参考图墙 · ${visualWallImages.length}`),
            visualWallGroups.length
              ? h('div', { className: 'ad-visual-groups' }, visualWallGroups.map(visualWallGroupNode))
              : visualType !== 'all'
                ? h('div', { className: 'ad-visual-empty' }, `当前筛选没有${visualWallGroupLabel(visualType)}参考图`)
                : visualImages.length
                  ? h('div', { className: 'ad-visual-empty' }, '当前筛选没有匹配的参考图（换个类型或关键词试试）')
                  : visualGuidanceNode('还没有参考图。在卡片视图为资产卡添加图片，或让 Agent 生成参考图。', [
                      { label: '去卡片视图', onClick: () => setAssetView('cards') },
                      { label: '交给 Agent', onClick: openHandoff },
                    ]))
          const visualBibleNode = h('div', { key: 'visual-bible', className: 'ad-visual-bible' },
            h('div', { className: 'ad-visual-toolbar', role: 'group', 'aria-label': '视觉圣经筛选' },
              h('button', { type: 'button', className: 'ad-asset-chip', 'aria-pressed': visualType === 'all', onClick: () => setVisualType('all') }, `全部 ${visualImages.length}`),
              VISUAL_WALL_GROUPS.map((group) => h('button', {
                key: group.key,
                type: 'button',
                className: 'ad-asset-chip',
                'aria-pressed': visualType === group.key,
                onClick: () => setVisualType(group.key),
              }, `${group.label} ${visualGroupCounts.get(group.key) || 0}`)),
              h('input', {
                className: 'ad-input ad-sm',
                style: { maxWidth: 220 },
                type: 'search',
                'aria-label': '搜索视觉资产编号或名称',
                placeholder: '搜索编号或名称…',
                value: visualQuery,
                onChange: (e) => setVisualQuery(e.target.value),
              }),
              h('select', {
                className: 'ad-input ad-sm',
                style: { maxWidth: 140 },
                'aria-label': '视觉资产排序',
                value: visualSort,
                onChange: (e) => setVisualSort(e.target.value),
              }, h('option', { value: 'id-asc' }, '编号 ↑'), h('option', { value: 'id-desc' }, '编号 ↓'))),
            visualStyleNode,
            visualScenesSectionNode,
            visualCharactersSectionNode,
            visualWallNode)

          /* ---------------- v0.15.4（task-119 / M20-C）：素材库 2.0 · legacy 登记统一卡片视图 ---------------- */
          const legacyAssetList = normalizeLegacyAssets(assets)
          const hasAssetData = assets.length > 0 || assetCards.length > 0
          const legacyKindCounts = new Map()
          for (const asset of legacyAssetList) legacyKindCounts.set(asset.kind, (legacyKindCounts.get(asset.kind) || 0) + 1)
          const legacyKindChips = LEGACY_ASSET_KIND_ORDER.filter((kind) => legacyKindCounts.has(kind))
          const legacyVisibleAssets = sortLegacyAssets(filterLegacyAssets(legacyAssetList, legacyKindFilter, legacyQuery), legacySort)
          const assetRegistrationExpanded = assetRegistrationOpen || assets.length === 0
          // v0.15.8（task-126 / EXT-C1）：历史外部登记识别（projectRoot 取不到 → 不标记，避免误伤项目内绝对路径）
          const externalAssetIds = new Set()
          for (const asset of legacyAssetList) {
            if (isProjectExternalSource(asset.source, projectRoot)) externalAssetIds.add(asset.id)
          }
          const externalAssetCount = externalAssetIds.size
          const isExternalAsset = (entry) => Boolean(entry && externalAssetIds.has(entry.id))
          const legacyImageNode = (asset) => {
            if (asset.kind !== 'image') {
              return h('span', { className: 'ad-legacy-placeholder' }, `${LEGACY_ASSET_KIND_LABELS[asset.kind] || '素材'} · 不支持预览`)
            }
            const cached = legacyImageCache[asset.id]
            if (cached && cached.status === 'ok') {
              return h('button', {
                type: 'button',
                className: 'ad-legacy-thumb',
                'aria-label': `查看大图：${asset.name}`,
                onClick: (event) => {
                  lightboxTriggerEl = event && event.currentTarget ? event.currentTarget : null
                  setVisualLightbox({ src: cached.dataUrl, alt: asset.name })
                },
              }, h('img', {
                src: cached.dataUrl,
                alt: `${asset.name} 缩略图`,
                loading: 'lazy',
                onError: () => setLegacyImageCache((prev) => ({ ...prev, [asset.id]: { status: 'error' } })),
              }))
            }
            if (cached && cached.status === 'error') return h('span', { className: 'ad-legacy-placeholder ad-legacy-missing' }, '文件缺失')
            return h('span', { className: 'ad-legacy-placeholder' }, '加载中…')
          }
          const legacyCardNode = (asset) => h('div', { className: 'ad-legacy-card', key: asset.id },
            h('div', { className: 'ad-legacy-thumb-wrap' }, legacyImageNode(asset)),
            h('div', { className: 'ad-legacy-body' },
              h('strong', { className: 'ad-legacy-name', title: asset.name }, asset.name),
              h('div', { className: 'ad-legacy-meta' },
                h('span', { className: 'ad-asset-badge' }, LEGACY_ASSET_KIND_LABELS[asset.kind] || '素材'),
                h('span', null, formatAssetBytes(asset.bytes)),
                isExternalAsset(asset) ? h('span', { className: 'ad-asset-badge ad-asset-badge-warn' }, '外部路径（待迁移）') : null),
              asset.linkedShots.length ? h('div', { className: 'ad-legacy-meta' }, `关联镜头：${asset.linkedShots.join('、')}`) : null,
              asset.note ? h('div', { className: 'ad-legacy-meta ad-legacy-note', title: asset.note }, asset.note) : null,
              asset.sha256 ? h('div', { className: 'ad-legacy-meta' }, `校验：${asset.sha256.slice(0, 8)}`) : null,
              isExternalAsset(asset) ? h('div', { className: 'ad-legacy-meta ad-legacy-warn' }, '历史外部登记：请先迁入项目「素材/」目录再重新登记（图片预览保持只读兼容）') : null))
          const legacyUnifiedNode = h('div', { key: 'legacy-unified', className: 'ad-legacy-view' },
            h('div', { className: 'ad-row', style: { marginBottom: 8, flexWrap: 'wrap', gap: 8 } },
              h('span', { className: 'ad-sub' }, `素材库 · 已登记 ${legacyAssetList.length} 条${assetCards.length ? ` · 资产卡 ${assetCards.length} 张` : ''}（只读预览）`),
              h('div', { style: { flex: 1 } }),
              h('input', {
                className: 'ad-input ad-sm',
                style: { maxWidth: 240 },
                type: 'search',
                'aria-label': '搜索登记素材名称/备注/镜号',
                placeholder: '搜索名称/备注/镜号…',
                value: legacyQuery,
                onChange: (e) => {
                  const value = e.target.value
                  setLegacyQuery(value)
                  ensureLegacyImages(filterLegacyAssets(legacyAssetList, legacyKindFilter, value))
                },
              }),
              h('select', {
                className: 'ad-input ad-sm',
                style: { maxWidth: 130 },
                'aria-label': '登记素材排序',
                value: legacySort,
                onChange: (e) => setLegacySort(e.target.value),
              }, h('option', { value: 'name-asc' }, '名称'), h('option', { value: 'size-desc' }, '大小'))),
            externalAssetCount
              ? h('div', { className: 'ad-warn', key: 'legacy-external', role: 'status' }, `当前有 ${externalAssetCount} 条历史外部登记（待迁移）：请先把文件迁入项目「素材/」目录再重新登记；图片预览暂时保持只读兼容。`)
              : null,
            legacyAssetList.length
              ? h('div', { className: 'ad-asset-toolbar', role: 'group', 'aria-label': '登记素材类型筛选' },
                  h('button', {
                    type: 'button',
                    className: 'ad-asset-chip',
                    'aria-pressed': legacyKindFilter === 'all',
                    onClick: () => {
                      setLegacyKindFilter('all')
                      ensureLegacyImages(filterLegacyAssets(legacyAssetList, 'all', legacyQuery))
                    },
                  }, `全部 ${legacyAssetList.length}`),
                  legacyKindChips.map((kind) => h('button', {
                    key: kind,
                    type: 'button',
                    className: 'ad-asset-chip',
                    'aria-pressed': legacyKindFilter === kind,
                    onClick: () => {
                      setLegacyKindFilter(kind)
                      ensureLegacyImages(filterLegacyAssets(legacyAssetList, kind, legacyQuery))
                    },
                  }, `${LEGACY_ASSET_KIND_LABELS[kind]} ${legacyKindCounts.get(kind)}`)))
              : null,
            h('div', { className: 'ad-sec' }, `已登记素材 · ${legacyVisibleAssets.length}`),
            legacyVisibleAssets.length
              ? h('div', { className: 'ad-asset-grid ad-legacy-grid', role: 'list', 'aria-label': '已登记素材卡片' }, legacyVisibleAssets.map(legacyCardNode))
              : h('div', { className: 'ad-table-empty' }, legacyAssetList.length ? '当前筛选没有登记素材（换个类型/关键词试试）' : '还没有登记素材：把文件放入项目「素材/」目录后，粘贴项目内路径（例如 素材/角色/CHR001.png）→ 登记后自动出现在这里'),
            h('div', { className: 'ad-visual-empty', style: { marginTop: 10 } }, '登记=把项目文件夹内的素材路径登记入库；仅支持项目内路径，素材必须位于项目「素材/」目录（或项目文件夹内），不支持项目外路径；登记后自动出现在上方卡片视图。'))
          const visualBibleHintNode = !hasVisualData
            ? h('div', { key: 'visual-bible-hint', className: 'ad-visual-empty', style: { marginTop: 10 } }, '配置风格 DNA / 场景卡后，可在此查看视觉圣经。')
            : null
          const assetRegistrationNode = h('div', { key: 'asset-registration', className: 'ad-registration' },
            h('button', {
              type: 'button',
              className: 'ad-btn ad-sm',
              'aria-expanded': assetRegistrationExpanded,
              onClick: () => setAssetRegistrationOpen((prev) => !prev),
            }, `登记管理（${assets.length} 条）${assetRegistrationExpanded ? ' · 收起 ▴' : ' · 展开 ▾'}`),
            assetRegistrationExpanded
              ? h('div', { className: 'ad-registration-body' },
                  h('div', { className: 'ad-visual-empty', style: { marginBottom: 8 } }, '登记=把项目文件夹内的素材路径登记入库；仅支持项目内路径，素材必须位于项目「素材/」目录（或项目文件夹内），不支持项目外路径；登记后自动出现在上方卡片视图；「刷新/重扫」= 重新读取登记并同步文件变化。'),
                  assetAddError ? h('div', { className: 'ad-err-box', role: 'alert', style: { marginBottom: 8 } }, h('div', { className: 'ad-err' }, assetAddError)) : null,
                  h('div', { className: 'ad-row', style: { marginBottom: 6 } },
                    h('input', {
                      className: 'ad-input',
                      placeholder: '项目内素材路径，例如 素材/角色/CHR001.png',
                      value: assetSource,
                      onChange: (e) => { setAssetSource(e.target.value); if (assetAddError) setAssetAddError('') },
                    }),
                    h('input', { className: 'ad-input', style: { maxWidth: 160 }, placeholder: '关联镜号 1-1、1-2', value: assetShots, onChange: (e) => setAssetShots(e.target.value) }),
                    h('button', { className: 'ad-btn ad-primary ad-sm', onClick: addAsset, disabled: busy || !assetSource.trim() }, '登记'),
                    h('button', { className: 'ad-btn ad-sm', onClick: () => loadAssets(), disabled: busy }, icon('refresh'), '刷新/重扫')),
                  h('div', { className: 'ad-sub', style: { marginBottom: 10 } }, '只登记项目内路径与校验信息，**不复制原始文件**；登记后自动刷新列表。'),
                  h('table', { className: 'ad-table' },
                    h('caption', { className: 'ad-sr-only' }, '素材资产登记表'),
                    h('thead', null, h('tr', null, ['名称', '类型', '大小', '关联镜头', '校验', '路径', ''].map((t, i) => h('th', { key: i, scope: 'col' }, t)))),
                    h('tbody', null,
                      assets.length
                        ? assets.map((a) =>
                            h('tr', { key: a.id },
                              h('td', null, a.name),
                              h('td', null, a.kind, isExternalAsset(a) ? h('span', { className: 'ad-asset-badge ad-asset-badge-warn', style: { marginLeft: 6 } }, '外部路径（待迁移）') : null),
                              h('td', null, ((Number(a.bytes) || 0) / 1024).toFixed(1) + ' KB'),
                              h('td', null, (a.linkedShots || []).join('、') || '—'),
                              h('td', { title: a.sha256 || '未计算' }, a.sha256 ? a.sha256.slice(0, 8) : '—'),
                              h('td', { style: { maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }, title: isExternalAsset(a) ? '' : a.source }, isExternalAsset(a) ? '（历史外部路径已隐藏，待迁移）' : a.source),
                              h('td', null, h('button', { type: 'button', className: 'ad-btn ad-sm ad-btn-danger ad-icon-btn ad-icon-btn-sm', 'data-tone': 'danger', 'aria-label': '移除素材', title: '移除素材', onClick: () => removeAsset(a.id) }, icon('trash')))))
                        : h('tr', null, h('td', { colSpan: 7, className: 'ad-table-empty' }, '还没有登记素材：把文件放入项目「素材/」目录后，粘贴项目内路径（例如 素材/角色/CHR001.png）→ 点「登记」后自动出现在上方卡片视图。')))))
              : null)

          /* ---------------- v0.15.9（task-129 / D2C-C）：扫描素材目录 + 批量登记 ---------------- */
          const scanKindCounts = new Map()
          for (const file of scanFiles) scanKindCounts.set(file.kind, (scanKindCounts.get(file.kind) || 0) + 1)
          const scanKindChips = SCAN_KIND_ORDER.filter((kind) => scanKindCounts.has(kind))
          const scanVisibleFiles = scanKindFilter === 'all' ? scanFiles : scanFiles.filter((file) => file.kind === scanKindFilter)
          const scanSelectedCount = scanFiles.filter((file) => Boolean(scanSelected[file.path])).length
          const scanAllSelected = scanVisibleFiles.length > 0 && scanVisibleFiles.every((file) => Boolean(scanSelected[file.path]))
          const scanStatsText = scanTruncated
            ? `素材/ 内未登记文件：${scanTotal} 个（仅显示前 1000 条，可先登记一部分再重新扫描）`
            : `素材/ 内未登记文件：${scanTotal} 个`
          const registryWarningNode = registrySupported === true && registryOk === false
            ? h('div', { key: 'registry-warning', className: 'ad-registry-warning', role: 'status' },
                h('div', { className: 'ad-registry-warning-title' }, REGISTRY_WARNING_TEXT),
                h('div', { className: 'ad-sub', style: { marginTop: 2 } }, REGISTRY_WARNING_DETAIL),
                h('div', { className: 'ad-registry-actions' },
                  h('button', { type: 'button', className: 'ad-btn ad-primary ad-sm', onClick: repairRegistry, disabled: registryBusy }, registryBusy ? '修复中…' : '修复登记表')),
                registryError ? h('div', { className: 'ad-hint-next', role: 'status' }, registryError) : null)
            : null
          const registryNoticeNode = registrySupported === true && registryOk !== false && registryNotice
            ? h('div', { key: 'registry-notice', className: 'ad-registry-notice', role: 'status' }, registryNotice)
            : null
          const scanEntryButton = scanSupported === true
            ? h('button', {
                type: 'button',
                className: 'ad-btn ad-sm',
                'aria-expanded': scanOpen,
                onClick: openScanPanel,
                disabled: scanBatchBusy || registryOk === false,
                title: registryOk === false ? '素材登记表损坏，请先修复登记表后再扫描/批量登记' : undefined,
              }, scanOpen ? '收起扫描结果' : '扫描素材目录')
            : null
          const importEntryButton = importSupported === true
            ? h('button', {
                type: 'button',
                className: 'ad-btn ad-sm',
                'aria-expanded': importOpen,
                onClick: openImportPanel,
                disabled: importBusy || registryOk === false,
                title: registryOk === false ? '素材登记表损坏，请先修复登记表' : undefined,
              }, importOpen ? '收起导入面板' : '导入素材')
            : null
          const crossEntryButton = crossSupported === true
            ? h('button', {
                type: 'button',
                className: 'ad-btn ad-sm',
                'aria-expanded': crossOpen,
                onClick: openCrossPanel,
                disabled: crossBusy || registryOk === false,
                title: registryOk === false ? '素材登记表损坏，请先修复登记表' : undefined,
              }, crossOpen ? '收起跨项目导入' : '从其他项目导入…')
            : null
          const assetActionsToolbarNode = scanEntryButton || importEntryButton || crossEntryButton
            ? h('div', { key: 'asset-actions-toolbar', className: 'ad-scan-toolbar' },
                scanEntryButton,
                importEntryButton,
                crossEntryButton,
                h('span', { className: 'ad-sub' }, (importSupported === true
                  ? '扫描=列出项目「素材/」内未登记文件批量登记；导入=把所选文件复制进项目并自动登记（均不移动源文件）'
                  : '列出项目「素材/」内未登记文件，勾选后可批量登记（不移动文件）') + (crossSupported === true ? '；跨项目=从其他项目只读选择已登记资产并复制到当前项目（源项目不变）' : '')))
            : null
          const scanPanelNode = scanSupported === true && scanOpen
            ? h('div', { key: 'scan-panel', className: 'ad-scan-panel', role: 'region', 'aria-label': '扫描素材目录' },
                h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 8, marginBottom: 6, alignItems: 'center' } },
                  h('strong', null, '扫描素材目录'),
                  h('span', { className: 'ad-sub', role: 'status' }, scanStatsText),
                  h('div', { style: { flex: 1 } }),
                  h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: () => loadAssets({ scan: true }).catch(() => {}), disabled: scanBatchBusy }, '重新扫描'),
                  h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: closeScanPanel, disabled: scanBatchBusy }, '关闭')),
                h('div', { className: 'ad-sub', style: { marginBottom: 8 } }, '扫描=列出项目「素材/」内未登记文件；批量登记=登记进素材库（**不移动文件**）。'),
                scanFiles.length
                  ? h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' } },
                      h('button', { type: 'button', className: 'ad-asset-chip', 'aria-pressed': scanKindFilter === 'all', onClick: () => setScanKindFilter('all') }, `全部 ${scanFiles.length}`),
                      scanKindChips.map((kind) => h('button', {
                        key: kind,
                        type: 'button',
                        className: 'ad-asset-chip',
                        'aria-pressed': scanKindFilter === kind,
                        onClick: () => setScanKindFilter(kind),
                      }, `${LEGACY_ASSET_KIND_LABELS[kind] || '其他'} ${scanKindCounts.get(kind)}`)),
                      h('label', { className: 'ad-scan-selectall' },
                        h('input', {
                          type: 'checkbox',
                          className: 'ad-check',
                          checked: scanAllSelected,
                          onChange: () => toggleScanAll(scanVisibleFiles),
                          disabled: scanBatchBusy,
                          'aria-label': '全选当前筛选未登记文件',
                        }),
                        '全选'),
                      h('span', { className: 'ad-sub' }, `已选 ${scanSelectedCount}`))
                  : null,
                scanFiles.length
                  ? h('div', { className: 'ad-scan-list', role: 'list', 'aria-label': '未登记素材文件列表' },
                      scanVisibleFiles.length
                        ? scanVisibleFiles.map((file) => h('label', { className: 'ad-scan-row', key: file.path, role: 'listitem' },
                            h('input', {
                              type: 'checkbox',
                              className: 'ad-check',
                              checked: Boolean(scanSelected[file.path]),
                              onChange: () => toggleScanFile(file.path),
                              disabled: scanBatchBusy,
                              'aria-label': `选择 ${file.path}`,
                            }),
                            h('span', { className: 'ad-scan-path', title: file.path }, file.path),
                            h('span', { className: 'ad-asset-badge' }, LEGACY_ASSET_KIND_LABELS[file.kind] || '其他'),
                            h('span', { className: 'ad-scan-size' }, formatAssetBytes(file.size))))
                        : h('div', { className: 'ad-table-empty' }, '当前筛选没有未登记文件'))
                  : h('div', { className: 'ad-table-empty' }, '素材/ 目录下没有未登记文件'),
                h('div', { className: 'ad-scan-actions' },
                  h('button', {
                    type: 'button',
                    className: 'ad-btn ad-primary ad-sm',
                    onClick: runScanBatch,
                    disabled: scanBatchBusy || scanSelectedCount === 0 || registryOk === false,
                  }, scanBatchBusy ? `登记中… 已处理 ${scanProgress.done}/${scanProgress.total}` : `批量登记已选（${scanSelectedCount}）`),
                  scanSelectedCount > SCAN_BATCH_WARN_THRESHOLD ? h('span', { className: 'ad-warn-inline' }, '将逐条登记，可能耗时数秒') : null),
                scanBatchBusy || scanProgress.total > 0
                  ? h('div', { className: 'ad-scan-progress', role: 'status' }, `已处理 ${scanProgress.done}/${scanProgress.total}`)
                  : null,
                scanSummary
                  ? h('div', { className: 'ad-scan-summary', role: 'status' },
                      h('div', null, `汇总：成功 ${scanSummary.ok} · 失败 ${scanSummary.fail.length}`),
                      scanSummary.fail.length
                        ? h('div', { className: 'ad-scan-fail-list' }, scanSummary.fail.map((item) => h('div', { className: 'ad-scan-fail-item', key: item.path }, `${item.path}：${item.reason}`)))
                        : h('div', { className: 'ad-ok' }, '全部登记成功'))
                  : null)
            : null

          /* ---------------- v0.15.11（task-135 / IMP-C）：一键导入面板 ---------------- */
          const importQueuedCount = importQueue.filter((item) => item.status === 'queued').length
          const importFailCount = importQueue.filter((item) => item.status === 'fail').length
          const importPanelNode = importSupported === true && importOpen
            ? h('div', { key: 'import-panel', className: 'ad-import-panel', role: 'region', 'aria-label': '导入素材' },
                h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 8, marginBottom: 6, alignItems: 'center' } },
                  h('strong', null, '导入素材'),
                  h('span', { className: 'ad-sub', role: 'status' }, `待导入 ${importQueuedCount} 个${importQueue.length !== importQueuedCount ? `（队列共 ${importQueue.length} 个）` : ''}`),
                  h('div', { style: { flex: 1 } }),
                  h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: clearImportQueue, disabled: importBusy || importQueue.length === 0 }, '清空'),
                  h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: closeImportPanel, disabled: importBusy }, '关闭')),
                h('div', { className: 'ad-sub', style: { marginBottom: 8 } }, '导入=把所选文件复制进项目「素材/<分类>/」并自动登记（**不移动源文件**）；单文件 ≤50MB；单批 ≤20。'),
                h('div', { className: 'ad-import-controls' },
                  h('label', { className: 'ad-import-category' }, '分类',
                    h('select', {
                      className: 'ad-input ad-sm',
                      'aria-label': '导入分类',
                      value: importCategory,
                      onChange: (event) => setImportCategory(event.target.value),
                      disabled: importBusy,
                    },
                      h('option', { value: '' }, `默认（${importDefaultCategory()}）`),
                      IMPORT_CATEGORIES.map((category) => h('option', { key: category, value: category }, category)))),
                  h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: pickImportFiles, disabled: importBusy }, '选择文件…'),
                  h('input', {
                    id: 'ad-import-file-input',
                    'data-import-input': 'true',
                    type: 'file',
                    multiple: true,
                    accept: IMPORT_ACCEPT,
                    style: { display: 'none' },
                    onChange: (event) => {
                      addImportFiles(event && event.target ? event.target.files : [])
                      if (event && event.target) {
                        try { event.target.value = '' } catch { /* 允许再次选择同名文件 */ }
                      }
                    },
                  })),
                h('div', {
                  className: 'ad-import-drop',
                  onDragOver: (event) => { if (event && typeof event.preventDefault === 'function') event.preventDefault() },
                  onDrop: (event) => {
                    if (event && typeof event.preventDefault === 'function') event.preventDefault()
                    addImportFiles(event && event.dataTransfer ? event.dataTransfer.files : [])
                  },
                }, '把文件拖到这里，或点击「选择文件…」'),
                importQueue.length
                  ? h('div', { className: 'ad-import-list', role: 'list', 'aria-label': '待导入文件列表' },
                      importQueue.map((item) => h('div', {
                        className: `ad-import-row${item.status === 'too-large' || item.status === 'unsupported' || item.status === 'limit' ? ' ad-import-row-bad' : ''}`,
                        key: item.id,
                        role: 'listitem',
                      },
                        h('span', { className: 'ad-import-name', title: item.name }, item.name),
                        h('span', { className: 'ad-asset-badge' }, item.kindLabel),
                        h('span', { className: 'ad-import-size' }, formatAssetBytes(item.size)),
                        h('span', { className: 'ad-import-status' }, importStatusText(item)),
                        h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: () => removeImportItem(item.id), disabled: importBusy }, '移除'))))
                  : h('div', { className: 'ad-table-empty' }, '还没有选择文件'),
                h('div', { className: 'ad-import-actions' },
                  h('button', {
                    type: 'button',
                    className: 'ad-btn ad-primary ad-sm',
                    onClick: () => { runImportBatch(false).catch(() => {}) },
                    disabled: importBusy || importQueuedCount === 0,
                  }, importBusy ? `导入中… 已处理 ${importProgress.done}/${importProgress.total}` : `开始导入（${importQueuedCount}）`),
                  importFailCount > 0
                    ? h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: retryFailedImports, disabled: importBusy }, `重试失败项（${importFailCount}）`)
                    : null),
                importBusy || importProgress.total > 0
                  ? h('div', { className: 'ad-import-progress', role: 'status' }, `已处理 ${importProgress.done}/${importProgress.total}`)
                  : null,
                importSummary
                  ? h('div', { className: 'ad-import-summary', role: 'status' },
                      h('div', null, `汇总：成功 ${importSummary.ok} · 已存在 ${importSummary.duplicate} · 失败 ${importSummary.fail.length}`),
                      importSummary.fail.length
                        ? h('div', { className: 'ad-scan-fail-list' }, importSummary.fail.map((item) => h('div', { className: 'ad-scan-fail-item', key: item.id }, `${item.name}：${item.reason}`)))
                        : h('div', { className: 'ad-ok' }, '全部导入成功'))
                  : null)
            : null
          /* ---------------- v0.16.8（I5-1-C）：从其他项目导入 tabs 面板 ---------------- */
          const crossAssetTabContent = h('div', { key: 'cross-tab-assets' },
            h('div', { className: 'ad-cross-import-toolbar' },
              h('input', {
                className: 'ad-input ad-sm',
                type: 'search',
                'aria-label': '搜索源项目资产',
                placeholder: '搜索编号/名称/分类…',
                value: crossQuery,
                onChange: (event) => setCrossQuery(event.target.value),
                disabled: crossBusy,
              }),
              h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: toggleAllCrossAssets, disabled: crossBusy || crossVisibleAssets.length === 0 }, crossAllSelected ? '取消全选' : `全选（${crossVisibleAssets.length}）`),
              h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: clearCrossSelection, disabled: crossBusy || crossSelectedCount === 0 }, '清空选择'),
              h('span', { className: 'ad-sub' }, `已选 ${crossSelectedCount} 个${crossSelectedCount ? ` · 预计 ${formatAssetBytes(crossSelectedBytes)}` : ''}`)),
            crossVisibleAssets.length
              ? h('div', { className: 'ad-cross-import-list', role: 'list', 'aria-label': '源项目已登记资产' },
                  crossVisibleAssets.map((asset) => h('label', { key: asset.id, className: 'ad-cross-import-row', role: 'listitem' },
                    h('input', {
                      type: 'checkbox',
                      checked: Boolean(crossSelected[asset.id]),
                      onChange: () => toggleCrossAsset(asset.id),
                      disabled: crossBusy,
                      'aria-label': `选择源资产 ${asset.id} ${asset.name}`,
                    }),
                    h('span', { className: 'ad-asset-badge' }, asset.category || '未分类'),
                    h('span', { className: 'ad-cross-import-id' }, asset.id),
                    h('span', { className: 'ad-cross-import-name', title: asset.name }, asset.name),
                    h('span', { className: 'ad-import-size' }, formatAssetBytes(asset.bytes)),
                    h('span', { className: 'ad-sub' }, asset.sha256 ? 'sha ' + asset.sha256.slice(0, 8) : ''))))
              : h('div', { className: 'ad-table-empty' }, crossQuery.trim() ? '没有匹配的源资产（换个关键词试试）' : '该项目还没有已登记素材；可先在源项目里导入/扫描登记。'),
            h('div', { className: 'ad-cross-import-toolbar' },
              h('label', { className: 'ad-import-category' }, '目标分类',
                h('select', {
                  className: 'ad-input ad-sm',
                  'aria-label': '跨项目导入目标分类',
                  value: crossCategory,
                  onChange: (event) => setCrossCategory(event.target.value),
                  disabled: crossBusy,
                },
                  h('option', { value: '' }, '保留源分类（默认）'),
                  ARTIFACT_CATEGORIES.map((category) => h('option', { key: category, value: category }, category))))))
          const crossCardTabContent = h('div', { key: 'cross-tab-cards' },
            h('div', { className: 'ad-cross-import-toolbar' },
              h('input', {
                className: 'ad-input ad-sm',
                type: 'search',
                'aria-label': '搜索源资产卡',
                placeholder: '搜索编号/名称/类型…',
                value: crossQuery,
                onChange: (event) => setCrossQuery(event.target.value),
                disabled: crossBusy,
              }),
              h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: toggleAllCrossCards, disabled: crossBusy || crossVisibleCards.length === 0 }, crossAllCardsSelected ? '取消全选' : `全选（${crossVisibleCards.length}）`),
              h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: clearCrossCardSelection, disabled: crossBusy || crossSelectedCardCount === 0 }, '清空选择'),
              h('span', { className: 'ad-sub' }, `已选 ${crossSelectedCardCount} 个`)),
            crossVisibleCards.length
              ? h('div', { className: 'ad-cross-import-list', role: 'list', 'aria-label': '源项目资产卡' },
                  crossVisibleCards.map((card) => h('label', { key: card.id, className: 'ad-cross-import-row', role: 'listitem' },
                    h('input', {
                      type: 'checkbox',
                      checked: Boolean(crossCardSelected[card.id]),
                      onChange: () => toggleCrossCard(card.id),
                      disabled: crossBusy,
                      'aria-label': `选择源资产卡 ${card.id} ${card.name}`,
                    }),
                    h('span', { className: 'ad-asset-badge' }, assetTypeLabelOf(card.type)),
                    h('span', { className: 'ad-cross-import-id' }, card.id),
                    h('span', { className: 'ad-cross-import-name', title: card.name }, card.name),
                    h('span', { className: 'ad-sub' }, card.mediaCount ? `媒体 ${card.mediaCount}` : '无媒体'))))
              : h('div', { className: 'ad-table-empty' }, crossQuery.trim() ? '没有匹配的源资产卡（换个关键词试试）' : '该项目还没有资产卡。'),
            h('div', { className: 'ad-cross-switches' },
              h('label', { className: 'ad-cross-switch' },
                h('input', { type: 'checkbox', checked: crossCopyMedia, onChange: (event) => setCrossCopyMedia(Boolean(event.target.checked)), disabled: crossBusy, 'aria-label': '复制卡片媒体' }),
                '复制卡片引用的媒体文件（默认开；SHA 去重）'),
              h('label', { className: 'ad-cross-switch' },
                h('input', { type: 'checkbox', checked: crossAllowNewIdSuffix, onChange: (event) => setCrossAllowNewIdSuffix(Boolean(event.target.checked)), disabled: crossBusy, 'aria-label': '允许分配新编号' }),
                '允许分配新编号（默认关；同 id 不同内容才使用）')),
            (() => {
              const sourceCards = crossVisibleCards.filter((card) => crossCardSelected[card.id])
              const conflict = crossObjectConflict(sourceCards, assetCards, crossCardSignature)
              if (!sourceCards.length) return h('div', { className: 'ad-cross-conflict' }, '选择资产卡后显示冲突预览（预览仅供参考，最终以导入结果为准）')
              if (!conflict.same.length && !conflict.diff.length) return h('div', { className: 'ad-cross-conflict' }, '冲突预览：所选资产卡与目标无同 id 冲突')
              return h('div', { className: 'ad-cross-conflict' },
                `冲突预览（仅供参考，最终以导入结果为准）：同 id ${conflict.same.length + conflict.diff.length} 个`,
                conflict.same.length ? `；其中 ${conflict.same.length} 个内容相同将跳过` : '',
                conflict.diff.length ? `；${conflict.diff.length} 个内容不同${crossAllowNewIdSuffix ? '将分配新编号导入' : '默认跳过（勾选「允许分配新编号」后导入）'}` : '')
            })())
          const crossSceneTabContent = h('div', { key: 'cross-tab-scenes' },
            h('div', { className: 'ad-cross-import-toolbar' },
              h('input', {
                className: 'ad-input ad-sm',
                type: 'search',
                'aria-label': '搜索源场景卡',
                placeholder: '搜索编号/名称/地点…',
                value: crossQuery,
                onChange: (event) => setCrossQuery(event.target.value),
                disabled: crossBusy,
              }),
              h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: toggleAllCrossScenes, disabled: crossBusy || crossVisibleScenes.length === 0 }, crossAllScenesSelected ? '取消全选' : `全选（${crossVisibleScenes.length}）`),
              h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: clearCrossSceneSelection, disabled: crossBusy || crossSelectedSceneCount === 0 }, '清空选择'),
              h('span', { className: 'ad-sub' }, `已选 ${crossSelectedSceneCount} 个`)),
            crossVisibleScenes.length
              ? h('div', { className: 'ad-cross-import-list', role: 'list', 'aria-label': '源项目场景卡' },
                  crossVisibleScenes.map((scene) => h('label', { key: scene.id, className: 'ad-cross-import-row', role: 'listitem' },
                    h('input', {
                      type: 'checkbox',
                      checked: Boolean(crossSceneSelected[scene.id]),
                      onChange: () => toggleCrossScene(scene.id),
                      disabled: crossBusy,
                      'aria-label': `选择源场景卡 ${scene.id} ${scene.name}`,
                    }),
                    h('span', { className: 'ad-asset-badge' }, '场景'),
                    h('span', { className: 'ad-cross-import-id' }, scene.id),
                    h('span', { className: 'ad-cross-import-name', title: scene.name }, scene.name),
                    h('span', { className: 'ad-sub' }, scene.summary))))
              : h('div', { className: 'ad-table-empty' }, crossQuery.trim() ? '没有匹配的源场景卡（换个关键词试试）' : '该项目还没有场景卡。'),
            h('div', { className: 'ad-cross-switches' },
              h('label', { className: 'ad-cross-switch' },
                h('input', { type: 'checkbox', checked: crossAllowNewIdSuffix, onChange: (event) => setCrossAllowNewIdSuffix(Boolean(event.target.checked)), disabled: crossBusy, 'aria-label': '场景允许分配新编号' }),
                '允许分配新编号（默认关；同 id 不同内容才使用）')),
            (() => {
              const sourceScenes = crossVisibleScenes.filter((scene) => crossSceneSelected[scene.id])
              const conflict = crossObjectConflict(sourceScenes, visualScenes, crossSceneSignature)
              if (!sourceScenes.length) return h('div', { className: 'ad-cross-conflict' }, '选择场景卡后显示冲突预览（预览仅供参考，最终以导入结果为准）')
              if (!conflict.same.length && !conflict.diff.length) return h('div', { className: 'ad-cross-conflict' }, '冲突预览：所选场景卡与目标无同 id 冲突')
              return h('div', { className: 'ad-cross-conflict' },
                `冲突预览（仅供参考，最终以导入结果为准）：同 id ${conflict.same.length + conflict.diff.length} 个`,
                conflict.same.length ? `；其中 ${conflict.same.length} 个内容相同将跳过` : '',
                conflict.diff.length ? `；${conflict.diff.length} 个内容不同${crossAllowNewIdSuffix ? '将分配新编号导入' : '默认跳过（勾选「允许分配新编号」后导入）'}` : '')
            })())
          const crossStyleTabContent = h('div', { key: 'cross-tab-style' },
            crossStyle
              ? h('div', null,
                  h('div', { className: 'ad-cross-style-grid' },
                    STYLE_DIMENSION_ORDER.filter(([key]) => crossStyle[key]).map(([key, label]) => h('div', { className: 'ad-cross-style-dim', key },
                      h('span', { className: 'ad-sub' }, label),
                      h('span', null, crossStyle[key])))),
                  h('div', { className: 'ad-cross-switches' },
                    h('label', { className: 'ad-cross-switch' },
                      h('input', {
                        type: 'checkbox',
                        checked: crossCopyStyleDNA,
                        onChange: (event) => {
                          const checked = Boolean(event.target.checked)
                          setCrossCopyStyleDNA(checked)
                          if (!checked) setCrossOverwriteStyle(false)
                        },
                        disabled: crossBusy,
                        'aria-label': '复制风格DNA',
                      }),
                      '复制风格 DNA（仅五维草稿；不含 frozen/历史）'),
                    h('label', { className: 'ad-cross-switch' },
                      h('input', {
                        type: 'checkbox',
                        checked: crossOverwriteStyle,
                        onChange: (event) => setCrossOverwriteStyle(Boolean(event.target.checked)),
                        disabled: crossBusy || !crossCopyStyleDNA,
                        'aria-label': '覆盖目标风格',
                      }),
                      '覆盖目标已有风格（默认关）')),
                  h('div', { className: 'ad-cross-conflict' },
                    crossTargetStyleDims
                      ? `目标已有风格 DNA（${crossTargetStyleDims} 维非空）：默认仅补齐空维度，不覆盖已有维度；勾选「覆盖目标风格」才会替换`
                      : '目标暂无风格 DNA：将写入五维草稿'))
              : h('div', { className: 'ad-table-empty' }, '该项目还没有风格 DNA（五维均未配置）。'))
          const crossTabsNode = crossObjectsSupported === true
            ? h('div', { className: 'ad-cross-tabs', role: 'tablist', 'aria-label': '跨项目导入类型' },
                CROSS_TABS.map((tab) => {
                  const count = tab.key === 'assets'
                    ? crossAssets.length
                    : tab.key === 'cards'
                      ? crossCards.length
                      : tab.key === 'scenes'
                        ? crossScenes.length
                        : (crossStyle ? crossStyleDims : 0)
                  return h('button', {
                    key: tab.key,
                    type: 'button',
                    role: 'tab',
                    className: 'ad-cross-tab',
                    'aria-pressed': crossTab === tab.key,
                    'aria-label': `跨项目导入${tab.label}`,
                    onClick: () => setCrossTab(tab.key),
                    disabled: crossBusy,
                  }, tab.key === 'style' ? tab.label : `${tab.label} ${count}`)
                }))
            : null
          const crossTabContentNode = crossObjectsSupported === true
            ? (crossTab === 'cards'
                ? crossCardTabContent
                : crossTab === 'scenes'
                  ? crossSceneTabContent
                  : crossTab === 'style'
                    ? crossStyleTabContent
                    : crossAssetTabContent)
            : crossAssetTabContent
          const crossSummaryHasFail = Boolean(crossSummary && (
            (crossSummary.assets && crossSummary.assets.fail.length) ||
            (crossSummary.cards && crossSummary.cards.fail.length) ||
            (crossSummary.scenes && crossSummary.scenes.fail.length)))
          const crossSummaryLines = crossSummary
            ? (crossObjectsSupported !== true
                ? (crossSummary.assets ? [`汇总：成功 ${crossSummary.assets.ok} · 已存在 ${crossSummary.assets.duplicate} · 失败 ${crossSummary.assets.fail.length}`] : [])
                : [
                crossSummary.assets ? `素材：成功 ${crossSummary.assets.ok} · 已存在 ${crossSummary.assets.duplicate} · 失败 ${crossSummary.assets.fail.length}` : null,
                crossSummary.cards ? `资产卡：成功 ${crossSummary.cards.ok} · 已存在 ${crossSummary.cards.duplicate} · 失败 ${crossSummary.cards.fail.length}` : null,
                crossSummary.scenes ? `场景卡：成功 ${crossSummary.scenes.ok} · 已存在 ${crossSummary.scenes.duplicate} · 失败 ${crossSummary.scenes.fail.length}` : null,
                crossSummary.style
                  ? `风格：${crossSummary.style.error ? sanitizeCrossMessage(String(crossSummary.style.error)) : crossSummary.style.copied === false ? '未写入' : crossSummary.style.merge === 'overwrite' ? '已覆盖' : crossSummary.style.merge === 'skip' ? '已跳过' : '已合并'}`
                  : null,
              ].filter(Boolean))
            : []
          const crossFailList = crossSummary
            ? [].concat(
                (crossSummary.assets ? crossSummary.assets.fail : []),
                (crossSummary.cards ? crossSummary.cards.fail : []),
                (crossSummary.scenes ? crossSummary.scenes.fail : []))
            : []
          const crossIdMapLines = crossSummary && crossSummary.idMap
            ? Object.entries(crossSummary.idMap).map(([from, to]) => `${from} → ${to}`)
            : []
          const crossImportPanelNode = crossSupported === true && crossOpen
            ? h('div', { key: 'cross-import-panel', className: 'ad-import-panel ad-cross-import-panel', role: 'region', 'aria-label': '从其他项目导入' },
                h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 8, marginBottom: 6, alignItems: 'center' } },
                  h('strong', null, '从其他项目导入'),
                  h('span', { className: 'ad-sub', role: 'status' },
                    crossLoading
                      ? '正在读取源项目资产…'
                      : crossSourceTitle
                        ? `源项目：${crossSourceTitle} · ${crossObjectsSupported === true ? `素材 ${crossAssets.length} / 资产卡 ${crossCards.length} / 场景卡 ${crossScenes.length}` : `已登记资产 ${crossAssets.length} 个`}`
                        : '先选择源项目'),
                  h('div', { style: { flex: 1 } }),
                  h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: closeCrossPanel, disabled: crossBusy }, '关闭')),
                h('div', { className: 'ad-sub', style: { marginBottom: 8 } }, crossCapabilityHint),
                h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' } },
                  h('label', { className: 'ad-import-category' }, '源项目',
                    h('select', {
                      className: 'ad-input ad-sm',
                      'aria-label': '跨项目导入源项目',
                      'data-cross-source': 'true',
                      value: crossSourceTitle,
                      onChange: (event) => { loadCrossSource(event.target.value).catch(() => {}) },
                      disabled: crossBusy || crossLoading,
                    },
                      h('option', { value: '' }, crossProjectOptions.length ? '选择项目…' : '当前工作区没有其他项目'),
                      crossProjectOptions.map((project) => h('option', { key: project.title, value: project.title }, project.title)))),
                  h('button', {
                    type: 'button',
                    className: 'ad-btn ad-sm',
                    onClick: () => { loadCrossSource(crossSourceTitle).catch(() => {}) },
                    disabled: crossBusy || crossLoading || !crossSourceTitle,
                  }, '刷新源资产')),
                crossLoadError
                  ? h('div', { className: 'ad-hint-next', role: 'status' }, crossLoadError)
                  : null,
                crossLoading
                  ? h('div', { className: 'ad-table-empty', role: 'status' }, '正在读取源项目素材…')
                  : h('div', null,
                      crossTabsNode,
                      crossTabContentNode),
                h('div', { className: 'ad-cross-import-toolbar' },
                  h('button', {
                    type: 'button',
                    className: 'ad-btn ad-primary ad-sm',
                    onClick: () => { runCrossImport().catch(() => {}) },
                    disabled: crossBusy || crossTotalSelected === 0 || !crossSourceTitle,
                  }, crossBusy ? '导入中…' : `开始导入（${crossTotalSelected}）`),
                  crossBusy
                    ? h('span', { className: 'ad-sub', role: 'status' }, `正在导入 ${crossTotalSelected} 项…`)
                    : null),
                crossSummary
                  ? h('div', { className: 'ad-import-summary', role: 'status' },
                      crossSummaryLines.map((line) => h('div', { key: line }, line)),
                      crossIdMapLines.length
                        ? h('div', { className: 'ad-cross-idmap' }, crossIdMapLines.map((line) => h('div', { key: line }, `新编号：${line}`)))
                        : null,
                      crossFailList.length
                        ? h('div', { className: 'ad-scan-fail-list' },
                            crossFailList.map((item) => h('div', { className: 'ad-scan-fail-item', key: `${item.kind}-${item.sourceId}-${item.reason}` }, `${item.name}：${item.reason}`)),
                            h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: () => { retryCrossFailed().catch(() => {}) }, disabled: crossBusy }, '选中失败项重试'))
                        : h('div', { className: 'ad-ok' }, '全部导入成功'))
                  : null,
                crossWarnings.length
                  ? h('div', { className: 'ad-cross-warning', role: 'status' },
                      crossWarnings.map((warning) => h('div', { key: warning }, `警告：${warning}`)))
                  : null)
            : null

          // v0.16.9（C3-C / E16+H-8）：资产/场景卡审核工作台（素材库第三视图；仅存在 review 卡时显示入口；旧项目零新 UI）
          const assetReviewHasAny = Boolean(
            (Array.isArray(assetCards) && assetCards.some((card) => card && card.review)) ||
            (Array.isArray(visualScenes) && visualScenes.some((scene) => scene && scene.review)),
          )
          const assetReviewKindCards = assetReviewKindCardsOf(assetReviewKind)
          const assetReviewStatusCounts = {}
          for (const status of ASSET_REVIEW_STATUS_ORDER) assetReviewStatusCounts[status] = 0
          for (const item of assetReviewKindCards) {
            if (item.review && ASSET_REVIEW_STATUS_ORDER.includes(item.review.status)) assetReviewStatusCounts[item.review.status] += 1
          }
          const assetReviewTypeCounts = new Map()
          for (const item of assetReviewKindCards) assetReviewTypeCounts.set(item.type, (assetReviewTypeCounts.get(item.type) || 0) + 1)
          const assetReviewKeyword = String(assetReviewQuery || '').trim().toLowerCase()
          const assetReviewVisibleCards = assetReviewKindCards.filter((item) => {
            if (assetReviewStatusFilter !== 'all' && (!item.review || item.review.status !== assetReviewStatusFilter)) return false
            if (assetReviewKind === 'asset' && assetReviewTypeFilter !== '全部' && String(item.type || '').toUpperCase() !== assetReviewTypeFilter) return false
            if (!assetReviewKeyword) return true
            return String(item.id || '').toLowerCase().includes(assetReviewKeyword) || String(item.name || '').toLowerCase().includes(assetReviewKeyword)
          })
          const assetReviewSelectedCard = assetReviewSelectedCardOf()
          const assetReviewPromptText = String(assetReviewPrompt || '')
          const assetReviewPromptTrimmed = assetReviewPromptText.trim()
          const assetReviewPromptDirty = Boolean(assetReviewSelectedCard && assetReviewSelectedCard.review && assetReviewPromptTrimmed !== String(assetReviewSelectedCard.review.currentPrompt || '').trim())
          const assetReviewBadgeNode = (review) => h('span', {
            className: 'ad-review-badge',
            'data-status': review && ASSET_REVIEW_STATUS_ORDER.includes(review.status) ? review.status : 'draft',
          }, assetReviewStatusLabel(review))
          const assetReviewListNodes = assetReviewVisibleCards.length
            ? assetReviewVisibleCards.map((item) => h('button', {
                key: item.id,
                type: 'button',
                className: 'ad-review-item',
                'aria-pressed': String(item.id || '').toUpperCase() === String(assetReviewSelectedId || '').toUpperCase(),
                onClick: () => selectAssetReviewCard(item),
              },
                h('span', { className: 'ad-review-item-title' },
                  h('span', null, `${item.id} ${item.name}`),
                  assetReviewBadgeNode(item.review)),
                h('span', { className: 'ad-review-item-meta' }, `第 ${item.review.roundCount} 轮 · revision ${item.review.revision}`),
                String(item.review.currentPrompt || '').trim()
                  ? h('span', { className: 'ad-review-item-meta' }, String(item.review.currentPrompt || '').trim().length > 72 ? String(item.review.currentPrompt || '').trim().slice(0, 72) + '…' : String(item.review.currentPrompt || '').trim())
                  : null))
            : h('div', { className: 'ad-table-empty' }, '当前筛选没有审核卡')
          const assetReviewRoundNodes = assetReviewSelectedCard && assetReviewSelectedCard.review
            ? (assetReviewSelectedCard.review.rounds.length
                ? assetReviewSelectedCard.review.rounds.slice().reverse().map((round, index) => h('div', { className: 'ad-review-round', key: `${round.round}-${index}` },
                    h('div', { className: 'ad-review-round-head' },
                      h('span', null, `第 ${round.round} 轮`),
                      h('span', { className: 'ad-review-badge', 'data-status': round.status }, ASSET_REVIEW_STATUS_LABELS[round.status] || round.status),
                      round.submittedAt ? h('span', null, `提交 ${styleMomentText(round.submittedAt)}`) : null,
                      round.reviewedAt ? h('span', null, `审核 ${styleMomentText(round.reviewedAt)}`) : null,
                      round.reviewer ? h('span', null, `审核人 ${round.reviewer}`) : null),
                    round.reason ? h('div', { className: 'ad-review-round-reason' }, `意见：${round.reason}`) : null,
                    round.prompt ? h('div', { className: 'ad-review-round-prompt' }, `提示词：${round.prompt.length > 160 ? round.prompt.slice(0, 160) + '…' : round.prompt}`) : null))
                : [h('div', { className: 'ad-table-empty', key: 'no-round' }, '还没有提交记录')])
            : null
          const assetReviewDetailActions = []
          if (assetReviewSelectedCard && assetReviewSelectedCard.review) {
            const detailStatus = assetReviewSelectedCard.review.status
            if (detailStatus === 'draft' || detailStatus === 'rejected') {
              assetReviewDetailActions.push(h('button', {
                key: 'save-draft',
                type: 'button',
                className: 'ad-btn ad-primary ad-sm',
                disabled: assetReviewBusy,
                onClick: () => { runAssetReviewAction('saveDraft').catch(() => {}) },
              }, '保存草稿'))
              assetReviewDetailActions.push(h('button', {
                key: 'submit',
                type: 'button',
                className: 'ad-btn ad-sm',
                disabled: assetReviewBusy || !assetReviewPromptTrimmed,
                onClick: () => {
                  if (assetReviewPromptDirty) {
                    setAssetReviewPromptError('有未保存提示词修改：请先保存草稿，再提交审核')
                    return
                  }
                  runAssetReviewAction('submit').catch(() => {})
                },
              }, '提交审核'))
            } else if (detailStatus === 'pending') {
              assetReviewDetailActions.push(h('button', { key: 'approve', type: 'button', className: 'ad-btn ad-primary ad-sm', disabled: assetReviewBusy, onClick: () => { runAssetReviewAction('approve').catch(() => {}) } }, '通过'))
              assetReviewDetailActions.push(h('button', { key: 'reject', type: 'button', className: 'ad-btn ad-sm', disabled: assetReviewBusy, onClick: () => openAssetReviewDialog('reject') }, '驳回'))
            } else if (detailStatus === 'approved') {
              assetReviewDetailActions.push(h('button', { key: 'finalize', type: 'button', className: 'ad-btn ad-primary ad-sm', disabled: assetReviewBusy, onClick: () => openAssetReviewDialog('finalize') }, '定稿'))
              assetReviewDetailActions.push(h('button', { key: 'reopen', type: 'button', className: 'ad-btn ad-sm', disabled: assetReviewBusy, onClick: () => openAssetReviewDialog('reopen') }, '重打开'))
            } else if (detailStatus === 'final') {
              assetReviewDetailActions.push(h('button', { key: 'reopen', type: 'button', className: 'ad-btn ad-primary ad-sm', disabled: assetReviewBusy, onClick: () => openAssetReviewDialog('reopen') }, '重打开'))
            }
            assetReviewDetailActions.push(h('button', {
              key: 'refresh',
              type: 'button',
              className: 'ad-btn ad-sm',
              disabled: assetReviewBusy,
              onClick: () => { loadAssets({ keepView: true }).catch(() => {}) },
            }, icon('refresh'), '刷新'))
          }
          const assetReviewDetailNode = assetReviewSelectedCard && assetReviewSelectedCard.review
            ? (() => {
                const detailStatus = assetReviewSelectedCard.review.status
                const detailLocked = detailStatus === 'pending' || detailStatus === 'approved' || detailStatus === 'final'
                return h('div', { className: 'ad-review-detail', key: 'review-detail' },
                  h('div', { className: 'ad-review-detail-head' },
                    h('strong', null, `${assetReviewSelectedCard.id} ${assetReviewSelectedCard.name}`),
                    assetReviewBadgeNode(assetReviewSelectedCard.review),
                    h('span', null, `第 ${assetReviewSelectedCard.review.roundCount} 轮 · revision ${assetReviewSelectedCard.review.revision} · promptVersion ${assetReviewSelectedCard.review.promptVersion}`),
                    assetReviewSelectedCard.review.reopenCount > 0
                      ? h('span', { className: 'ad-review-round-reason' }, `重打开 ${assetReviewSelectedCard.review.reopenCount} 次${assetReviewSelectedCard.review.reopenCount >= 3 ? ' ⚠️ 建议复核流程' : ''}`)
                      : null),
                  detailStatus === 'final'
                    ? h('div', { className: 'ad-review-frozen', role: 'status' },
                        `已定稿，需重打开后才能修改${assetReviewSelectedCard.review.finalPrompt ? `；定稿提示词：${assetReviewSelectedCard.review.finalPrompt.length > 160 ? assetReviewSelectedCard.review.finalPrompt.slice(0, 160) + '…' : assetReviewSelectedCard.review.finalPrompt}` : ''}`)
                    : detailStatus === 'approved'
                      ? h('div', { className: 'ad-hint-next', role: 'status' }, '已通过：可直接定稿；如需修改提示词请先「重打开」。')
                      : detailStatus === 'pending'
                        ? h('div', { className: 'ad-hint-next', role: 'status' }, '待审核：提示词只读，等待通过或驳回。')
                        : null,
                  h('div', { className: 'ad-review-prompt' },
                    h('div', { className: 'ad-style-count' },
                      `当前提示词（1–${ASSET_REVIEW_PROMPT_MAX} 字）`,
                      h('span', { className: 'ad-review-counter', 'data-over': assetReviewPromptTrimmed.length > ASSET_REVIEW_PROMPT_MAX ? '1' : '0' }, ` ${assetReviewPromptTrimmed.length}/${ASSET_REVIEW_PROMPT_MAX}`)),
                    h('textarea', {
                      className: 'ad-area',
                      rows: 5,
                      maxLength: ASSET_REVIEW_PROMPT_MAX,
                      value: assetReviewPromptText,
                      disabled: assetReviewBusy || detailLocked,
                      'aria-label': '当前提示词（1–2000 字）',
                      placeholder: '填写用于资产生成的提示词（1–2000 字）',
                      onChange: (event) => {
                        setAssetReviewPrompt(event && event.target ? event.target.value : '')
                        if (assetReviewPromptError) setAssetReviewPromptError('')
                      },
                    }),
                    assetReviewPromptError ? h('div', { className: 'ad-err', role: 'alert' }, assetReviewPromptError) : null,
                    assetReviewPromptDirty && !detailLocked ? h('div', { className: 'ad-hint-next', role: 'status' }, '有未保存提示词修改：提交审核前请先「保存草稿」。') : null),
                  h('div', { className: 'ad-review-actions' }, assetReviewDetailActions),
                  h('div', { className: 'ad-review-rounds' },
                    h('div', { className: 'ad-sec' }, `轮次历史 · 累计 ${assetReviewSelectedCard.review.roundCount} 轮（保留最近 ${assetReviewSelectedCard.review.rounds.length} 条）`),
                    assetReviewRoundNodes))
              })()
            : h('div', { className: 'ad-table-empty' }, '选择左侧卡片查看/编辑提示词与轮次历史')
          const assetReviewBoardNode = h('div', { key: 'review-board', className: 'ad-review' },
            h('div', { className: 'ad-review-kind', role: 'tablist', 'aria-label': '审核卡类型' },
              ['asset', 'scene'].map((kind) => h('button', {
                key: kind,
                type: 'button',
                role: 'tab',
                'aria-selected': assetReviewKind === kind,
                className: 'ad-btn ad-sm',
                'aria-pressed': assetReviewKind === kind,
                onClick: () => {
                  setAssetReviewKind(kind)
                  setAssetReviewSelectedId('')
                  setAssetReviewPrompt('')
                  setAssetReviewPromptError('')
                  setAssetReviewReason('')
                  setAssetReviewReasonError('')
                  setAssetReviewDialog(null)
                  setAssetReviewError('')
                  setAssetReviewNotice('')
                  const first = firstAssetReviewCardOf(kind)
                  if (first) selectAssetReviewCard(first)
                },
              }, ASSET_REVIEW_KIND_LABELS[kind]))),
            h('div', { className: 'ad-review-filters' },
              h('button', { type: 'button', className: 'ad-asset-chip', 'aria-pressed': assetReviewStatusFilter === 'all', onClick: () => setAssetReviewStatusFilter('all') }, `全部 ${assetReviewKindCards.length}`),
              ASSET_REVIEW_STATUS_ORDER.map((status) => h('button', {
                key: status,
                type: 'button',
                className: 'ad-asset-chip',
                'aria-pressed': assetReviewStatusFilter === status,
                onClick: () => setAssetReviewStatusFilter(status),
              }, `${ASSET_REVIEW_STATUS_LABELS[status]} ${assetReviewStatusCounts[status] || 0}`)),
              assetReviewKind === 'asset'
                ? [['全部', '全部'], ['CHR', '角色'], ['SPC', '场景'], ['PRP', '道具']].map(([type, label]) => h('button', {
                    key: type,
                    type: 'button',
                    className: 'ad-asset-chip',
                    'aria-pressed': assetReviewTypeFilter === type,
                    onClick: () => setAssetReviewTypeFilter(type),
                  }, `${label} ${type === '全部' ? assetReviewKindCards.length : (assetReviewTypeCounts.get(type) || 0)}`))
                : null,
              h('input', {
                className: 'ad-input ad-sm',
                style: { maxWidth: 220 },
                type: 'search',
                'aria-label': '搜索审核卡编号或名称',
                placeholder: '搜索编号或名称…',
                value: assetReviewQuery,
                onChange: (event) => setAssetReviewQuery(event && event.target ? event.target.value : ''),
              })),
            assetReviewNotice ? h('div', { className: 'ad-ok', role: 'status' }, assetReviewNotice) : null,
            assetReviewError
              ? h('div', { className: 'ad-err-box', role: 'alert' },
                  h('div', { className: 'ad-err-head' }, '审核操作失败'),
                  h('div', { className: 'ad-err' }, assetReviewError))
              : null,
            h('div', { className: 'ad-review-body' },
              h('div', { className: 'ad-review-list', role: 'list', 'aria-label': '审核卡列表' }, assetReviewListNodes),
              assetReviewDetailNode))
          body.push(
            h('div', { key: 'as' },
              registryWarningNode,
              registryNoticeNode,
              h('div', { key: 'asset-view-switch', className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap', gap: 8 }, role: 'group', 'aria-label': '素材库视图切换' },
                h('button', { type: 'button', className: 'ad-btn ad-sm', 'aria-pressed': assetView === 'cards', onClick: () => { setAssetView('cards'); closeVisualLightbox() } }, '卡片视图'),
                h('button', { type: 'button', className: 'ad-btn ad-sm', 'aria-pressed': assetView === 'visual', onClick: () => { setAssetView('visual'); closeVisualLightbox(); ensureVisualAssets() } }, '视觉圣经'),
                assetReviewHasAny
                  ? h('button', {
                      type: 'button',
                      className: 'ad-btn ad-sm',
                      'aria-pressed': assetView === 'review',
                      onClick: () => {
                        setAssetView('review')
                        closeVisualLightbox()
                        const hasAssetReview = firstAssetReviewCardOf('asset') !== null
                        const hasSceneReview = firstAssetReviewCardOf('scene') !== null
                        const nextKind = hasAssetReview ? 'asset' : (hasSceneReview ? 'scene' : assetReviewKind)
                        if (nextKind !== assetReviewKind) setAssetReviewKind(nextKind)
                        const first = firstAssetReviewCardOf(nextKind)
                        if (first) selectAssetReviewCard(first)
                      },
                    }, '审核工作台')
                  : null),
              assetView === 'review' && assetReviewHasAny
                ? assetReviewBoardNode
                : assetView === 'visual'
                ? visualBibleNode
                : hasAssetData
                ? h('div', { key: 'asset-unified' },
                    legacyUnifiedNode,
                    assetCards.length
                    ? h('div', { key: 'asset-card-view' },
                    h('div', { className: 'ad-row', style: { marginBottom: 8, flexWrap: 'wrap', gap: 8 } },
                      h('span', { className: 'ad-sub' }, `素材卡 · 共 ${assetCards.length} 张（按资产卡类型分类；只读）`),
                      h('div', { style: { flex: 1 } }),
                      h('input', {
                        className: 'ad-input ad-sm',
                        style: { maxWidth: 240 },
                        type: 'search',
                        'aria-label': '搜索素材编号或名称',
                        placeholder: '搜索编号或名称…',
                        value: assetQuery,
                        onChange: (e) => {
                          const value = e.target.value
                          setAssetQuery(value)
                          ensureAssetImages(assetCardImagePaths(filterAssetCards(assetCards, assetTypeFilter, value)))
                        },
                      })),
                    h('div', { className: 'ad-asset-toolbar', role: 'group', 'aria-label': '素材类型筛选' },
                      h('button', {
                        type: 'button',
                        className: 'ad-asset-chip',
                        'aria-pressed': assetTypeFilter === '全部',
                        onClick: () => {
                          setAssetTypeFilter('全部')
                          setAssetImageIndex(0)
                          ensureAssetImages(assetCardImagePaths(filterAssetCards(assetCards, '全部', assetQuery)))
                        },
                      }, `全部 ${assetCards.length}`),
                      typeChips.map(([type, label]) => h('button', {
                        key: type,
                        type: 'button',
                        className: 'ad-asset-chip',
                        'aria-pressed': assetTypeFilter === type,
                        onClick: () => {
                          setAssetTypeFilter(type)
                          setAssetImageIndex(0)
                          ensureAssetImages(assetCardImagePaths(filterAssetCards(assetCards, type, assetQuery)))
                        },
                      }, `${label} ${typeCounts.get(type)}`))),
                    visibleAssetCards.length
                      ? h('div', { className: 'ad-asset-grid', role: 'list', 'aria-label': '素材卡网格' },
                          visibleAssetCards.map((card) => {
                            const pressed = assetSelectedId === card.id
                            return h('button', {
                              key: card.id,
                              type: 'button',
                              className: 'ad-asset-card',
                              role: 'listitem',
                              'aria-pressed': pressed,
                              'aria-label': `查看资产 ${card.id} ${card.name}`,
                              onClick: () => {
                                setAssetSelectedId(pressed ? null : card.id)
                                setAssetImageIndex(0)
                                setAssetAudioIndex(0)
                                if (!pressed && card.media) {
                                  ensureAssetImages([...(card.media.images || []), ...(card.media.audio || []), card.media.thumbnail || ''])
                                }
                              },
                            },
                              assetCardThumb(card),
                              h('span', { className: 'ad-asset-card-meta' },
                                h('span', { className: 'ad-asset-card-id' }, card.id),
                                h('span', { className: 'ad-asset-card-name' }, card.name)),
                              h('span', { className: 'ad-asset-badge' }, assetTypeLabelOf(card.type)))
                          }))
                      : h('div', { className: 'ad-table-empty' }, assetQuery.trim() ? '没有匹配的素材卡（换个编号或名称试试）' : '该分类下暂时没有素材卡'),
                    selectedCard ? assetDetail(selectedCard) : null)
                      : null)
                : null,
              assetActionsToolbarNode,
              scanPanelNode,
              importPanelNode,
              crossImportPanelNode,
              visualBibleHintNode,
              assetRegistrationNode,
          ))
        }

        if (tab === 'memory') {
          body.push(
            h('div', { key: 'mem' },
              h('div', { className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap' } },
                h('button', { className: 'ad-btn ad-sm', onClick: addMem, disabled: busy }, icon('plus'), '增加条目'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveMemory, disabled: busy }, '保存本剧记忆'),
                dirty.memory ? dirtyMark('memory') : null,
                h('span', { className: 'ad-sub' }, '伏笔 / 已用桥段 / 时间线 / 待回收 —— 生成前先读这里可避免重复与冲突；Ctrl/⌘+S 保存本页')),
              h('table', { className: 'ad-table' },
                h('caption', { className: 'ad-sr-only' }, '本剧记忆表'),
                h('thead', null, h('tr', null, ['类型', '内容', '集数', '状态', ''].map((t, i) => h('th', { key: i, scope: 'col' }, t)))),
                h('tbody', null,
                  memory.length
                    ? memory.map((entry, i) =>
                        h('tr', { key: i },
                          h('td', null, h('select', { value: entry.kind, onChange: (e) => setMem(i, 'kind', e.target.value) },
                            ['伏笔', '已用桥段', '时间线', '待回收'].map((k) => h('option', { key: k, value: k }, k)))),
                          h('td', null, h('textarea', { rows: 2, value: entry.content, onChange: (e) => setMem(i, 'content', e.target.value) })),
                          h('td', null, h('input', { style: { maxWidth: 64 }, value: entry.episode == null ? '' : entry.episode, onChange: (e) => setMem(i, 'episode', e.target.value === '' ? null : Number(e.target.value) || null) })),
                          h('td', null, h('select', { value: entry.status, onChange: (e) => setMem(i, 'status', e.target.value) },
                            h('option', { value: 'open' }, '未回收'), h('option', { value: 'resolved' }, '已回收'))),
                          h('td', null, h('button', { type: 'button', className: 'ad-btn ad-sm ad-btn-danger ad-icon-btn ad-icon-btn-sm', 'data-tone': 'danger', 'aria-label': '删除记忆条目', title: '删除记忆条目', onClick: () => removeMem(i) }, icon('trash')))))
                    : h('tr', null, h('td', { colSpan: 5, className: 'ad-table-empty' }, '还没有记忆条目。记下伏笔和已用桥段，后续生成才不会撞车。')))),
              h('div', { className: 'ad-path' }, '保存后会同时渲染到 本剧记忆/本剧记忆.md'),
            ),
          )
        }

        if (tab === 'world') {
          body.push(
            h('div', { key: 'wd' },
              h('div', { className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap' } },
                h('button', { className: 'ad-btn ad-sm', onClick: addWorldEntry, disabled: busy }, icon('plus'), '增加设定'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveWorld, disabled: busy, 'aria-keyshortcuts': 'Control+S Meta+S' }, '保存世界观'),
                dirty.world ? dirtyMark('world') : null,
                h('span', { className: 'ad-sub' }, '地点 / 组织 / 规则 / 道具 / 时间线 —— 分集剧本与分镜会引用这些设定；Ctrl/⌘+S 保存本页')),
              h('table', { className: 'ad-table' },
                h('caption', { className: 'ad-sr-only' }, '世界观设定表'),
                h('thead', null, h('tr', null, ['类型', '名称', '说明', ''].map((t, i) => h('th', { key: i, scope: 'col' }, t)))),
                h('tbody', null,
                  world.length
                    ? world.map((entry, i) =>
                        h('tr', { key: i },
                          h('td', null, h('select', { value: entry.kind, onChange: (e) => setWorldEntry(i, 'kind', e.target.value) },
                            ['地点', '组织', '规则', '道具', '时间线'].map((k) => h('option', { key: k, value: k }, k)))),
                          h('td', null, h('input', { value: entry.name, onChange: (e) => setWorldEntry(i, 'name', e.target.value) })),
                          h('td', null, h('textarea', { rows: 2, value: entry.detail, onChange: (e) => setWorldEntry(i, 'detail', e.target.value) })),
                          h('td', null, h('button', { type: 'button', className: 'ad-btn ad-sm ad-btn-danger ad-icon-btn ad-icon-btn-sm', 'data-tone': 'danger', 'aria-label': '删除世界观条目', title: '删除世界观条目', onClick: () => removeWorldEntry(i) }, icon('trash')))))
                    : h('tr', null, h('td', { colSpan: 4, className: 'ad-table-empty' }, '还没有世界观设定。先把地点与规则定下来，后面写剧本才不会自相矛盾。')))),
              h('div', { className: 'ad-path' }, '保存后会同时渲染到 世界观/世界观.md'),
            ),
          )
        }

        if (tab === 'drafts') {
          const allSelected = pendingDrafts.length > 0 && selectedDraftIds.length === pendingDrafts.length
          body.push(
            h('div', { key: 'dr' },
              h('div', { className: 'ad-row', style: { marginBottom: 8, flexWrap: 'wrap' } },
                h('button', { className: 'ad-btn ad-sm', onClick: () => loadDrafts(false), disabled: busy }, icon('refresh'), '刷新待处理'),
                h('button', { className: 'ad-btn ad-sm', onClick: () => loadDrafts(true), disabled: busy }, '含已处理'),
                hostFlags.p1 && pendingDrafts.length
                  ? h('button', { className: 'ad-btn ad-sm', onClick: toggleSelectAllDrafts, disabled: busy }, allSelected ? '取消全选' : `全选待处理（${pendingDrafts.length}）`)
                  : null,
                hostFlags.p1
                  ? h('button', { className: 'ad-btn ad-primary ad-sm', onClick: () => batchResolveDrafts('accept'), disabled: busy || !selectedDraftIds.length }, `批量采纳（${selectedDraftIds.length}）`)
                  : null,
                hostFlags.p1
                  ? h('button', { className: 'ad-btn ad-sm ad-btn-danger', onClick: () => batchResolveDrafts('discard'), disabled: busy || !selectedDraftIds.length }, `批量丢弃（${selectedDraftIds.length}）`)
                  : null,
                h('span', { className: 'ad-sub' }, 'AI 生成物先落草稿区，采纳后才写入正式稿')),
              !hostFlags.p1
                ? h('div', { className: 'ad-warn' }, '当前宿主版本 < 0.4.0：批量采纳/丢弃与「恢复」不可用；单条采纳/丢弃不受影响（升级插件后自动启用）。')
                : null,
              draftList.length
                ? draftList.map((draft) =>
                    h('div', { className: 'ad-box', key: draft.id, style: { marginBottom: 10 } },
                      h('div', { className: 'ad-row', style: { marginBottom: 6 } },
                        hostFlags.p1 && draft.status === 'pending'
                          ? h('input', {
                              type: 'checkbox',
                              className: 'ad-check',
                              checked: Boolean(draftSelection[draft.id]),
                              'aria-label': `选择草稿 ${draft.title || draft.id}`,
                              onChange: () => toggleDraftSelection(draft.id),
                            })
                          : null,
                        h('span', { className: 'ad-count' }, `[${draft.kind}${draft.order ? ' 第' + draft.order + '集' : ''}]`),
                        h('strong', null, draft.title || draft.path || '(无标题)'),
                        h('span', { className: 'ad-count' }, draft.status),
                        h('div', { style: { flex: 1 } }),
                        draft.status === 'pending'
                          ? h('button', { className: 'ad-btn ad-primary ad-sm', onClick: () => resolveDraft(draft.id, 'accept'), disabled: busy }, '采纳')
                          : null,
                        draft.status === 'pending'
                          ? h('button', { className: 'ad-btn ad-sm ad-btn-danger', onClick: () => resolveDraft(draft.id, 'discard'), disabled: busy }, '丢弃')
                          : null,
                        draft.status === 'discarded' && hostFlags.p1
                          ? h('button', { className: 'ad-btn ad-sm', onClick: () => restoreDraft(draft.id), disabled: busy }, '恢复')
                          : null,
                        draft.status === 'discarded' && !hostFlags.p1
                          ? h('span', { className: 'ad-count' }, '升级插件后可恢复')
                          : null),
                      draft.note ? h('div', { className: 'ad-sub', style: { marginBottom: 6 } }, draft.note) : null,
                      h('div', { className: 'ad-count', style: { marginBottom: 6 } },
                        `来源：${draft.origin.preset}${draft.origin.toolName ? ' · ' + draft.origin.toolName : ''} · ${draft.origin.at}`),
                      h('pre', { className: 'ad-pre' }, String(draft.content).slice(0, 800) + (String(draft.content).length > 800 ? '\n…' : ''))))
                : emptyState({ key: 'drafts-empty', title: '草稿区是空的', description: '在「短剧模式」会话里让 Agent 生成内容后，会出现在这里等你采纳。', next: '对 Agent 说「写第 N 集」或使用对应 drama_* 工具' })),
          )
        }

        if (tab === 'ledger') {
          body.push(
            h('div', { key: 'lg' },
              h('div', { className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: () => loadLedger(), disabled: busy }, m3Supported === true ? '加载账本（只读）' : '生成账本'),
                m3Supported === true
                  ? h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: renderLedgerFile, disabled: busy }, '渲染账本文件')
                  : null,
                h('span', { className: 'ad-sub' }, '从剧本与分镜推导：场景 / 内外景 / 镜头 / 时长 / 角色 / 地点 + 成本提示')),
              ledger
                ? h('div', null,
                    h('div', { className: 'ad-sec', style: { marginTop: 4 } }, '合计'),
                    h('div', { className: 'ad-count', style: { marginBottom: 10 } },
                      `集数 ${ledger.totals.episodes} · 场景 ${ledger.totals.scenes} · 镜头 ${ledger.totals.shots} · 总时长 ${ledger.totals.durationSec}s（约 ${(ledger.totals.durationSec / 60).toFixed(1)} 分钟）· 角色 ${ledger.totals.characters.length} 人 · 地点 ${ledger.totals.locations.length} 处`),
                    h('table', { className: 'ad-table' },
                      h('caption', { className: 'ad-sr-only' }, '账本合计表'),
                      h('thead', null, h('tr', null, ['集数', '场景', '内景', '外景', '镜头', '时长(秒)', '出场角色', '地点'].map((t, i) => h('th', { key: i, scope: 'col' }, t)))),
                      h('tbody', null,
                        ledger.perEpisode.map((e) =>
                          h('tr', { key: e.order },
                            h('td', null, e.order),
                            h('td', null, e.scenes),
                            h('td', null, e.interiorScenes),
                            h('td', null, e.exteriorScenes),
                            h('td', null, e.shots),
                            h('td', null, e.durationSec),
                            h('td', null, e.characters.join('、') || '—'),
                            h('td', null, e.locations.join('、') || '—'))))),
                    h('div', { className: 'ad-sec' }, `成本提示 · ${ledger.warnings.length}`),
                    ledger.warnings.length
                      ? h('div', { className: 'ad-hits' }, ledger.warnings.map((w, i) => h('div', { className: 'ad-hit', key: i }, w)))
                      : h('div', { className: 'ad-hint-next' }, '未发现明显成本风险。'),
                    m3Supported === true
                      ? h('div', { className: 'ad-path' }, '默认只读，不写 账本/账本.md；点「渲染账本文件」才写入')
                      : h('div', { className: 'ad-path' }, '同时渲染到 账本/账本.md'),
                    m3Supported === true && ledgerRendered ? h('div', { className: 'ad-ok', role: 'status' }, '已渲染到项目账本') : null)
                : emptyState({ key: 'ledger-empty', title: '还没有拍摄账本', description: '点「生成账本」看全剧的场景、镜头、时长与成本结构。', next: '点上方「生成账本」', actions: [{ label: m3Supported === true ? '加载账本' : '生成账本', onClick: () => loadLedger(), disabled: busy }] })),
          )
        }

        if (tab === 'generate') {
          const binding = genCanvas && genCanvas.binding
          const snapshot = genCanvas && genCanvas.snapshot
          const canvases = genBackends || []
          const warn = genCanvas && genCanvas.upstreamWarning
          body.push(
            h('div', { key: 'gen' },
              h('div', { className: 'ad-row', style: { marginBottom: 10 } },
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: loadGenerate, disabled: busy }, icon('refresh'), '刷新状态'),
                h('span', { className: 'ad-sub' }, '主选 LibTV（画布 CLI），备选 NeoWoW（CLI）')),

              h('div', { className: 'ad-sec' }, '① 画布绑定'),
              binding
                ? (binding.ok
                    ? h('div', { className: 'ad-count' }, `已绑定：${binding.uuid}`)
                    : h('div', null,
                        h('div', { className: 'ad-hint-next' }, binding.detail),
                        h('div', { className: 'ad-path' }, binding.fix || '')))
                : h('div', { className: 'ad-hint-next' }, '点「刷新状态」查看绑定情况。'),
              canvases.length
                ? h('div', { className: 'ad-hits', style: { maxHeight: 180, overflow: 'auto', marginTop: 6 } },
                    canvases.slice(0, 30).map((c) =>
                      h('div', { className: 'ad-hit', key: c.uuid, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                        h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, `${c.name} · ${c.uuid.slice(0, 8)}`),
                        h('button', { className: 'ad-btn ad-sm', 'aria-label': '绑定画布 ' + c.name, onClick: () => bindCanvas(c.uuid), disabled: busy }, '绑定'))))
                : h('div', { className: 'ad-hint-next' }, '没读到候选画布（LibTV CLI 不可用时为空）。'),
              canvases.length > 30
                ? h('div', { className: 'ad-hint-next', key: 'canvas-truncated', role: 'status', 'aria-live': 'polite' }, '已截断：仅显示前 30 个候选画布（共 ' + canvases.length + ' 个）；可点上方「刷新状态」重新载入。')
                : null,

              h('div', { className: 'ad-sec' }, '② 预算护栏'),
              genBudget
                ? h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 8, marginBottom: 8 } },
                    h('span', { className: 'ad-count' },
                      `上限 ${genBudget.limitPoints == null ? '未设' : genBudget.limitPoints} · 已消耗 ${genBudget.spentPoints} · 剩余 ${genBudget.remainingPoints == null ? '—' : genBudget.remainingPoints}`),
                    h('input', { className: 'ad-input ad-sm', style: { width: 110 }, 'aria-label': '预算上限（留空取消）', placeholder: '上限（空=取消）', value: genLimit, onChange: (e) => setGenLimit(e.target.value) }),
                    h('button', { className: 'ad-btn ad-sm', onClick: saveBudget, disabled: busy }, '保存'))
                : h('div', { className: 'ad-hint-next' }, '点「刷新状态」读取预算。'),
              h('div', { className: 'ad-hint-next', key: 'hint-estimate' }, '生成前查看各后端预计消耗（只查价目，不触发生成）'),
              h('div', { className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap', gap: 8 } },
                h('button', { className: 'ad-btn ad-sm', onClick: estimateGeneration, disabled: genEstimateBusy || busy }, genEstimateBusy ? '预估中…' : '预估成本（只读）'),
                h('span', { className: 'ad-sub' }, '按当前类型 / 模型 / 本集镜头数查询价目；不触发生成、不消耗积分'),
                genEstimate && !genEstimateBusy
                  ? (() => {
                      const estimates = Array.isArray(genEstimate.estimates) ? genEstimate.estimates : []
                      if (genEstimate.error) return h('div', { className: 'ad-hint-next', style: { width: '100%' } }, '预估失败：' + genEstimate.error + '（不阻塞；可稍后重试）')
                      if (!estimates.length) return h('div', { className: 'ad-hint-next', style: { width: '100%' } }, genEstimate.detail || '未获取到后端预估（后端不可用时不阻塞）')
                      return h('div', { className: 'ad-hits', role: 'status', style: { width: '100%', maxHeight: 180, overflow: 'auto' } },
                        estimates.map((item, i) =>
                          h('div', { className: 'ad-hit', key: i },
                            h('div', { className: 'ad-hit-path' }, (item.label || item.backend || '后端') + (item.ok ? '' : ' · 不可估算')),
                            h('div', null, item.ok
                              ? '单位 ' + (item.unit == null ? '—' : item.unit) + ' · 合计 ' + (item.total == null ? '—' : item.total) + ' ' + (item.currency || '积分') + '（' + (item.basis || '—') + '）；数量 ' + (genEstimate.unitCount || '—')
                              : String(item.detail || item.reason || '无本地价目') + (item.note ? ' · ' + item.note : '')))))
                    })()
                  : null),

              h('div', { className: 'ad-sec' }, `③ 任务（${genTasks.length}）`),
              h('div', { className: 'ad-hint-next', key: 'hint-task-record' }, '仅记录任务台账，不提交生成'),
              h('div', { className: 'ad-row', style: { marginBottom: 8, flexWrap: 'wrap', gap: 8 } },
                h('span', { className: 'ad-sub' }, '登记任务（只写台账，不提交生成）'),
                h('select', { className: 'ad-input ad-sm', 'aria-label': '登记任务后端', value: taskRecordBackend, onChange: (e) => setTaskRecordBackend(e.target.value), disabled: taskRecordBusy },
                  h('option', { value: 'libtv' }, 'libtv'), h('option', { value: 'neowow' }, 'neowow')),
                h('input', { className: 'ad-input ad-sm', style: { width: 260 }, 'aria-label': '登记任务提示词（可选）', placeholder: '提示词 / 备注（可选）', value: taskRecordPrompt, onChange: (e) => setTaskRecordPrompt(e.target.value) }),
                h('button', { className: 'ad-btn ad-sm', onClick: createTaskRecord, disabled: taskRecordBusy || busy || !openTitle }, taskRecordBusy ? '处理中…' : '登记任务')),
              taskNotice ? h('div', { className: 'ad-hint-next', key: 'task-notice', role: 'status' }, taskNotice) : null,
              genTasks.length
                ? h('table', { className: 'ad-table' },
                  h('caption', { className: 'ad-sr-only' }, '生成任务表'),
                    h('thead', null, h('tr', null, ['集', '类型', '模型', '状态', '预估', '实际', '产物', '操作'].map((t, i) => h('th', { key: i, scope: 'col' }, t)))),
                    h('tbody', null,
                      genTasks.slice(0, 30).map((t) =>
                        h('tr', { key: t.id },
                          h('td', null, t.episode == null ? '—' : t.episode),
                          h('td', null, t.kind),
                          h('td', null, t.model || '—'),
                          h('td', null, t.status),
                          h('td', null, t.estimatePoints == null ? '—' : t.estimatePoints),
                          h('td', null, t.actualPoints == null ? '—' : t.actualPoints),
                          h('td', null, String((t.artifacts || []).length)),
                          h('td', null,
                            h('select', {
                              className: 'ad-input ad-sm',
                              'aria-label': '任务 ' + t.id + ' 状态',
                              value: taskStatusDraft[t.id] || t.status,
                              onChange: (e) => setTaskStatusDraft((prev) => ({ ...prev, [t.id]: e.target.value })),
                              disabled: taskRecordBusy,
                            }, ['planned', 'submitted', 'running', 'done', 'failed', 'cancelled'].map((s) => h('option', { key: s, value: s }, s))),
                            h('button', { className: 'ad-btn ad-sm', 'aria-label': '更新任务 ' + t.id + ' 状态', onClick: () => updateTaskStatus(t), disabled: taskRecordBusy || !openTitle }, '更新'))))))
                : h('div', { className: 'ad-hint-next' }, '还没有生成任务。'),
              genTasks.length > 30
                ? h('div', { className: 'ad-hint-next', key: 'task-truncated', role: 'status', 'aria-live': 'polite' }, '已截断：仅显示前 30 条生成任务（共 ' + genTasks.length + ' 条）。')
                : null,

              h('div', { className: 'ad-sec' }, `④ 批次（当前集 第 ${episodeOrder} 集）`),
              h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 8, marginBottom: 8 } },
                h('select', { className: 'ad-input ad-sm', value: genKind, onChange: (e) => setGenKind(e.target.value) },
                  h('option', { value: 'image' }, '分镜图'),
                  h('option', { value: 'video' }, '分镜视频'),
                  h('option', { value: 'audio' }, '配音')),
                h('input', { className: 'ad-input ad-sm', style: { width: 200 }, 'aria-label': '分镜生成模型名（可留空）', placeholder: '模型名（可留空）', value: genModel, onChange: (e) => setGenModel(e.target.value) }),
                h('button', { className: 'ad-btn ad-sm', onClick: planBatch, disabled: busy }, '规划（不触发）'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: submitBatch, disabled: busy || !genPlan }, '提交'),
                h('button', { className: 'ad-btn ad-sm', onClick: collectBatch, disabled: busy }, '收敛取产物')),
              genPlan
                ? h('div', null,
                    h('div', { className: 'ad-count', style: { marginBottom: 6 } },
                      `已规划 ${genPlan.count} 项 · 预估 ${genPlan.estimatePoints || 0} 积分 · 预算闸门 ${genPlan.quota.ok ? '通过' : '拦截'}`),
                    genPlan.quota.detail ? h('div', { className: 'ad-hint-next' }, genPlan.quota.detail) : null,
                    h('div', { className: 'ad-hits', style: { maxHeight: 200, overflow: 'auto' } },
                      genPlan.items.map((it) =>
                        h('div', { className: 'ad-hit', key: it.shotNumber },
                          h('div', { className: 'ad-hit-path' }, `${it.name} · ${it.params.ratio}`),
                          h('div', null, it.prompt)))))
                : null,

              h('div', { className: 'ad-sec' }, '⑤ 检索参考（本地检索，不调用模型）'),
              h('div', { className: 'ad-hint-next', key: 'hint-search' }, '在项目文件里搜索关键词作参考（本地检索，不调用模型）'),
              h('div', { className: 'ad-row', style: { marginBottom: 8, flexWrap: 'wrap', gap: 8 } },
                h('input', {
                  className: 'ad-input ad-sm',
                  style: { width: 320 },
                  'aria-label': '项目上下文检索关键词',
                  placeholder: '检索关键词，例如：当铺 伏笔 林越',
                  value: genSearchQuery,
                  onChange: (e) => setGenSearchQuery(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') searchProjectContext() },
                  disabled: genSearchBusy,
                }),
                h('input', {
                  className: 'ad-input ad-sm',
                  style: { width: 70 },
                  type: 'number',
                  'aria-label': '检索条数',
                  value: genSearchTopK,
                  onChange: (e) => setGenSearchTopK(e.target.value),
                }),
                h('button', { className: 'ad-btn ad-sm', onClick: searchProjectContext, disabled: genSearchBusy || busy }, genSearchBusy ? '检索中…' : '检索'),
                genSearchResult && genSearchResult.degraded ? h('span', { className: 'ad-count' }, '降级：' + String(genSearchResult.degradeReason || '未知')) : null),
              genSearchResult
                ? (genSearchResult.error
                    ? h('div', { className: 'ad-hint-next' }, '检索失败：' + genSearchResult.error + '（不阻塞；可重试）')
                    : genSearchResult.emptyQuery
                      ? h('div', { className: 'ad-hint-next' }, '输入关键词后点「检索」')
                      : (genSearchResult.hits && genSearchResult.hits.length
                          ? h('div', { className: 'ad-hits', role: 'status', style: { maxHeight: 200, overflow: 'auto' } },
                              genSearchResult.hits.slice(0, 10).map((hit, i) =>
                                h('div', { className: 'ad-hit', key: i },
                                  h('div', { className: 'ad-hit-path' }, String(hit.path || '—') + (hit.score != null ? ' · score ' + hit.score : '')),
                                  h('div', null, String(hit.excerpt || hit.text || '')))))
                          : h('div', { className: 'ad-hint-next' }, genSearchResult.enabled === false ? '检索增强已在设置页关闭（enabled=false）' : '无检索结果（可换关键词；本地检索不调用模型）')))
                : null,
              warn ? h('div', { className: 'ad-warn' }, '⚠ ' + warn) : null,
              snapshot && snapshot.ok
                ? h('div', { className: 'ad-path' }, `画布节点指纹：${snapshot.count} 个（${String(snapshot.at).slice(0, 19)}）`)
                : null),
          )
        }

        if (tab === 'check') {
          // P2-3：审读报告展示数据（severity 分组 + 定位/证据/建议/置信度 + 本地裁决状态）
          // v0.6.3：维度筛选 / 排序 / 总数摘要（severity & dimension 计数）/ evidence 高亮
          const reviewFindings = reviewFindingsMemo
          const reviewFilterKey = reviewDimensionFilter || ''
          const reviewFiltered = reviewFilteredMemo
          const reviewSorted = reviewSortedMemo
          const reviewGroups = reviewGroupsMemo
          const reviewDimensionOptions = reviewDimensionOptionsMemo
          const reviewSeverityCounts = reviewSeverityCountsMemo
          const reviewSummaryText = reviewFindings.length
            ? `审读摘要：共 ${reviewFindings.length} 条 · ${REVIEW_SEVERITY_ORDER.map((sevKey) => `${reviewSeverity(sevKey).label} ${reviewSeverityCounts[sevKey] || 0}`).join(' · ')}` +
              (reviewDimensionOptions.length ? ` · 维度：${reviewDimensionOptions.map((option) => `${option.label} ${option.count}`).join('、')}` : '')
            : ''
          const reviewTone = (sev) =>
            ['critical', 'error', 'high'].includes(sev) ? 'error' : ['warn', 'warning', 'medium'].includes(sev) ? 'warn' : 'info'
          const reviewVerdictText = (id) => {
            const verdict = reviewFeedback[id]
            return verdict === 'accepted' ? '已采纳' : verdict === 'ignored' ? '已忽略' : verdict === 'false-positive' ? '已标误报' : ''
          }
          // Q7 单集：最新报告属于其他集时按空态处理（说明本集暂无审读）
          const reviewEpisodeMismatch = Boolean(
            reviewReport && reviewReport.episode != null && Number(episodeOrder) &&
            Number(reviewReport.episode) !== Number(episodeOrder),
          )
          body.push(
            h('div', { key: 'ck' },
              h('div', { className: 'ad-hint-next', key: 'hint-reconcile' }, '核对分镜表与 LibTV 画布镜头是否一致（只读）'),
              h('div', { className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap' } },
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: runCheck, disabled: busy }, '运行一致性检查'),
                h('button', { className: 'ad-btn ad-sm', onClick: reconcileCanvas, disabled: reconcileBusy || busy }, reconcileBusy ? '对账中…' : '画布对账（只读）'),
                h('span', { className: 'ad-sub' }, '契约完整性 / 集数一致性 / 说话人 / 分镜时长 / 镜号 / 缺口 / 重复桥段')),
              reconcileResult
                ? h('div', { className: 'ad-hits', style: { marginBottom: 8 }, role: 'status' },
                    h('div', { className: 'ad-hit', key: 'rc' },
                      h('div', { className: 'ad-hit-path' }, reconcileResult.ok ? '画布对账：' + (reconcileResult.consistent ? '一致 ✓' : '存在差异（只报告，不自动改画布）') : '画布对账不可用：' + String(reconcileResult.reason || 'unknown')),
                      h('div', null, reconcileResult.ok
                        ? '分镜镜头 ' + (reconcileResult.storyboardShots == null ? 0 : reconcileResult.storyboardShots) + ' / 画布镜头 ' + (reconcileResult.canvasShots == null ? 0 : reconcileResult.canvasShots) + '（画布节点 ' + (reconcileResult.totalNodes == null ? 0 : reconcileResult.totalNodes) + '）；缺失 ' + ((reconcileResult.missingOnCanvas || []).length) + '、多余 ' + ((reconcileResult.extraOnCanvas || []).length)
                        : String(reconcileResult.detail || '读不到画布节点') + '（先绑定画布 / 确认 LibTV CLI 可用；不阻塞其它检查）'),
                      reconcileResult.ok && (reconcileResult.suggestions || []).length
                        ? h('div', { className: 'ad-hint-next' }, '建议：' + reconcileResult.suggestions.join('；'))
                        : null))
                : null,
              report
                ? h('div', { key: 'rp' },
                    h('div', { className: 'ad-row', style: { marginBottom: 8 } },
                      h('span', { className: 'ad-count' }, `error ${report.summary.error}`),
                      h('span', { className: 'ad-count' }, `warn ${report.summary.warn}`),
                      h('span', { className: 'ad-count' }, `info ${report.summary.info}`),
                      h('span', { className: 'ad-count' }, `共 ${report.summary.total} 项 · ${report.checkedAt}`)),
                    report.issues.length
                      ? h('div', { className: 'ad-hits' },
                          report.issues.map((issue, i) =>
                            h('div', { className: 'ad-hit', key: i },
                              h('div', { className: 'ad-hit-path' }, `${issue.severity} · ${issue.code}${issue.where ? ' · ' + issue.where : ''}`),
                              h('div', null, issue.message))))
                      : h('div', { className: 'ad-hint-next' }, '未发现问题。'))
                : emptyState({ key: 'check-empty', title: '还没有一致性检查结果', description: '点上方「运行一致性检查」看契约完整性 / 集数一致性 / 说话人 / 分镜时长 / 镜号 / 缺口 / 重复桥段。', next: '点「运行一致性检查」开始', actions: [{ label: '运行一致性检查', onClick: runCheck, disabled: busy }] }),

              h('div', { className: 'ad-sec', key: 'rv-sec' }, '最新审读报告（AI 深度审读 · 面板只展示，触发由 Agent 完成）'),
              h('div', { className: 'ad-row', key: 'rv-bar', style: { marginBottom: 8, flexWrap: 'wrap' } },
                h('button', { className: 'ad-btn ad-sm', onClick: () => loadReview({ notice: true }), disabled: busy || reviewBusy }, icon('refresh'), reviewBusy ? '读取中…' : '刷新审读报告'),
                reviewEpisode ? h('span', { className: 'ad-count' }, `第 ${reviewEpisode} 集`) : null,
                reviewReport && reviewReport.generatedAt ? h('span', { className: 'ad-count' }, `生成：${reviewReport.generatedAt}`) : null,
                reviewReport && reviewReport.meta && reviewReport.meta.model ? h('span', { className: 'ad-count' }, `模型：${reviewReport.meta.model}`) : null,
                reviewReport && reviewReport.meta && reviewReport.meta.tokens != null
                  ? h('span', { className: 'ad-count' }, `tokens ${
                      typeof reviewReport.meta.tokens === 'object'
                        ? Number(reviewReport.meta.tokens.total || (Number(reviewReport.meta.tokens.input) || 0) + (Number(reviewReport.meta.tokens.output) || 0)) || 0
                        : Number(reviewReport.meta.tokens) || 0
                    }`)
                  : null,
                reviewJump ? h('button', { className: 'ad-btn ad-sm', onClick: () => setReviewJump(null) }, '清除定位') : null),
              // v0.6.3：审读展示细化 —— 维度筛选 / 排序 / 总数摘要 / 快捷键说明
              reviewReport && reviewFindings.length
                ? h('div', { key: 'rv-tools', style: { marginBottom: 8 } },
                    h('div', { className: 'ad-row', style: { marginBottom: 6, flexWrap: 'wrap' } },
                      h('label', { className: 'ad-sub' }, '维度筛选'),
                      h('select', {
                        className: 'ad-select',
                        'aria-label': '审读维度筛选',
                        value: reviewFilterKey,
                        onChange: (e) => setReviewDimensionFilter(e.target.value),
                        style: { maxWidth: 260 },
                      },
                        h('option', { value: '' }, `全部维度（${reviewFindings.length}）`),
                        reviewDimensionOptions.map((option) => h('option', { key: option.key, value: option.key }, `${option.label}（${option.count}）`))),
                      h('label', { className: 'ad-sub', style: { marginLeft: 8 } }, '排序'),
                      h('select', {
                        className: 'ad-select',
                        'aria-label': '审读排序',
                        value: reviewSort,
                        onChange: (e) => setReviewSort(e.target.value),
                        style: { maxWidth: 200 },
                      },
                        REVIEW_SORT_OPTIONS.map(([value, label]) => h('option', { key: value, value }, label))),
                      reviewFilterKey ? h('button', { className: 'ad-btn ad-sm', onClick: () => setReviewDimensionFilter('') }, '清除筛选') : null),
                    h('div', { className: 'ad-sub', role: 'status' }, reviewSummaryText),
                    h('div', { className: 'ad-hint-next' }, '快捷键：Ctrl/⌘+S 保存当前页签或文档栏；Enter 执行搜索；点「跳转定位」可跳到对应集/场/镜'))
                : null,
              // P2-6 增强（v0.6.2）：标注本次审读实际使用的模型来源 / 是否回退（消费报告 meta.modelSource 等字段）
              reviewReport && (reviewReport.modelSource || (reviewReport.meta && reviewReport.meta.model) || reviewReport.modelFallback)
                ? h('div', {
                    className: 'ad-flow-hint',
                    key: 'rv-usage',
                    'data-model-source': reviewReport.modelSource || '',
                    role: 'note',
                  }, reviewModelUsageText(reviewReport))
                : null,
              // v0.9.2（P3-E）：成本档位标注 + 回退提示（host task-65 只增字段）
              reviewReport && (reviewReport.costTier || reviewReport.costTierRequested || reviewReport.costTierFallback)
                ? h('div', { className: 'ad-flow-hint', key: 'rv-cost-tier', 'data-cost-tier': reviewReport.costTier || '', role: 'note' },
                    `成本档位：${reviewReport.costTier ? costTierLabel(reviewReport.costTier) : '未指定'}` +
                    (reviewReport.costTierFallback
                      ? `（请求 ${reviewReport.costTierRequested || '—'} 不可用，已回退默认${reviewReport.costTierFallbackReason ? '：' + reviewReport.costTierFallbackReason : ''}）`
                      : ''))
                : null,
              reviewReport && reviewReport.degraded
                ? h('div', { className: 'ad-flow-stale', key: 'rv-degraded' }, `已降级：${reviewReport.degradedReason || '模型不可用 / 超预算，仅返回确定性检查结果'}（默认不阻断定稿与导出）`)
                : null,
              reviewError ? h('div', { className: 'ad-doc-note', key: 'rv-err' }, reviewError) : null,
              reviewReport && !reviewEpisodeMismatch
                ? (reviewFindings.length
                    ? (reviewSorted.length
                        ? h('div', { key: 'rv-list' },
                            reviewReport.summaryText ? h('div', { className: 'ad-sub', style: { marginBottom: 8 } }, reviewReport.summaryText) : null,
                            reviewSort === 'severity'
                              ? reviewGroups.map((group) => h('div', { key: 'rv-g-' + group.sev },
                                  h('div', { className: 'ad-sec' }, `${reviewSeverity(group.sev).label}（${group.items.length}）`),
                                  group.items.map((finding) => renderReviewFinding(finding))))
                              : reviewSorted.map((finding) => renderReviewFinding(finding)))
                        : emptyState({
                            key: 'rv-filtered',
                            title: '当前筛选下没有问题',
                            description: `共 ${reviewFindings.length} 条审读问题，当前维度筛选无匹配。`,
                            next: '清除筛选查看全部问题',
                            actions: [{ label: '清除筛选', onClick: () => setReviewDimensionFilter('') }],
                          }))
                    : emptyState({
                        key: 'rv-clean',
                        title: '本期未发现需要处理的问题',
                        description: reviewReport.summaryText || '审读已完成，未返回可操作问题。',
                        next: '可继续创作；如需复查点「刷新审读报告」',
                      }))
                : emptyState({
                    key: 'rv-empty',
                    title: reviewEpisodeMismatch ? '本集暂无审读报告' : '还没有审读报告',
                    description: reviewEpisodeMismatch
                      ? `最新报告是第 ${reviewReport.episode} 集；当前查看第 ${episodeOrder} 集，可让 Agent 审读本集。`
                      : '审读由 Agent 在短剧模式下生成（drama_check_consistency deep:true），面板只读展示、不主动调用工具。',
                    next: '对 Agent 说「审读第 N 集」，完成后点「刷新审读报告」',
                  }),

              h('div', { className: 'ad-sec', key: 'exs' }, '导出交付物'),
              h('div', { className: 'ad-row', key: 'exb' },
                h('button', { className: 'ad-btn ad-sm', onClick: () => runExport('markdown'), disabled: busy }, 'Markdown 全本'),
                h('button', { className: 'ad-btn ad-sm', onClick: () => runExport('json'), disabled: busy }, 'JSON 结构化包'),
                h('button', { className: 'ad-btn ad-sm', onClick: () => runExport('csv'), disabled: busy }, 'CSV 分镜表'),
                h('button', { className: 'ad-btn ad-sm', onClick: exportVoiceScript, disabled: busy }, '导出配音稿')),
              h('div', { className: 'ad-path', key: 'exn' },
                'CSV 分镜表含镜号 / 景别 / 运镜 / 画面 / 台词 / 音效 / 时长（宿主 v0.4.0+ 追加「视频提示词」列）。'),
              exported.length
                ? h('div', { className: 'ad-path', key: 'exl' },
                    exported.map((item) => h('div', { key: item.format }, `${item.format} · ${item.relative} · ${item.bytes} 字节`)))
                : null,
              h('div', { className: 'ad-sec', key: 'intake-art' }, '产物入库（选择本地文件导入 / 项目内路径 / URL 均可登记，不触发生成）'),
              h('div', { className: 'ad-hint-next', key: 'hint-intake' }, '选择本地文件导入素材库（≤50MB，不移动源文件；本地导入不关联生成任务，如需关联请先把文件放入项目「素材/生成/」再传项目内路径）；或粘贴项目内路径 / http(s) 直链登记（记录 sha256）。'),
              importSupported === true
                ? h('input', {
                    id: 'ad-artifact-file-input',
                    'data-artifact-input': 'true',
                    type: 'file',
                    accept: IMPORT_ACCEPT,
                    style: { display: 'none' },
                    onChange: pickArtifactFileChange,
                  })
                : null,
              h('div', { className: 'ad-row', key: 'intake-bar', style: { flexWrap: 'wrap', gap: 8, marginBottom: 6, alignItems: 'center' } },
                importSupported === true
                  ? h('button', { type: 'button', className: 'ad-btn ad-sm', onClick: pickArtifactFile, disabled: artifactBusy || Boolean(artifactFile) }, artifactFile ? '已选本地文件' : '选择本地文件…')
                  : null,
                artifactFile
                  ? h('span', { className: 'ad-artifact-file', key: 'artifact-file-chip' },
                      h('span', { className: 'ad-artifact-file-name', title: artifactFileName }, artifactFileName),
                      h('span', { className: 'ad-artifact-file-size' }, formatAssetBytes(artifactFileSize)),
                      h('button', { type: 'button', className: 'ad-btn ad-sm', 'aria-label': '移除已选本地文件', onClick: clearArtifactFile, disabled: artifactBusy }, '移除'))
                  : null,
                h('input', {
                  className: 'ad-input ad-sm',
                  style: { width: 360 },
                  'aria-label': artifactFile ? '产物来源（已选择本地文件，输入框不可用）' : '产物来源（项目内路径或 URL）',
                  placeholder: artifactFile ? '已选择本地文件；如需使用项目内路径/URL，请先移除文件' : '项目内路径（如 素材/生成/xxx.png）或 https://…（生成产物直链）',
                  value: artifactSource,
                  onChange: (e) => { if (!artifactFile) setArtifactSource(e.target.value) },
                  onKeyDown: (e) => { if (e.key === 'Enter' && !artifactFile) intakeGeneratedArtifact() },
                  disabled: artifactBusy || Boolean(artifactFile),
                }),
                artifactFile
                  ? null
                  : h('select', { className: 'ad-select', 'aria-label': '产物类型', value: artifactKind, onChange: (e) => setArtifactKind(e.target.value), disabled: artifactBusy },
                      h('option', { value: 'image' }, '分镜图'), h('option', { value: 'video' }, '分镜视频'), h('option', { value: 'audio' }, '配音')),
                h('input', { className: 'ad-input ad-sm', style: { width: 160 }, 'aria-label': '产物名称（可选）', placeholder: '名称（可选）', value: artifactName, onChange: (e) => setArtifactName(e.target.value), disabled: artifactBusy }),
                h('button', {
                  className: 'ad-btn ad-sm',
                  onClick: intakeGeneratedArtifact,
                  disabled: artifactBusy || busy || !openTitle || (artifactMode === 'file' ? !artifactFile : !artifactSource.trim()),
                }, artifactBusy ? (artifactMode === 'file' ? '导入中…' : '入库中…') : (artifactMode === 'file' ? '导入素材' : '登记入库'))),
              artifactMode === 'file'
                ? h('div', { className: 'ad-row ad-artifact-category', key: 'artifact-category', style: { flexWrap: 'wrap', gap: 8, marginBottom: 6, alignItems: 'center' } },
                    h('span', { className: 'ad-sub' }, `导入分类（写入项目「素材/<分类>/」，默认「${ARTIFACT_CATEGORY_DEFAULT}」）`),
                    h('select', { className: 'ad-select', 'aria-label': '产物导入分类', value: artifactCategory, onChange: (e) => setArtifactCategory(e.target.value), disabled: artifactBusy },
                      ARTIFACT_CATEGORIES.map((category) => h('option', { key: category, value: category }, category === ARTIFACT_CATEGORY_DEFAULT ? `生成（素材/生成/）` : category))))
                : null,
              artifactResult
                ? (artifactResult.ok === false || artifactResult.error
                    ? h('div', { className: 'ad-hint-next', key: 'intake-err', role: 'status' }, (artifactResult.fixed ? '' : '入库失败：') + String(artifactResult.error || artifactResult.reason || '未知错误') + (artifactResult.fixed ? '' : '（不阻塞；可检查路径/URL 后重试）'))
                    : h('div', { className: 'ad-hits', key: 'intake-ok', role: 'status' },
                        h('div', { className: 'ad-hit' },
                          h('div', { className: 'ad-hit-path' }, '已入库：' + String(artifactResult.relative || artifactResult.name || '')),
                          h('div', null, (artifactResult.bytes == null ? '' : String(artifactResult.bytes) + ' 字节 · ') + 'sha256 ' + String(artifactResult.sha256 || '').slice(0, 16) + '… · 资产 ' + String(artifactResult.assetId || '—') + '（可在「素材库」查看）')),
                          artifactResult.fallbackCategory
                            ? h('div', { className: 'ad-hint-next', key: 'artifact-category-fallback' }, '当前插件未支持「生成」分类，已导入默认分类（可在素材库查看）')
                            : null))
                : null,
              h('div', { className: 'ad-path', key: 'intake-note' },
                '本地文件经「素材库导入」复制入项目（单文件 ≤50MB，不移动源文件，不关联生成任务）；项目内路径/URL 经产物入库（URL 仅 http(s) 直链、≤64MB、禁内网/重定向最多 5 次）写入 素材/生成/ 并保持任务关联；不触发生成、不调用模型。'),
            ),
          )
        }

        if (tab === 'toolcards') {
          const { draftPending, receipts, episodeSceneCount, episodeLineCount, episodeCharCount } = toolcardsDerived
          body.push(
            h('div', { key: 'tc' },
              h('div', { className: 'ad-sec' }, '结构化卡片（当前项目实时数据 · 对齐 drama_* 工具形态）'),
              h('div', { className: 'ad-toolcards' },
                listCard({
                  key: 'a-list',
                  title: 'A · 项目列表卡（drama_list_projects）',
                  rows: projects.slice(0, 8).map((project) => `${project.title} · ${project.episodeCount || 0} 集`),
                  empty: '还没有短剧项目；回到列表页新建。',
                }),
                toolCard({
                  key: 'a-detail',
                  title: 'A · 项目上下文卡（drama_get_project）',
                  badge: openTitle,
                  fields: [
                    ['剧集契约', contract ? `${contract.platform || '—'} / ${contract.targetEpisodes || 0} 集` : '—'],
                    ['分集大纲', `${rows.length} 行`],
                    ['人物', `${characters.length} 人`],
                    ['分集剧本', `${episodes.length} 集`],
                    ['待处理草稿', `${draftPending} 条`],
                  ],
                }),
                receiptCard({ key: 'b-receipt', title: 'B · 保存回执卡（4/5/6/13/14）', fields: receipts }),
                toolCard({
                  key: 'c-episode',
                  title: 'C · 正文卡（drama_read_episode）',
                  badge: `第 ${episodeOrder} 集`,
                  fields: [['场次数', episodeSceneCount], ['行数', episodeLineCount], ['字数', episodeCharCount]],
                  children: episodeText.trim()
                    ? h('div', { className: 'ad-scene-line' }, episodeText.slice(0, 300) + (episodeText.length > 300 ? '…' : ''))
                    : null,
                  note: '完整正文在「剧本」页签编辑；超过 1200 字符按折叠阅读。',
                }),
                listCard({
                  key: 'c-drafts',
                  title: 'C · 草稿列表卡（drama_list_drafts）',
                  rows: draftList.slice(0, 8).map((draft) =>
                    `${draft.status === 'pending' ? '●' : '○'} [${draft.kind}] ${draft.title || draft.path || draft.id} · ${draft.status}`),
                  empty: '草稿区为空；AI 生成物会先落到这里等待采纳。',
                }),
                issueCard({
                  key: 'd-check',
                  title: 'D · 问题卡（drama_check_consistency）',
                  issues: report ? report.issues || [] : [],
                  subtitle: report ? `检查时间 ${report.checkedAt || '—'} · 共 ${report.summary ? report.summary.total : 0} 项` : '尚未运行检查；到「检查 / 导出」页签运行。',
                  note: '问题按 error / warn / info 分组显示。',
                }),
                listCard({
                  key: 'e-finalized',
                  title: 'E · 版本卡（drama_list_finalized）',
                  rows: finalized.slice(0, 8).map((record) =>
                    `第 ${record.order} 集 · 最新 v${record.version} · ${String(record.finalizedAt || '').replace('T', ' ').slice(0, 19)} · ${record.shots} 镜`),
                  empty: '还没有定稿版本；剧本满意后到「剧本」页签定稿。',
                  note: '回滚入口在「剧本 → 定稿与回滚」表内（面板动作，不新增工具）。',
                }),
                toolCard({
                  key: 'e-ledger',
                  title: 'E · 统计卡（drama_get_ledger）',
                  badge: ledger ? `已生成` : '未生成',
                  fields: ledger
                    ? [
                        ['集数 / 场景', `${ledger.totals.episodes} / ${ledger.totals.scenes}`],
                        ['镜头 / 时长', `${ledger.totals.shots} / ${ledger.totals.durationSec}s`],
                        ['角色 / 地点', `${ledger.totals.characters.length} / ${ledger.totals.locations.length}`],
                        ['成本提示', `${ledger.warnings.length} 条`],
                      ]
                    : [['提示', '到「账本」页签生成']],
                }),
                listCard({
                  key: 'f-export',
                  title: 'F · 交付卡（drama_export）',
                  rows: (exported || []).slice(0, 8).map((item) => `${item.format} · ${item.relative} · ${item.bytes} 字节`),
                  empty: '还没有导出产物；到「检查 / 导出」页签导出。',
                  note: 'CSV 分镜表含镜号/景别/运镜/画面/台词/音效/时长；宿主 v0.4.0+ 追加视频提示词列。',
                }),
                toolCard({
                  key: 'g-budget',
                  title: 'G · 预算卡（drama_budget）',
                  badge: genTasks.length ? `${genTasks.length} 任务` : '未刷新',
                  fields: [
                    ['上限', genBudget ? (genBudget.limitPoints == null ? '未设' : genBudget.limitPoints) : '—'],
                    ['已消耗', genBudget ? genBudget.spentPoints : '—'],
                    ['剩余', genBudget ? (genBudget.remainingPoints == null ? '—' : genBudget.remainingPoints) : '—'],
                    ['任务数', genTasks.length],
                  ],
                  note: '到「生成」页签刷新状态后填充。',
                }),
                toolCard({
                  key: 'h-canvas',
                  title: 'H · 画布状态卡（drama_canvas_status）',
                  badge: genCanvas && genCanvas.binding && genCanvas.binding.ok ? '已绑定' : '未绑定',
                  fields: [
                    ['后端', (genCanvas && genCanvas.backend) || 'libtv'],
                    ['候选画布', genBackends ? genBackends.length : 0],
                    ['上游警告', (genCanvas && genCanvas.upstreamWarning) || '—'],
                  ],
                  note: '生成前先关闭该画布的网页端（双主防护）。',
                }),
                failureCodesCard(),
              ),
              h('div', { className: 'ad-sec' }, `34 工具 → A–H 卡片分组覆盖（${TOOL_GROUPS.reduce((sum, group) => sum + group.tools.length, 0)} 个工具）`),
              h('div', { className: 'ad-toolcards' },
                TOOL_GROUPS.map((group) =>
                  toolCard({
                    key: 'group-' + group.id,
                    title: `${group.id} · ${group.label}`,
                    badge: `${group.tools.length} 工具`,
                    subtitle: `复用渲染器：${group.renderer}`,
                    children: h('div', null, group.tools.map(([name, title]) =>
                      h('div', { className: 'ad-kv-row', key: name },
                        h('span', { className: 'ad-kv-key' }, name),
                        h('span', null, title)))),
                  }))),
            ),
          )
        }

        if (tab === 'tree' && tree) {
          body.push(
            h('div', { key: 'tr' },
              h('div', { className: 'ad-row', style: { marginBottom: 10 } },
                h('span', { className: 'ad-sec', style: { margin: 0 } }, `${tree.title} · 目录`),
                h('div', { style: { flex: 1 } }),
                h('button', { className: 'ad-btn ad-sm', onClick: refreshTree, disabled: busy }, icon('refresh'), '刷新')),
              tree.nodes.map((node) => {
                const isOpen = !collapsed[node.name]
                const kids = node.children || []
                const required = REQUIRED_ROOTS.includes(node.name)
                return h('div', { key: node.name },
                  h('div', { className: 'ad-node' },
                    node.kind === 'dir' && kids.length
                      ? h('button', { className: 'ad-btn ad-sm', style: { padding: '0 6px' }, 'aria-label': (isOpen ? '折叠 ' : '展开 ') + node.name, onClick: () => toggleCollapse(node.name) }, isOpen ? '▾' : '▸')
                      : h('span', { style: { width: 26 } }),
                    h('span', null, node.kind === 'dir' ? '📁' : '📄'),
                    h('span', null, node.name),
                    node.kind === 'dir' && node.count ? h('span', { className: 'ad-count' }, `${node.count} 项`) : null,
                    required ? h('span', { className: 'ad-count' }, '必需节点') : null,
                    h('div', { className: 'ad-node-ops' },
                      node.kind === 'dir'
                        ? h('button', { className: 'ad-btn ad-sm', onClick: () => createEntry(node.name), disabled: busy, title: '在此目录下新建文件（支持子路径）' }, '＋文件')
                        : null,
                      node.kind === 'dir'
                        ? h('button', { className: 'ad-btn ad-sm', onClick: () => createEntryDir(node.name), disabled: busy, title: '在此目录下新建子目录' }, '＋目录')
                        : null,
                      node.name !== '剧集契约.md'
                        ? h('button', { className: 'ad-btn ad-sm', onClick: () => renameEntry(node.name), disabled: busy, title: '重命名一级节点' }, icon('pencil'), '重命名')
                        : null,
                      !required
                        ? h('button', { type: 'button', className: 'ad-btn ad-sm ad-btn-danger ad-icon-btn ad-icon-btn-sm', 'data-tone': 'danger', 'aria-label': '删除一级节点', title: '删除一级节点', onClick: () => deleteEntry(node.name), disabled: busy }, icon('trash'))
                        : null)),
                  node.kind === 'dir' && isOpen && kids.length
                    ? h('div', { style: { marginLeft: 46 } },
                        kids.map((kid) => h('div', { className: 'ad-node', key: kid.name },
                          h('span', null, kid.kind === 'dir' ? '📁' : '·'),
                          h('span', { className: 'ad-count' }, kid.name))))
                    : null)
              }),
              h('div', { className: 'ad-path' },
                tree.path,
                h('br'),
                '折叠状态按项目记忆在浏览器本地（FR-A04）。P1 支持：目录内新建文件/子目录、一级节点改名与删除（必需节点已保护）；二级条目的改名/删除列 P2。')),
          )
        }

        // v0.12.0（task-7）：页签内容统一 tabpanel（aria 最小集：tab aria-controls 指向它）
        const tabPanelStart = body.indexOf(tabsNode) + 1
        const tabPanelChildren = body.slice(tabPanelStart)
        if (tabPanelStart > 0 && tabPanelChildren.length) {
          body.splice(tabPanelStart, tabPanelChildren.length,
            h('div', { className: 'ad-tabpanel', key: 'tabpanel', role: 'tabpanel', id: 'ad-tabpanel', 'aria-labelledby': 'ad-tab-' + tab }, tabPanelChildren))
        }
      }

      // T7（E1）：面板内右栏文档编辑器（不新增 slot；不接管原生 documentpreview）
      const docPane = phase === 'project' && docOpen
        ? h('aside', { className: 'ad-doc', key: 'doc', 'aria-label': '文档编辑器（T7）' },
            h('div', { className: 'ad-doc-head' },
              h('div', { className: 'ad-doc-title' },
                h('span', null, '文档编辑器'),
                h('span', { className: 'ad-count' }, 'T7 / E1'),
                h('div', { style: { flex: 1 } }),
                h('button', { className: 'ad-btn ad-sm', onClick: () => loadDoc(docPath), disabled: busy || docBusy, title: '重新读取磁盘版本' }, '重新载入'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: () => saveDoc(), disabled: busy || docBusy || docUnavailable || !docPath, title: '保存并通知主控（Ctrl/⌘+S）' }, '保存'),
                h('button', { className: 'ad-btn ad-sm', onClick: () => setDocOpen(false), 'aria-label': '收起文档编辑器' }, '收起')),
              h('select', {
                className: 'ad-select',
                value: docPath || '',
                'aria-label': '选择要编辑的文档',
                onChange: (e) => pickDoc(e.target.value),
                disabled: busy || docBusy,
              },
              docPath ? null : h('option', { value: '' }, '选择文档…'),
              docCandidates().map((candidate) => h('option', { key: candidate, value: candidate }, candidate))),
              h('div', { className: 'ad-doc-meta' },
                docPath ? `路径：${docPath}` : '尚未选择文档',
                docHash ? ` · hash ${docHash.slice(0, 8)}` : '',
                docUpdatedAt ? ` · 更新于 ${String(docUpdatedAt).replace('T', ' ').slice(0, 19)}` : '',
                docDirty ? ' · ● 未保存' : '',
                docNotifyState === 'ok' ? ' · 已通知主控' : docNotifyState === 'skip' ? ' · 主控通知已跳过（接口未就绪）' : docNotifyState === 'fail' ? ' · 主控通知失败' : '',
                docBusy ? ' · 处理中…' : '')),
            docConflict
              ? h('div', { className: 'ad-doc-conflict' },
                  h('div', null, `磁盘版本已变化：期望 hash ${docHash ? docHash.slice(0, 8) : '—'} / 当前 hash ${(docConflict.currentHash || '').slice(0, 8) || '—'}`),
                  h('div', { className: 'ad-row', style: { marginTop: 6 } },
                    h('button', { className: 'ad-btn ad-sm', onClick: () => loadDoc(docPath), disabled: docBusy }, '重新载入最新'),
                    h('button', { className: 'ad-btn ad-sm', onClick: () => saveDoc(docConflict.currentHash), disabled: docBusy }, '保留本地重试')))
              : null,
            docError ? h('div', { className: 'ad-doc-err' }, docError) : null,
            docUnavailable
              ? h('div', { className: 'ad-doc-note' }, '当前宿主版本尚未含 E1 接口（task-13）：编辑器只读/禁用；doc-notify 未就绪时保存不阻断。')
              : null,
            h('textarea', {
              className: 'ad-doc-area',
              value: docText,
              placeholder: docUnavailable ? '（E1 接口未就绪，无法载入文档）' : '选择或载入文档后在此逐字编辑…',
              onChange: (e) => {
                setDocText(e.target.value)
                setDocDirty(true)
              },
              onKeyDown: (e) => {
                if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                  e.preventDefault()
                  if (!docBusy && !docUnavailable) saveDoc()
                }
              },
              onSelect: (e) => {
                const target = e.target
                const start = target.selectionStart || 0
                const end = target.selectionEnd || 0
                setDocSelection(end > start ? `已选 ${end - start} 字` : '')
              },
              readOnly: docUnavailable,
              'aria-label': '文档正文（逐字编辑并保存）',
            }),
            h('div', { className: 'ad-doc-foot' },
              h('div', { className: 'ad-row' },
                h('span', { className: 'ad-sub' }, docSelection || 'Ctrl/⌘+S 保存；保存成功后自动通知主控'),
                h('div', { style: { flex: 1 } }),
                h('button', { className: 'ad-btn ad-sm', disabled: true, title: 'suggestions 接口 P2 后置（E4 未登记），P1 不启用' }, '选区改写'),
                h('button', { className: 'ad-btn ad-sm', disabled: true, title: 'suggestions 接口 P2 后置（E4 未登记），P1 不启用' }, '续写'),
                h('button', { className: 'ad-btn ad-sm', disabled: true, title: 'suggestions 接口 P2 后置（E4 未登记），P1 不启用' }, '审读')),
              docNotice ? h('div', { className: 'ad-ok' }, docNotice) : null))
        : null

      children.push(
        h('div', { className: 'ad-shell-row', key: 'row' },
          h('div', { className: 'ad-main-col', key: 'main' },
            h('div', { className: 'ad-body', key: 'body' }, h('div', { className: 'ad-content' }, body))),
          docPane,
        ),
      )

      // v0.11.5（task-4 · P0-1）：未保存离开守卫三选一（面板内自绘，不用原生 confirm；完整 ConfirmDialog 组件留 v0.12.x）
      if (leavePrompt) {
        const scopeText = unsavedScopeLabels().join('、') || '当前内容'
        children.push(h('div', {
          className: 'ad-modal-backdrop',
          key: 'leave-guard',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !leaveSaving) setLeavePrompt(null)
          },
        },
          h('div', {
            className: 'ad-modal',
            id: 'ad-leave-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '有未保存的修改',
            'aria-describedby': 'ad-leave-desc',
            'aria-keyshortcuts': 'Escape',
          },
            h('div', { className: 'ad-modal-title' }, '有未保存的修改'),
            h('div', { className: 'ad-modal-desc', id: 'ad-leave-desc' },
              '检测到未保存的修改：',
              h('strong', null, scopeText),
              '。离开当前页面会丢失这些内容，请选择：'),
            h('div', { className: 'ad-modal-actions' },
              h('button', { className: 'ad-btn ad-sm', onClick: cancelLeave, disabled: leaveSaving, autoFocus: true, title: '留在当前页面（Esc）' }, '取消'),
              h('button', { className: 'ad-btn ad-sm', onClick: confirmLeaveDiscard, disabled: leaveSaving, title: '丢弃未保存修改并离开' }, '放弃修改'),
              h('button', { className: 'ad-btn ad-primary ad-sm', onClick: confirmLeaveSave, disabled: leaveSaving || busy }, leaveSaving ? '保存中…' : '保存并离开'),
            ),
          ),
        ))
      }
      // v0.12.1（task-8）：项目页「设置」入口 = 面板内设置浮层（与宿主设置页共用同一 SettingsSection 组件）
      if (settingsOverlay) {
        children.push(h('div', {
          className: 'ad-modal-backdrop',
          key: 'settings-overlay',
          onMouseDown: (event) => { if (event.target === event.currentTarget) setSettingsOverlay(false) },
        },
          h('div', { className: 'ad-modal ad-settings-overlay-panel', id: 'ad-settings-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'AI 短剧设置', 'aria-keyshortcuts': 'Escape' },
            h(SettingsSection, {
              embedded: true,
              onClose: () => setSettingsOverlay(false),
              onSaved: (nextSettings) => { if (nextSettings) setSettings(nextSettings) },
            }))))
      }
      // v0.14.0（task-38 / M6-1）：交给 Agent（C 路径）弹窗
      if (handoffOpen) {
        children.push(h('div', {
          className: 'ad-modal-backdrop',
          key: 'agent-handoff',
          onMouseDown: (event) => { if (event.target === event.currentTarget) closeHandoff() },
        },
          h('div', {
            className: 'ad-modal',
            id: 'ad-agent-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'ad-agent-dialog-title',
            'aria-describedby': 'ad-agent-dialog-desc',
            'aria-busy': handoffBusy ? 'true' : 'false',
            'aria-keyshortcuts': 'Escape',
          },
            h('div', { className: 'ad-modal-title', id: 'ad-agent-dialog-title' }, '交给 Agent'),
            h('div', { className: 'ad-modal-desc', id: 'ad-agent-dialog-desc' },
              '交付范围：当前项目《' + String(openTitle || '') + '》 · 页签「' + String(tabLabelOfKey(tab)) + '」'),
            h('div', { className: 'ad-modal-desc' }, '仅发送必要上下文（项目名 + 当前页签内容摘要）；不发送无关本机信息。'),
            handoffBusy
              ? h('div', { className: 'ad-skeleton', role: 'status', 'aria-live': 'polite' },
                  h('div', { className: 'ad-skeleton-line w80' }),
                  h('div', { className: 'ad-skeleton-line w60' }),
                  h('div', { className: 'ad-skeleton-line w40' }),
                  h('div', { className: 'ad-hint-next' }, '正在准备交接…'))
              : h('div', { className: 'ad-agent-instr' },
                  h('textarea', {
                    className: 'ad-area',
                    readOnly: true,
                    rows: 6,
                    value: handoffInstr,
                    'aria-label': '交接指令预览',
                    onFocus: (event) => { try { event.target.select() } catch { /* 只读预览 */ } },
                  }),
                  handoffInstr.includes('（已截断') ? h('div', { className: 'ad-hint-next' }, '指令已截断（≤2000 字符 / 4KB）') : null,
                  handoffCopied ? h('div', { className: 'ad-hint-next', role: 'status', 'aria-live': 'polite' }, '已复制交接指令。请到 Agent 对话输入框粘贴并发送。') : null,
                  handoffCopyError
                    ? h('div', { className: 'ad-err-box', role: 'alert' },
                        h('div', { className: 'ad-err-head' }, '复制失败'),
                        h('div', { className: 'ad-err' }, String(handoffCopyError)),
                        h('div', { className: 'ad-err-next' }, '下一步：请手动全选下方指令复制，粘贴到 Agent 对话发送。'))
                    : null),
            h('div', { className: 'ad-modal-actions' },
              h('button', {
                className: 'ad-btn ad-primary',
                onClick: copyHandoff,
                disabled: handoffBusy || !handoffInstr,
              }, handoffBusy ? '准备中…' : (handoffCopyError ? '重试复制' : (handoffCopied ? '再次复制' : '复制交接指令'))),
              h('button', { className: 'ad-btn', onClick: closeHandoff }, '关闭')))))
      }
      // v0.16.6（C2-C / E15+H-7）：视觉圣经定向/冻结确认对话框
      if (styleDialog) {
        const styleDialogTitle = styleDialog === 'direct' ? '定向确认' : styleDialog === 'freeze' ? '冻结风格' : styleDialog === 'unfreeze' ? '解冻风格' : '保存微调'
        const styleDialogDesc = styleDialog === 'direct'
          ? '将当前五维风格确认为项目定向基准；定向后进入受控微调，冻结后不可修改。'
          : styleDialog === 'freeze'
            ? '冻结后风格不可修改，需解冻才能改。'
            : styleDialog === 'unfreeze'
              ? '解冻后回到「已定向」可微调状态；请填写原因并确认。'
              : '微调会影响下游风格基准；将基于当前 revision 提交（expectedHash 并发保护）。'
        const reasonNeeded = styleDialog === 'unfreeze' || styleDialog === 'freeze'
        children.push(h('div', {
          className: 'ad-modal-backdrop',
          key: 'style-dialog',
          onMouseDown: (event) => { if (event.target === event.currentTarget) closeStyleDialog() },
        },
          h('div', {
            className: 'ad-modal',
            id: 'ad-style-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'ad-style-dialog-title',
            'aria-describedby': 'ad-style-dialog-desc',
            'aria-busy': styleBusy ? 'true' : 'false',
            'aria-keyshortcuts': 'Escape',
          },
            h('div', { className: 'ad-modal-title', id: 'ad-style-dialog-title' }, styleDialogTitle),
            h('div', { className: 'ad-modal-desc', id: 'ad-style-dialog-desc' }, styleDialogDesc),
            reasonNeeded
              ? h('div', { className: 'ad-field' },
                  h('label', null, styleDialog === 'unfreeze' ? '解冻原因（必填 10–300 字）' : '冻结备注（可选，≤300 字）'),
                  h('textarea', {
                    className: 'ad-area',
                    rows: 3,
                    maxLength: STYLE_REASON_MAX,
                    value: styleReason,
                    disabled: styleBusy,
                    'aria-label': styleDialog === 'unfreeze' ? '解冻原因' : '冻结备注',
                    onChange: (event) => {
                      setStyleReason(event.target.value)
                      if (styleReasonError) setStyleReasonError('')
                    },
                  }),
                  styleDialog === 'unfreeze'
                    ? h('div', { className: 'ad-style-count' }, String(styleReason.trim().length) + '/' + String(STYLE_REASON_MAX) + '（至少 ' + String(STYLE_REASON_MIN) + ' 字）')
                    : null,
                  styleReasonError ? h('div', { className: 'ad-err', role: 'alert' }, styleReasonError) : null)
              : null,
            styleError
              ? h('div', { className: 'ad-err-box', role: 'alert' },
                  h('div', { className: 'ad-err-head' }, '操作失败'),
                  h('div', { className: 'ad-err' }, styleError))
              : null,
            h('div', { className: 'ad-modal-actions' },
              h('button', { className: 'ad-btn ad-primary', onClick: confirmStyleDialog, disabled: styleBusy }, styleBusy ? '处理中…' : '确认'),
              h('button', { className: 'ad-btn', onClick: closeStyleDialog, disabled: styleBusy }, '取消')))))
      }
      // v0.16.9（C3-C / E16+H-8）：审核动作确认对话框（驳回原因 / 定稿二次确认 / 重打开原因+二次确认）
      if (assetReviewDialog) {
        const assetReviewDialogType = assetReviewDialog.type
        const assetReviewDialogTitle = assetReviewDialogType === 'reject' ? '驳回审核'
          : assetReviewDialogType === 'finalize' ? '定稿确认'
            : '重打开'
        const assetReviewDialogDesc = assetReviewDialogType === 'reject'
          ? '驳回后审核状态变为「已驳回」，需修改提示词后重新提交。请填写驳回原因（4–300 字，必填）。'
          : assetReviewDialogType === 'finalize'
            ? '定稿后提示词锁定为只读（final），之后写操作会被拒绝（423 asset-locked）；如需修改必须先「重打开」。确认定稿？'
            : '重打开后审核状态回到「草稿」，可继续修改提示词并重新提交；历史轮次与定稿提示词保留。请填写重打开原因（4–300 字，必填）并确认。'
        const assetReviewNeedReason = assetReviewDialogType === 'reject' || assetReviewDialogType === 'reopen'
        children.push(h('div', {
          className: 'ad-modal-backdrop',
          key: 'review-dialog',
          onMouseDown: (event) => { if (event.target === event.currentTarget) closeAssetReviewDialog() },
        },
          h('div', {
            className: 'ad-modal',
            id: 'ad-review-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'ad-review-dialog-title',
            'aria-describedby': 'ad-review-dialog-desc',
            'aria-busy': assetReviewBusy ? 'true' : 'false',
            'aria-keyshortcuts': 'Escape',
          },
            h('div', { className: 'ad-modal-title', id: 'ad-review-dialog-title' }, assetReviewDialogTitle),
            h('div', { className: 'ad-modal-desc', id: 'ad-review-dialog-desc' }, assetReviewDialogDesc),
            assetReviewNeedReason
              ? h('div', { className: 'ad-field' },
                  h('label', null, assetReviewDialogType === 'reject' ? '驳回原因（必填 4–300 字）' : '重打开原因（必填 4–300 字）'),
                  h('textarea', {
                    className: 'ad-area',
                    rows: 3,
                    maxLength: ASSET_REVIEW_REASON_MAX,
                    value: assetReviewReason,
                    disabled: assetReviewBusy,
                    'aria-label': assetReviewDialogType === 'reject' ? '驳回原因' : '重打开原因',
                    onChange: (event) => {
                      setAssetReviewReason(event && event.target ? event.target.value : '')
                      if (assetReviewReasonError) setAssetReviewReasonError('')
                    },
                  }),
                  h('div', { className: 'ad-style-count' }, `${String(assetReviewReason || '').trim().length}/${ASSET_REVIEW_REASON_MAX}（至少 ${ASSET_REVIEW_REASON_MIN} 字）`),
                  assetReviewReasonError ? h('div', { className: 'ad-err', role: 'alert' }, assetReviewReasonError) : null)
              : null,
            assetReviewError
              ? h('div', { className: 'ad-err-box', role: 'alert' },
                  h('div', { className: 'ad-err-head' }, '操作失败'),
                  h('div', { className: 'ad-err' }, assetReviewError))
              : null,
            h('div', { className: 'ad-modal-actions' },
              h('button', { className: 'ad-btn ad-primary', onClick: confirmAssetReviewDialog, disabled: assetReviewBusy },
                assetReviewBusy ? '处理中…' : (assetReviewDialogType === 'finalize' ? '确认定稿' : assetReviewDialogType === 'reject' ? '确认驳回' : '确认重打开')),
              h('button', { className: 'ad-btn', onClick: closeAssetReviewDialog, disabled: assetReviewBusy }, '取消')))))
      }
      // v0.15.5（task-121）：lightbox 提升到面板根层级（.ad-body 滚动容器之外；关闭三方式：按钮 / Esc / 背景）
      if (visualLightboxNode) children.push(visualLightboxNode)
      return h('div', { className: 'ad-shell', role: 'region', 'aria-label': 'AI 短剧工作区' }, children)
    }

    /* ---------------------------------------------------------------- 注册 */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: 'AI 短剧' },
            DramaIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, DramaPanel),
        )
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'ai-drama', order: 60, label: 'AI 短剧' },
            SettingsSection,
          ),
        )
        // v0.12.1（task-17）：会话内工具卡 K=1 —— 只注册 drama_check_consistency（官方 inject+register 写法）
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            { name: 'tool.call.toolview', key: 'drama_check_consistency' },
            DramaCheckToolCard,
          ),
        )
      },
    }
  },
})
