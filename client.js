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

    /* ------------------------------------------------------ 设置对象归一化（C-2） */

    // H-2 冻结口径：设置只增字段；旧宿主响应缺字段时用这里的默认值渲染（降级）。
    // P2-2（Q1）：strictMode = 创作流程强制门禁开关（默认 false 宽松；宿主 settings 校验并生效）。
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

    /** 归一化单个任务模型配置；非法/越界字段丢弃（不写坏 settings，不做强校验报错）。
     *  P2-6 增强（v0.6.2）：timeoutMs（1000~60000 整数）原样保留/透传，避免面板读→改→保存把它丢掉。 */
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
      return h('div', { className: 'ad-empty ad-empty-state', key: options.key, role: 'status' },
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
          : h('div', { className: 'ad-empty' }, options.empty || '（无数据）'),
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
          : h('div', { className: 'ad-empty' }, options.empty || '未发现问题。'),
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

    // 创作流水线（数据源 `progress-get`）：项目→大纲→人物→剧本→分镜→导出
    const PIPELINE_FALLBACK = [
      ['project', '项目已建'], ['outline', '大纲就绪'], ['characters', '人物就绪'],
      ['episode_script', '剧本就绪'], ['storyboard', '分镜就绪'], ['exported', '已导出'],
    ]

    function pipelineSteps(progress) {
      if (progress && Array.isArray(progress.steps) && progress.steps.length) return progress.steps
      return PIPELINE_FALLBACK.map(([key, label]) => ({ key, label, done: false }))
    }

    function renderPipelineBar(progress, onRefresh) {
      const steps = pipelineSteps(progress)
      const current = progress ? progress.stage : ''
      const facts = (progress && progress.facts) || {}
      return h('div', { className: 'ad-pipe', key: 'pipeline', role: 'group', 'aria-label': '创作流水线' },
        h('div', { className: 'ad-pipe-inner' },
          steps.map((step, i) =>
            h('div', {
              key: step.key,
              className: 'ad-pipe-step',
              'data-on': step.key === current ? '1' : '0',
              'data-done': step.done ? '1' : '0',
              title: `${step.label}${step.done ? '（已完成）' : '（未完成）'}`,
            },
            (step.done ? '✓ ' : '') + step.label,
            i < steps.length - 1 ? h('span', { className: 'ad-pipe-sep' }, '→') : null))),
        h('span', { className: 'ad-sub' },
          `大纲 ${facts.outlineCount || 0} · 人物 ${facts.characterCount || 0} · 剧本 ${facts.episodeCount || 0} · 分镜 ${facts.storyboardCount || 0} · 导出 ${facts.exportCount || 0}` +
          (facts.openMemoryCount ? ` · 未回收伏笔 ${facts.openMemoryCount}` : '')),
        onRefresh ? h('button', { className: 'ad-btn ad-sm', onClick: onRefresh }, '刷新进度') : null,
      )
    }

    /* ------------------------------------ P2-2 创作流程状态机（6 步 / 三态） */

    // 与 progress-get 六步对齐：project → outline → characters → episode_script → storyboard → exported
    // 持久化：<项目>/.aidrama/flow-state.json（宿主经 doc-read/doc-save 特例读写，零新增 route）
    const FLOW_STEPS = [
      ['project', '项目', '已建项目'],
      ['outline', '大纲', '写好总纲'],
      ['characters', '人物', '人物设定卡'],
      ['episode_script', '剧本', '分集剧本'],
      ['storyboard', '分镜', '分镜表'],
      ['exported', '导出', '导出交付物'],
    ]
    const FLOW_STATE_PATH = '.aidrama/flow-state.json'
    const FLOW_STATUS_LABELS = {
      not_started: '未开始',
      in_progress: '进行中',
      confirmed: '已确认',
      stale: '待重做',
      blocked: '未解锁',
    }
    const FLOW_TAB_STEP = {
      contract: 'project',
      outline: 'outline',
      characters: 'characters',
      episode: 'episode_script',
      storyboard: 'storyboard',
      check: 'exported',
    }

    function emptyFlowSteps() {
      const steps = {}
      for (const [key] of FLOW_STEPS) steps[key] = 'not_started'
      return steps
    }

    /** 容错归一化 flow-state（steps 值兼容字符串；缺失/非法值按 not_started）。 */
    function normalizeFlowState(raw) {
      const value = raw && typeof raw === 'object' ? raw : {}
      const steps = emptyFlowSteps()
      const inputSteps = value.steps && typeof value.steps === 'object' ? value.steps : {}
      for (const [key] of FLOW_STEPS) {
        const entry = inputSteps[key]
        const status = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? String(entry.status || '') : ''
        if (Object.prototype.hasOwnProperty.call(FLOW_STATUS_LABELS, status) && status !== 'blocked') {
          steps[key] = status
        }
      }
      const history = Array.isArray(value.history) ? value.history.slice(-100) : []
      return {
        version: Number(value.version) || 1,
        strictMode: value.strictMode === true,
        steps,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
        history,
      }
    }

    /** AC-F7 降级：旧项目无 flow-state 时按 progress 内容推断（只读展示，宿主就绪后由宿主覆盖）。
     *  与宿主 inferFlowState 对齐：project 恒 confirmed；从达到的最高步向下全部 confirmed，其余 not_started。 */
    function inferFlowStateFromProgress(progress) {
      const facts = (progress && progress.facts) || {}
      const achieved = [
        true,
        (facts.outlineCount || 0) > 0,
        (facts.characterCount || 0) > 0,
        (facts.episodeCount || 0) > 0,
        (facts.storyboardCount || 0) > 0,
        (facts.exportCount || 0) > 0,
      ]
      let maxLevel = 0
      for (let i = 0; i < achieved.length; i += 1) if (achieved[i]) maxLevel = i
      const steps = emptyFlowSteps()
      for (let i = 0; i < FLOW_STEPS.length; i += 1) {
        steps[FLOW_STEPS[i][0]] = i <= maxLevel ? 'confirmed' : 'not_started'
      }
      steps.project = 'confirmed'
      return normalizeFlowState({ version: 1, strictMode: false, steps, updatedAt: new Date().toISOString(), history: [] })
    }

    function flowStepIndex(key) {
      return FLOW_STEPS.findIndex(([stepKey]) => stepKey === key)
    }

    function flowStepLabel(key) {
      const hit = FLOW_STEPS.find(([stepKey]) => stepKey === key)
      return hit ? hit[1] : String(key || '')
    }

    function flowStepAction(key) {
      const hit = FLOW_STEPS.find(([stepKey]) => stepKey === key)
      return hit ? hit[2] : ''
    }

    /** 当前步 = 第一个未确认的步骤；全部确认时停在导出。 */
    function flowCurrentKey(state) {
      if (!state || !state.steps) return 'project'
      for (const [key] of FLOW_STEPS) {
        const status = state.steps[key] || 'not_started'
        if (status !== 'confirmed') return key
      }
      return 'exported'
    }

    function flowRecoveryText(state) {
      if (!state) return '流程未开始（尚无 flow-state）'
      const current = flowCurrentKey(state)
      const status = state.steps[current] || 'not_started'
      return `上次停在：${flowStepLabel(current)}（${FLOW_STATUS_LABELS[status] || status}） / 下一步：${flowStepAction(current)}`
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
.ad-shell{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#1a1a1a);background:var(--dsw-alias-bg-base,#fff)}
.ad-head{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l3,#e6e6e6);flex:none}
.ad-title{font-size:15px;font-weight:600}
.ad-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#8a8a8a)}
.ad-body{flex:1;min-height:0;overflow:auto;padding:16px 18px}
.ad-btn{border:1px solid var(--dsw-alias-border-l3,#d9d9d9);background:transparent;color:inherit;border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer;white-space:nowrap}
.ad-btn:hover{background:var(--dsw-alias-bg-hover,rgba(0,0,0,.05))}
.ad-btn[disabled]{opacity:.5;cursor:default}
.ad-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#1f6feb);color:#fff}
.ad-sm{padding:2px 8px;font-size:12px}
.ad-card{border:1px solid var(--dsw-alias-border-l3,#e6e6e6);border-radius:10px;padding:12px 14px;margin-bottom:10px;display:flex;align-items:center;gap:12px}
.ad-card-main{flex:1;min-width:0}
.ad-card-title{font-size:14px;font-weight:600;margin-bottom:2px}
.ad-card-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#8a8a8a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ad-empty{color:var(--dsw-alias-label-secondary,#8a8a8a);font-size:13px;line-height:1.9}
.ad-err{color:var(--dsw-alias-label-error,#d4380d);font-size:13px;line-height:1.8}.ad-warn{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--dsw-alias-bg-warning,#fffbe6);color:var(--dsw-alias-label-warning,#ad6800);border:1px solid var(--dsw-alias-border-warning,#ffe58f)}
.ad-row{display:flex;align-items:center;gap:8px}
.ad-input,.ad-select,.ad-area{padding:6px 10px;font-size:13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,#d9d9d9);background:transparent;color:inherit;font-family:inherit;box-sizing:border-box}
.ad-input{flex:1;min-width:0}
.ad-area{width:100%;resize:vertical;line-height:1.7}
.ad-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l3,#e6e6e6);margin-bottom:14px;flex:none;overflow-x:auto;white-space:nowrap}
.ad-tab{border:0;background:transparent;color:inherit;padding:7px 12px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;opacity:.7}
.ad-tab[data-on="1"]{opacity:1;font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#1f6feb)}
.ad-field{display:flex;gap:10px;align-items:flex-start;margin-bottom:10px}
.ad-field > label{width:110px;flex:none;font-size:13px;padding-top:7px;color:var(--dsw-alias-label-secondary,#8a8a8a)}
.ad-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.ad-box{border:1px solid var(--dsw-alias-border-l3,#e6e6e6);border-radius:10px;padding:12px}
.ad-table{width:100%;border-collapse:collapse;font-size:12.5px}
.ad-table th,.ad-table td{border:1px solid var(--dsw-alias-border-l3,#e6e6e6);padding:4px 6px;text-align:left;vertical-align:top}
.ad-table th{background:var(--dsw-alias-bg-subtle,rgba(0,0,0,.03));font-weight:600;white-space:nowrap}
.ad-table input,.ad-table textarea{width:100%;border:0;background:transparent;color:inherit;font:inherit;padding:2px;box-sizing:border-box;resize:vertical}
.ad-table input:focus,.ad-table textarea:focus{outline:1px solid var(--dsw-alias-brand-primary,#1f6feb);border-radius:3px}
.ad-node{display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0}
.ad-count{font-size:11px;color:var(--dsw-alias-label-secondary,#8a8a8a)}
.ad-path{font-size:11px;color:var(--dsw-alias-label-secondary,#8a8a8a);margin-top:14px;word-break:break-all;line-height:1.7}
.ad-flash{font-size:12px;color:var(--dsw-alias-label-success,#237804)}
.ad-hits{font-size:12.5px;line-height:1.7}
.ad-hit{padding:5px 0;border-bottom:1px dotted var(--dsw-alias-border-l3,#e6e6e6)}
.ad-hit-path{color:var(--dsw-alias-label-secondary,#8a8a8a);font-size:11px}
.ad-sec{font-size:13px;font-weight:600;margin:16px 0 8px}
.ad-pre{margin:0;padding:8px 10px;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;border-radius:6px;background:var(--dsw-alias-bg-subtle,rgba(0,0,0,.04));font-family:Consolas,Menlo,monospace}
.ad-dirty{font-size:12px;color:var(--dsw-alias-label-warning,#ad6800)}
.ad-ok{font-size:12px;color:var(--dsw-alias-label-success,#237804)}
.ad-scenes{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:10px;margin-top:10px}
.ad-scene{border:1px solid var(--dsw-alias-border-l3,#e6e6e6);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-subtle,rgba(0,0,0,.02))}
.ad-scene-head{font-size:13px;font-weight:600;margin-bottom:3px;word-break:break-word}
.ad-scene-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#8a8a8a);margin-bottom:6px}
.ad-scene-line{font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:140px;overflow:auto}
.ad-check{width:14px;height:14px;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#1f6feb);flex:none}
.ad-node-ops{display:flex;align-items:center;gap:4px;margin-left:auto}
.ad-pipe{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 18px 6px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l3,#eee)}
.ad-pipe-inner{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.ad-pipe-step{display:flex;align-items:center;gap:4px;font-size:12px;padding:3px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,#e6e6e6);color:var(--dsw-alias-label-secondary,#8a8a8a);white-space:nowrap}
.ad-pipe-step[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#1f6feb);color:var(--dsw-alias-brand-primary,#1f6feb);font-weight:600}
.ad-pipe-step[data-done="1"]{border-color:var(--dsw-alias-label-success,#237804);color:var(--dsw-alias-label-success,#237804)}
.ad-pipe-sep{color:var(--dsw-alias-label-secondary,#8a8a8a);font-size:11px;margin-left:4px}
.ad-toolcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;margin-top:8px}
.ad-toolcard{display:flex;flex-direction:column;gap:2px}
.ad-toolcard[data-tone="warn"]{border-color:var(--dsw-alias-border-warning,#ffe58f)}
.ad-toolcard[data-tone="error"]{border-color:var(--dsw-alias-border-error,#ffccc7)}
.ad-toolcard-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ad-kv-row{display:flex;gap:8px;font-size:12.5px;line-height:1.8;word-break:break-word}
.ad-kv-key{color:var(--dsw-alias-label-secondary,#8a8a8a);min-width:92px;flex:none}
.ad-tool-title{font-size:12.5px;font-weight:600;margin:14px 0 6px}
.ad-fold{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8a8a)}
.ad-fold summary{cursor:pointer}
.ad-shell-row{flex:1;min-height:0;display:flex;align-items:stretch}
.ad-main-col{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
.ad-doc{width:40%;min-width:320px;max-width:620px;border-left:1px solid var(--dsw-alias-border-l3,#e6e6e6);display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base,#fff)}
.ad-doc-head{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l3,#eee);flex:none}
.ad-doc-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
.ad-doc-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#8a8a8a);line-height:1.7;word-break:break-all}
.ad-doc-area{flex:1;min-height:160px;width:100%;box-sizing:border-box;padding:10px 12px;border:0;resize:none;font-family:Consolas,Menlo,monospace;font-size:12.5px;line-height:1.8;color:inherit;background:transparent}
.ad-doc-area:focus{outline:1px solid var(--dsw-alias-brand-primary,#1f6feb);outline-offset:-1px}
.ad-doc-foot{padding:6px 12px 12px;flex:none;display:flex;flex-direction:column;gap:6px}
.ad-doc-conflict{margin:8px 12px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--dsw-alias-bg-warning,#fffbe6);color:var(--dsw-alias-label-warning,#ad6800);border:1px solid var(--dsw-alias-border-warning,#ffe58f)}
.ad-doc-note{margin:8px 12px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--dsw-alias-bg-subtle,rgba(0,0,0,.03));color:var(--dsw-alias-label-secondary,#8a8a8a)}
.ad-doc-err{margin:8px 12px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--dsw-alias-bg-error,#fff1f0);color:var(--dsw-alias-label-error,#d4380d);border:1px solid var(--dsw-alias-border-error,#ffccc7)}
.ad-flow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 18px 6px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l3,#eee)}
.ad-flow-step{display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,#e6e6e6);background:transparent;color:var(--dsw-alias-label-secondary,#8a8a8a);font-size:12px;cursor:pointer;white-space:nowrap}
.ad-flow-step[data-state="confirmed"]{border-color:var(--dsw-alias-label-success,#237804);color:var(--dsw-alias-label-success,#237804)}
.ad-flow-step[data-state="current"]{border-color:var(--dsw-alias-brand-primary,#1f6feb);color:var(--dsw-alias-brand-primary,#1f6feb);font-weight:600}
.ad-flow-step[data-state="stale"]{border-color:var(--dsw-alias-border-warning,#ffe58f);color:var(--dsw-alias-label-warning,#ad6800);background:var(--dsw-alias-bg-warning,#fffbe6)}
.ad-flow-step[data-state="pending"]{opacity:.72}
.ad-flow-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#8a8a8a)}
.ad-flow-stale{margin:0 0 10px;padding:7px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--dsw-alias-bg-warning,#fffbe6);color:var(--dsw-alias-label-warning,#ad6800);border:1px solid var(--dsw-alias-border-warning,#ffe58f)}
.ad-flow-detail{margin:8px 0 10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l3,#e6e6e6);border-radius:10px;font-size:12.5px;line-height:1.8;display:flex;flex-direction:column;gap:6px}
.ad-flow-mode{font-size:12px;margin-left:auto}
.ad-flow-msg{font-size:12px;color:var(--dsw-alias-label-warning,#ad6800)}
.ad-err-box{margin:0 0 12px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-error,#ffccc7);background:var(--dsw-alias-bg-error,#fff1f0);display:flex;flex-direction:column;gap:4px}
.ad-err-head{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-error,#d4380d)}
.ad-err-next{font-size:12px;line-height:1.8;color:var(--dsw-alias-label-warning,#ad6800)}
.ad-err-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.ad-empty-state{padding:14px 16px;border:1px dashed var(--dsw-alias-border-l3,#d9d9d9);border-radius:10px;line-height:1.9;color:var(--dsw-alias-label-secondary,#8a8a8a)}
.ad-empty-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);margin-bottom:4px}
.ad-hint-next{font-size:12px;line-height:1.8;color:var(--dsw-alias-label-secondary,#8a8a8a);margin-top:4px}
.ad-review-finding{margin-bottom:10px}
.ad-review-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.ad-sev{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,#e6e6e6)}
.ad-sev[data-tone="error"]{background:var(--dsw-alias-bg-error,#fff1f0);color:var(--dsw-alias-label-error,#d4380d);border-color:var(--dsw-alias-border-error,#ffccc7)}
.ad-sev[data-tone="warn"]{background:var(--dsw-alias-bg-warning,#fffbe6);color:var(--dsw-alias-label-warning,#ad6800);border-color:var(--dsw-alias-border-warning,#ffe58f)}
.ad-sev[data-tone="info"]{background:var(--dsw-alias-bg-subtle,rgba(0,0,0,.03));color:var(--dsw-alias-label-secondary,#8a8a8a)}
.ad-review-evidence{margin:4px 0;padding:6px 8px;border-left:2px solid var(--dsw-alias-border-brand,#1f6feb);background:var(--dsw-alias-bg-subtle,rgba(0,0,0,.03));font-size:12px;line-height:1.8;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}
.ad-review-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.ad-evidence-highlight .ad-evidence-mark,mark.ad-evidence-mark{background:var(--dsw-alias-bg-warning,#fffbe6);color:inherit;padding:0 2px;border-radius:2px;border-bottom:1px solid var(--dsw-alias-border-warning,#ffe58f)}
.ad-skeleton{display:flex;flex-direction:column;gap:10px;padding:6px 2px}
.ad-skeleton-line{height:14px;border-radius:6px;background:var(--dsw-alias-bg-subtle,rgba(0,0,0,.06));animation:ad-skeleton-pulse 1.2s ease-in-out infinite}
.ad-skeleton-line.w40{width:40%}.ad-skeleton-line.w60{width:60%}.ad-skeleton-line.w80{width:80%}.ad-skeleton-line.w90{width:90%}
@keyframes ad-skeleton-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.ad-review-status{font-size:11.5px;color:var(--dsw-alias-label-success,#237804)}
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

    /* ------------------------------------------------------------ 通用控件 */

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
      const [tab, setTab] = React.useState('contract')
      const [tree, setTree] = React.useState(null)
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
      const [progress, setProgress] = React.useState(null)
      const [collapsed, setCollapsed] = React.useState({})
      const [settings, setSettings] = React.useState(null)
      const [showSettings, setShowSettings] = React.useState(false)
      const [shared, setShared] = React.useState(null)
      const [sharedText, setSharedText] = React.useState('')
      const [sharedPath, setSharedPath] = React.useState('')
      const [dialogue, setDialogue] = React.useState(null)
      const [assets, setAssets] = React.useState([])
      const [assetSource, setAssetSource] = React.useState('')
      const [assetShots, setAssetShots] = React.useState('')
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
      const [importText, setImportText] = React.useState('')
      const [importPreview, setImportPreview] = React.useState(null)
      const [showImport, setShowImport] = React.useState(false)
      // P1：宿主能力门控（status.version >= 0.4.0 才启用 H-1/H-2/H-3 新交互）
      const [hostFlags, setHostFlags] = React.useState({ p1: false })
      // P1：未保存标记（剧本 / 分镜），保存成功后清除
      const [dirty, setDirty] = React.useState({ episode: false, storyboard: false })
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
      // P2-2 流程状态机：flow-state 由宿主 doc-read/doc-save 特例读写；默认宽松模式（Q1）
      const [flowState, setFlowState] = React.useState(null)
      const [flowAvailable, setFlowAvailable] = React.useState(false)
      const [flowBusy, setFlowBusy] = React.useState(false)
      const [flowMsg, setFlowMsg] = React.useState('')
      const [flowError, setFlowError] = React.useState('')
      const [flowHash, setFlowHash] = React.useState('')
      const [flowDetail, setFlowDetail] = React.useState('')
      const [flowStrictMode, setFlowStrictMode] = React.useState(false)
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
      // P2-6：任务模型区块的即时校验 / 保存降级提示
      const [taskModelError, setTaskModelError] = React.useState('')
      // v0.6.3：审读展示细化（维度筛选 / 排序）+ 任务模型最近使用列表
      const [reviewDimensionFilter, setReviewDimensionFilter] = React.useState('')
      const [reviewSort, setReviewSort] = React.useState('severity')
      const [taskModelRecent, setTaskModelRecent] = React.useState(() => loadRecentTaskModels())

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

      const guard = async (fn) => {
        setBusy(true)
        setError('')
        setErrorInfo(null)
        try {
          await fn()
        } catch (err) {
          // P2-2：强制模式下越步写入被宿主以 409 conflict 拒绝 → 用流程提示引导先确认上一步
          if (err && err.code === 'conflict' && /强制模式|需先确认/.test(String(err.message || ''))) {
            setFlowMsg(String(err.message || ''))
            refreshFlow().catch(() => {})
          } else {
            setError(err.message)
            setErrorInfo(friendlyErrorInfo(err))
            setRetryAction({ run: fn })
          }
        } finally {
          setBusy(false)
        }
      }

      const markDirty = (key) => setDirty((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
      const clearDirty = (key) => setDirty((prev) => (prev[key] ? { ...prev, [key]: false } : prev))
      const dirtyMark = (key) => (dirty[key] ? h('span', { className: 'ad-dirty' }, '● 有未保存修改') : null)

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
          setTab('contract')
          const first = (eps.episodes || [])[0]
          setEpisodeOrder(first ? first.order : 1)
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
          // P2-2：加载流程状态（宿主未就绪时按内容推断只读展示）
          loadFlow(title, prg.progress).catch(() => {})
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

      // T8 流水线：progress-get 是唯一数据源（与「创作进度」工具一致）
      const refreshProgress = () =>
        guard(async () => {
          const result = await api('progress-get', { title: openTitle })
          setProgress(result.progress)
          say('创作进度已刷新')
        })

      /* ------------------------------------------------------ 契约 / 总纲 / 人物 */

      const saveContract = () =>
        guard(async () => {
          const result = await api('contract-save', { title: openTitle, contract })
          setContract(result.contract)
          say('契约已保存')
          refreshFlow().catch(() => {})
        })

      const setRow = (index, key, value) =>
        setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [key]: value } : row)))
      const addRow = () =>
        setRows((prev) => [
          ...prev,
          { order: prev.length + 1, title: '', logline: '', hook: '', twist: '', cliffhanger: '', estDurationSec: 0 },
        ])
      const removeRow = (index) => setRows((prev) => prev.filter((_, i) => i !== index))
      const saveOutline = () => guard(async () => {
        const result = await api('outline-save', { title: openTitle, rows })
        setRows(result.rows)
        say('总纲已保存')
        refreshFlow().catch(() => {})
      })

      const setCard = (index, key, value) =>
        setCharacters((prev) => prev.map((card, i) => (i === index ? { ...card, [key]: value } : card)))
      const addCard = () => setCharacters((prev) => [...prev, { name: '', role: '配角', personality: [], bio: '', appearancePrompt: '', voiceHint: '' }])
      const removeCard = (index) => setCharacters((prev) => prev.filter((_, i) => i !== index))
      const saveCharacters = () => guard(async () => {
        const result = await api('characters-save', { title: openTitle, characters })
        setCharacters(result.characters)
        say('人物卡已保存')
        refreshFlow().catch(() => {})
      })

      /* ---------------------------------------------------------- 剧本 / 分镜 */

      const loadEpisode = (order) =>
        guard(async () => {
          const result = await api('episode-read', { title: openTitle, order })
          setEpisodeOrder(order)
          setEpisodeText(result.text || '')
          clearDirty('episode')
        })

      const saveEpisode = () =>
        guard(async () => {
          const result = await api('episode-write', { title: openTitle, order: episodeOrder, text: episodeText })
          const [eps, prg] = await Promise.all([
            api('episodes-list', { title: openTitle }),
            api('progress-get', { title: openTitle }),
          ])
          setEpisodes(eps.episodes || [])
          setProgress(prg.progress)
          clearDirty('episode')
          const bytes = result.saved && result.saved.bytes
          say(`第${episodeOrder}集已保存${bytes ? `（${bytes} 字节）` : ''}`)
          // P2-8 一致性：编辑器打开的是同一剧本文件时，同步磁盘最新内容（有未保存修改则先提示）
          if (docOpen && docPath && docPath === docFallbackPath()) {
            if (docDirty) setDocNotice('文档编辑器有未保存修改：可直接保存覆盖，或点「重新载入最新」同步刚保存的剧本。')
            else loadDoc(docPath).catch(() => {})
          }
          refreshFlow().catch(() => {})
        })

      const loadShots = (order) =>
        guard(async () => {
          const result = await api('storyboard-get', { title: openTitle, order })
          setEpisodeOrder(order)
          setShots(result.shots || [])
          clearDirty('storyboard')
        })

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
        const result = await api('storyboard-save', { title: openTitle, order: episodeOrder, shots })
        setShots(result.shots)
        clearDirty('storyboard')
        say(`分镜已保存${result.shots ? `（${result.shots.length} 个镜头）` : ''}`)
        refreshFlow().catch(() => {})
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

      // 草稿处理后统一刷新：草稿区 + 可能被改写的正式内容 + 进度 + 分镜 + 目录树
      const reloadAfterDraftResolution = async () => {
        const [dr, c, o, ch, eps, prg, sb, tr] = await Promise.all([
          api('drafts-list', { title: openTitle, includeResolved: draftIncludeResolved }),
          api('contract-get', { title: openTitle }),
          api('outline-get', { title: openTitle }),
          api('characters-get', { title: openTitle }),
          api('episodes-list', { title: openTitle }),
          api('progress-get', { title: openTitle }),
          api('storyboard-get', { title: openTitle, order: episodeOrder }),
          api('tree', { title: openTitle }),
        ])
        setDraftList(dr.drafts || [])
        setContract(c.contract)
        setRows(o.rows || [])
        setCharacters(ch.characters || [])
        setEpisodes(eps.episodes || [])
        setProgress(prg.progress)
        setShots(sb.shots || [])
        setTree(tr.tree)
        refreshFlow().catch(() => {})
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
          const prg = await api('progress-get', { title: openTitle })
          setProgress(prg.progress)
          refreshFlow().catch(() => {})
        })

      /* ------------------------------------------------------------ 本剧记忆 */

      const setMem = (index, key, value) =>
        setMemory((prev) => prev.map((m, i) => (i === index ? { ...m, [key]: value } : m)))
      const addMem = () =>
        setMemory((prev) => [...prev, { id: '', kind: '伏笔', content: '', episode: null, status: 'open' }])
      const removeMem = (index) => setMemory((prev) => prev.filter((_, i) => i !== index))
      const saveMemory = () =>
        guard(async () => {
          const result = await api('memory-save', { title: openTitle, memory })
          setMemory(result.memory)
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

      // 切源后重置全部视图状态（页签/项目/文档/搜索均回到列表页），避免跨源串扰
      const resetProjectView = () => {
        setPhase('ready')
        setTree(null)
        setOpenTitle('')
        setTab('contract')
        setContract(null)
        setRows([])
        setCharacters([])
        setEpisodes([])
        setEpisodeOrder(1)
        setEpisodeText('')
        setShots([])
        setDraftList([])
        setReport(null)
        setExported([])
        setMemory([])
        setWorld([])
        setProgress(null)
        setFinalized([])
        setLedger(null)
        setDialogue(null)
        setAssets([])
        setShared(null)
        setSharedPath('')
        setSharedText('')
        setHits(null)
        setDocOpen(false)
        setDocPath('')
        setDocText('')
        setDocHash('')
        setDocUpdatedAt('')
        setDocDirty(false)
        setDocConflict(null)
        setDocUnavailable(false)
        setDocNotifyState('idle')
        setDocError('')
        setDocNotice('')
        clearDirty('episode')
        clearDirty('storyboard')
        // P2-2：切源/返回列表时清空流程状态（跨项目不复用）
        setFlowState(null)
        setFlowAvailable(false)
        setFlowBusy(false)
        setFlowMsg('')
        setFlowError('')
        setFlowHash('')
        setFlowDetail('')
        setFlowStrictMode(false)
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
      }

      const sourceLabelOf = (item, index) => {
        const name = item.label || shortSourcePath(item.path)
        const type = sourceTypeLabel(item.sourceType)
        const count = item.projectCount == null ? '' : ` · ${item.projectCount} 个项目`
        const mark = index === 0 && sourcesMode === 'host' ? '★ ' : ''
        return `${mark}${name}（${type}${count}）`
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

      /* ---------------------------------- P2-2 流程状态机读写 / 确认 / 回退 */

      const flowHasContent = (key) => {
        const facts = (progress && progress.facts) || {}
        if (key === 'project') return true
        if (key === 'outline') return rows.length > 0 || (facts.outlineCount || 0) > 0
        if (key === 'characters') return characters.length > 0 || (facts.characterCount || 0) > 0
        if (key === 'episode_script') return episodes.length > 0 || (facts.episodeCount || 0) > 0
        if (key === 'storyboard') return (facts.storyboardCount || 0) > 0 || shots.length > 0
        if (key === 'exported') return (facts.exportCount || 0) > 0 || exported.length > 0
        return false
      }

      const flowStateFromText = (text) => {
        try {
          return normalizeFlowState(JSON.parse(text))
        } catch {
          return null
        }
      }

      // 读：doc-read 的 `.aidrama/flow-state.json` 特例（宿主 task-22；零新增 route）
      const loadFlow = async (title = openTitle, progressHint = progress, options = {}) => {
        if (!title) return null
        setFlowBusy(true)
        if (!options.silent) setFlowError('')
        try {
          const result = await api('doc-read', { title, path: FLOW_STATE_PATH })
          const state = flowStateFromText(result.text)
          if (!state) throw new Error('flow-state 内容不是合法 JSON')
          setFlowState(state)
          setFlowStrictMode(state.strictMode === true)
          setFlowAvailable(true)
          setFlowHash(result.hash || '')
          if (!options.silent) setFlowMsg('')
          return state
        } catch (error) {
          if (isHostRouteMissing(error) || (error && (error.code === 'not-found' || error.code === 'invalid-args'))) {
            // 宿主 flow 特例未就绪 → 降级：按 progress 推断只读展示，隐藏确认/回退
            setFlowAvailable(false)
            setFlowState(inferFlowStateFromProgress(progressHint))
            setFlowHash('')
            if (!options.silent) setFlowMsg('流程状态接口尚未就绪：当前为按内容推断的只读展示，确认/回退暂不可用。')
          } else if (!options.silent) {
            setFlowError(error.message)
          }
          return null
        } finally {
          setFlowBusy(false)
        }
      }

      const persistFlow = async (nextState) => {
        const text = JSON.stringify({
          version: 1,
          strictMode: nextState.strictMode === true,
          steps: nextState.steps,
        })
        const result = await api('doc-save', { title: openTitle, path: FLOW_STATE_PATH, text, expectedHash: flowHash })
        setFlowHash(result.hash || '')
        return result
      }

      // Q4：宿主在内容写入后自动同步 flow-state → client 重新读取刷新步骤条
      const refreshFlow = () =>
        openTitle && flowAvailable ? loadFlow(openTitle, progress, { silent: true }) : Promise.resolve(null)

      // Q1：强制门禁 = settings.strictMode（宿主权威）或项目级 flow-state.strictMode 任一开启
      const flowStrictActive = () =>
        (settings && settings.strictMode === true) || (flowState && flowState.strictMode === true) || flowStrictMode

      // 统一处理流程写冲突：expectedHash 冲突 → 重载；强制模式拒绝（409 conflict，无 currentHash）→ 展示宿主指引
      const applyFlowConflict = (error) => {
        if (!error || error.code !== 'conflict') return false
        if (error.detail && error.detail.currentHash) {
          setFlowMsg('流程状态已被其他操作更新，已重新载入，请重试。')
        } else {
          setFlowMsg(String(error.message || '强制模式：请先确认上一步后再操作。'))
        }
        loadFlow(openTitle, progress, { silent: true }).catch(() => {})
        return true
      }

      const confirmFlowStep = async (stepKey) => {
        if (!flowState || !flowAvailable) {
          setFlowMsg('流程状态接口尚未就绪，暂不能确认。')
          return
        }
        const status = flowState.steps[stepKey] || 'not_started'
        // AC-F1/F2：项目步由宿主初始化为 not_started，允许直接确认；其余步需 in_progress
        const statusConfirmable = status === 'in_progress' || (stepKey === 'project' && status === 'not_started')
        if (stepKey !== flowCurrentKey(flowState) || !statusConfirmable) {
          setFlowMsg('只有「当前进行中」的步骤可以确认。')
          return
        }
        if (!flowHasContent(stepKey)) {
          setFlowMsg(`「${flowStepLabel(stepKey)}」还没有内容，不能确认。`)
          return
        }
        setFlowBusy(true)
        setFlowError('')
        try {
          const steps = { ...flowState.steps, [stepKey]: 'confirmed' }
          const next = { ...flowState, steps }
          await persistFlow(next)
          setFlowState(next)
          setFlowMsg(`已确认「${flowStepLabel(stepKey)}」，可进入下一步。`)
          say(`已确认：${flowStepLabel(stepKey)}`)
          await loadFlow(openTitle, progress, { silent: true })
        } catch (error) {
          if (!applyFlowConflict(error)) setFlowError(error.message)
        } finally {
          setFlowBusy(false)
        }
      }

      // 回退/撤销确认：二次确认说明影响范围（Q3：仅标 stale，不删文件、不自动备份）
      const rollbackFlowTo = async (stepKey) => {
        if (!flowState || !flowAvailable) {
          setFlowMsg('流程状态接口尚未就绪，暂不能回退。')
          return
        }
        const targetIndex = flowStepIndex(stepKey)
        const downstream = FLOW_STEPS.slice(targetIndex + 1)
          .filter(([key]) => ['confirmed', 'stale'].includes(flowState.steps[key] || ''))
          .map(([, label]) => label)
        const exportedConfirmed = flowState.steps.exported === 'confirmed'
        const riskHead = exportedConfirmed && targetIndex < FLOW_STEPS.length - 1 ? '⚠ 高危组合：下游包含「已导出」内容。\n\n' : ''
        const impact = downstream.length ? downstream.join('、') : '（无下游已确认步骤）'
        if (!window.confirm(`${riskHead}回退到「${flowStepLabel(stepKey)}」？\n\n影响范围：${impact}\n\n- 「${flowStepLabel(stepKey)}」回到「进行中」，需重新确认；\n- 下游已确认步骤将标记「待重做」（仅提示，文件不会被删除）；\n- 已导出内容不会被删除。\n\n继续？`)) return
        setFlowBusy(true)
        setFlowError('')
        try {
          const steps = { ...flowState.steps, [stepKey]: 'in_progress' }
          for (const [key] of FLOW_STEPS.slice(targetIndex + 1)) {
            if (steps[key] === 'confirmed') steps[key] = 'stale'
          }
          const next = { ...flowState, steps }
          await persistFlow(next)
          setFlowState(next)
          setFlowMsg(`已回退到「${flowStepLabel(stepKey)}」：下游步骤标记为待重做（文件未删除）。`)
          say(`已回退：${flowStepLabel(stepKey)}`)
          await loadFlow(openTitle, progress, { silent: true })
        } catch (error) {
          if (!applyFlowConflict(error)) setFlowError(error.message)
        } finally {
          setFlowBusy(false)
        }
      }

      // 默认宽松模式（Q1）；严格模式通过 settings-save 写 strictMode（宿主校验并生效，AC-F3）
      const toggleFlowStrict = async (wantStrict) => {
        if (busy || flowBusy) return
        const baseSettings = settings ? settings : normalizeSettings(null)
        const previous = flowStrictActive()
        setFlowStrictMode(wantStrict)
        setFlowBusy(true)
        setFlowError('')
        try {
          const result = await api('settings-save', { settings: { ...baseSettings, strictMode: wantStrict } })
          const nextSettings = normalizeSettings(result.settings)
          setSettings(nextSettings)
          setFlowStrictMode(nextSettings.strictMode === true)
          setFlowMsg(
            wantStrict
              ? '已开启强制模式：未确认上一阶段时，内容写入与步骤确认会被宿主阻止（HTTP 409），先确认「上一阶段」即可。'
              : '已切回宽松模式：只提示不强制。',
          )
          if (openTitle && flowState) await loadFlow(openTitle, progress, { silent: true })
        } catch (error) {
          setFlowStrictMode(previous)
          setFlowError(error.message)
        } finally {
          setFlowBusy(false)
        }
      }

      // AC-F3 客户端预检：严格模式且前置未确认时阻止切换页签（宿主仍为最终权威）
      const strictGateBlock = (tabKey) => {
        const stepKey = FLOW_TAB_STEP[tabKey]
        if (!flowStrictActive() || !flowState || !flowAvailable || !stepKey) return ''
        const targetIndex = flowStepIndex(stepKey)
        for (let i = 0; i < targetIndex; i += 1) {
          const [key] = FLOW_STEPS[i]
          if ((flowState.steps[key] || '') !== 'confirmed') {
            return `严格模式（强制门禁）：请先确认「${flowStepLabel(key)}」后再进入「${flowStepLabel(stepKey)}」。`
          }
        }
        return ''
      }

      const switchTab = (tabKey) => {
        const blocked = strictGateBlock(tabKey)
        if (blocked) {
          setFlowMsg(blocked)
          return
        }
        setFlowMsg('')
        setTab(tabKey)
        // P2-3：进入「检查」页时若无报告则尝试读取最新审读报告（未就绪时静默降级为空态+指引）
        if (tabKey === 'check' && openTitle && !reviewReport && !reviewBusy) loadReview().catch(() => {})
      }

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

      const setWorldEntry = (index, key, value) =>
        setWorld((prev) => prev.map((e, i) => (i === index ? { ...e, [key]: value } : e)))
      const addWorldEntry = () => setWorld((prev) => [...prev, { id: '', kind: '地点', name: '', detail: '' }])
      const removeWorldEntry = (index) => setWorld((prev) => prev.filter((_, i) => i !== index))
      const saveWorld = () =>
        guard(async () => {
          const result = await api('world-save', { title: openTitle, world })
          setWorld(result.world)
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

      /* ------------------------------- P2-6 任务模型（settings.taskModels，Q1–Q5） */

      const taskModelsOf = () => normalizeTaskModels((settings && settings.taskModels) || {})
      const auditTaskModel = () => taskModelsOf().audit || null

      // 「使用宿主默认」开关：勾选 = 删除该任务键（走回退链 defaultModel → agentDefaultModel）
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

      const validateTaskModelsForSave = (normalized) => {
        const audit = normalized && normalized.taskModels ? normalized.taskModels.audit : null
        if (!audit) return ''
        if (!audit.model || !String(audit.model).trim()) return '审读（audit）任务模型名不能为空；不需要任务级覆盖请勾选「使用宿主默认」'
        if (audit.temperature != null && (!Number.isFinite(Number(audit.temperature)) || Number(audit.temperature) < 0 || Number(audit.temperature) > 2)) {
          return 'Temperature 需在 0~2 之间'
        }
        if (audit.maxTokens != null && (Math.round(Number(audit.maxTokens)) < 1 || Math.round(Number(audit.maxTokens)) > TASK_MODEL_MAX_TOKENS)) {
          return `MaxTokens 需在 1~${TASK_MODEL_MAX_TOKENS}（全局上限 60k）之间`
        }
        if (audit.timeoutMs != null && (!Number.isInteger(Number(audit.timeoutMs)) || Number(audit.timeoutMs) < TASK_MODEL_MIN_TIMEOUT_MS || Number(audit.timeoutMs) > TASK_MODEL_MAX_TIMEOUT_MS)) {
          return `超时需在 ${TASK_MODEL_MIN_TIMEOUT_MS}~${TASK_MODEL_MAX_TIMEOUT_MS} 毫秒之间（整数）`
        }
        return ''
      }

      const saveSettings = () =>
        guard(async () => {
          // 先按「用户意图」校验原始 taskModels（勾掉默认但没填 model 时要提示，而不是静默丢弃）
          const rawTaskModels = (settings && settings.taskModels) || {}
          const rawAudit = rawTaskModels.audit
          if (rawAudit && !String(rawAudit.model || '').trim()) {
            setTaskModelError('审读（audit）任务模型名不能为空；不需要任务级覆盖请勾选「使用宿主默认」')
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
          }
          const normalized = normalizeSettings(settings)
          const invalid = validateTaskModelsForSave(normalized)
          if (invalid) {
            setTaskModelError(invalid)
            return
          }
          setTaskModelError('')
          const result = await api('settings-save', { settings: normalized })
          const nextSettings = normalizeSettings(result.settings)
          setSettings(nextSettings)
          say('设置已保存')
          // v0.6.3：保存成功后记录「最近使用」模型（去重 + 上限 8 条，仅本地 localStorage）
          const savedAudit = nextSettings && nextSettings.taskModels ? nextSettings.taskModels.audit : null
          if (savedAudit && savedAudit.model) rememberRecentTaskModel({ provider: savedAudit.provider || '', model: savedAudit.model })
          // Q3 运行时探测：宿主若返回 modelFallback 标记（只增字段）则明确提示降级；旧宿主无该字段忽略
          const fallback = result.modelFallback === true ||
            (result.settings && result.settings.modelFallback === true) ||
            nextSettings.modelFallback === true
          if (fallback) {
            setTaskModelError('模型运行时探测不可用：宿主将回退到默认模型并标记 modelFallback（不阻断审读）。')
          }
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

      const loadAssets = () =>
        guard(async () => {
          const result = await api('assets-get', { title: openTitle })
          setAssets(result.assets || [])
        })

      const addAsset = () =>
        guard(async () => {
          const source = assetSource.trim()
          if (!source) return
          const linkedShots = assetShots.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean)
          await api('assets-add', { title: openTitle, source, linkedShots })
          setAssetSource('')
          setAssetShots('')
          await loadAssets()
          say('素材已登记')
        })

      const removeAsset = (id) =>
        guard(async () => {
          await api('assets-remove', { title: openTitle, id })
          await loadAssets()
          say('已移除')
        })

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
          setEpisodeOrder(order)
          setEpisodeText(ep.text || '')
          setShots(sb.shots || [])
          clearDirty('episode')
          clearDirty('storyboard')
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

      const loadLedger = () =>
        guard(async () => {
          const result = await api('ledger-get', { title: openTitle })
          setLedger(result.ledger)
        })

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

      /* ---------------------------------------------------------------- 渲染 */

      const children = [h(Styles, { key: 'styles' })]

      const headRight = []
      if (flash) headRight.push(h('span', { className: 'ad-flash', key: 'flash', role: 'status', 'aria-live': 'polite' }, flash))
      if (phase === 'project') {
        headRight.push(h('button', {
          className: 'ad-btn',
          key: 'doc',
          onClick: toggleDocPane,
          disabled: busy,
          'aria-pressed': docOpen ? 'true' : 'false',
          title: '面板内右栏文档编辑器（T7 / E1；不接管原生 documentpreview）',
        }, docOpen ? '收起文档' : '文档'))
        headRight.push(h('button', { className: 'ad-btn', key: 'back', onClick: () => { setPhase('ready'); setTree(null); loadList() }, disabled: busy, 'aria-label': '返回短剧列表' }, '← 返回'))
      } else {
        headRight.push(h('button', { className: 'ad-btn', key: 'refresh', onClick: loadList, disabled: busy, 'aria-label': '刷新短剧列表' }, '刷新'))
      }

      children.push(
        h(
          'div',
          { className: 'ad-head', key: 'head' },
          h(DramaIcon, { size: 18 }),
          h('div', null,
            h('div', { className: 'ad-title' }, phase === 'project' ? openTitle : 'AI 短剧',
              sourcePath
                ? h('span', { className: 'ad-count', style: { marginLeft: 8, fontWeight: 400 } }, '数据源：' + shortSourcePath(sourcePath))
                : null),
            h('div', { className: 'ad-sub' },
              phase === 'project' && progress
                ? `进度：${(progress.steps.find((s) => s.key === progress.stage) || {}).label || progress.stage}` +
                  ` · 大纲 ${progress.facts.outlineCount} · 人物 ${progress.facts.characterCount} · 剧本 ${progress.facts.episodeCount} · 分镜 ${progress.facts.storyboardCount}` +
                  (progress.facts.openMemoryCount ? ` · 未回收伏笔 ${progress.facts.openMemoryCount}` : '')
                : '短剧创作中枢')),
          h('div', { style: { flex: 1 } }),
          headRight,
        ),
      )

      // T8：创作流水线常驻条（项目页签上方，数据源 progress-get）
      if (phase === 'project') children.push(renderPipelineBar(progress, refreshProgress))

      // P2-2：流程状态机步骤条（6 步 / 当前-已确认-待重做三态）+ 恢复提示 + 详情操作
      if (phase === 'project') {
        const flowCurrent = flowState ? flowCurrentKey(flowState) : ''
        const staleSteps = flowState ? FLOW_STEPS.filter(([key]) => flowState.steps[key] === 'stale') : []
        children.push(h('div', { className: 'ad-flow', key: 'flow', role: 'group', 'aria-label': '创作流程状态（P2-2）' },
          flowState
            ? FLOW_STEPS.map(([key, label], index) => {
                const status = flowState.steps[key] || 'not_started'
                const kind = status === 'confirmed' ? 'confirmed' : status === 'stale' ? 'stale' : key === flowCurrent ? 'current' : 'pending'
                const mark = kind === 'confirmed' ? '✓ ' : kind === 'stale' ? '! ' : kind === 'current' ? '● ' : '· '
                return h('button', {
                  key,
                  className: 'ad-flow-step',
                  'data-state': kind,
                  'aria-pressed': flowDetail === key ? 'true' : 'false',
                  title: `${label} · ${FLOW_STATUS_LABELS[status] || status}（点击查看 / 操作）`,
                  onClick: () => setFlowDetail(flowDetail === key ? '' : key),
                }, `${mark}${index + 1}. ${label}`)
              })
            : h('span', { className: 'ad-flow-hint' }, '流程状态：未开始（打开项目后读取 flow-state）'),
          h('span', { className: 'ad-flow-hint' }, flowState ? flowRecoveryText(flowState) : ''),
          !flowAvailable && flowState ? h('span', { className: 'ad-count' }, '只读推断（宿主接口待就绪）') : null,
          staleSteps.length ? h('span', { className: 'ad-flow-msg' }, '待重做：' + staleSteps.map(([, label]) => label).join('、')) : null,
          flowBusy ? h('span', { className: 'ad-count' }, '同步中…') : null,
          h('button', {
            className: 'ad-btn ad-sm ad-flow-mode',
            onClick: () => toggleFlowStrict(!flowStrictActive()),
            disabled: busy || flowBusy,
            'aria-label': '切换流程模式（宽松 / 强制门禁）',
            title: '切换流程模式（默认宽松：只提示不强制；强制：未确认上一阶段时宿主阻止越步写入/确认，HTTP 409）',
          }, flowStrictActive() ? '强制模式' : '宽松模式（只提示）'),
          flowMsg ? h('span', { className: 'ad-flow-msg', role: 'status' }, flowMsg) : null,
          flowError ? h('span', { className: 'ad-err' }, flowError) : null,
        ))
        const flowDetailStep = flowDetail ? FLOW_STEPS.find(([key]) => key === flowDetail) : null
        if (flowDetailStep) {
          const [detailKey, detailLabel] = flowDetailStep
          const detailStatus = flowState ? flowState.steps[detailKey] || 'not_started' : 'not_started'
          const isCurrent = flowState ? flowCurrentKey(flowState) === detailKey : false
          const hasContent = flowHasContent(detailKey)
          // AC-F1/F2：项目步由宿主初始化为 not_started，允许直接确认（其余步需 in_progress）
          const statusConfirmable = detailStatus === 'in_progress' || (detailKey === 'project' && detailStatus === 'not_started')
          const canConfirm = flowAvailable && isCurrent && statusConfirmable && hasContent && !flowBusy
          const canRollback = flowAvailable && detailStatus === 'confirmed' && !flowBusy
          const whyNot = !flowAvailable
            ? '等待宿主 flow-state 接口就绪（doc-read/doc-save 特例）'
            : detailStatus === 'confirmed'
              ? '已确认；可「撤销确认 / 回退」'
              : detailStatus === 'stale'
                ? '待重做：请先处理上游变更'
                : !isCurrent
                  ? '仅「当前进行中」的步骤可确认'
                  : !hasContent
                    ? '该步还没有内容，不能确认'
                    : ''
          children.push(h('div', { className: 'ad-flow-detail', key: 'flow-detail', role: 'group', 'aria-label': `步骤详情 ${detailLabel}` },
            h('div', null, `步骤 ${flowStepIndex(detailKey) + 1}/6 · ${detailLabel} · 状态：${FLOW_STATUS_LABELS[detailStatus] || detailStatus}`),
            whyNot ? h('div', { className: 'ad-flow-hint' }, whyNot) : null,
            h('div', { className: 'ad-row' },
              h('button', {
                className: 'ad-btn ad-primary ad-sm',
                onClick: () => confirmFlowStep(detailKey),
                disabled: !canConfirm,
                title: canConfirm ? '确认当前步骤' : (whyNot || '不可确认'),
              }, '确认本步'),
              h('button', {
                className: 'ad-btn ad-sm',
                onClick: () => rollbackFlowTo(detailKey),
                disabled: !canRollback,
                title: canRollback ? '撤销确认，下游标记待重做（二次确认）' : '仅已确认步骤可撤销确认',
              }, '撤销确认 / 回退'),
              h('button', { className: 'ad-btn ad-sm', onClick: () => setFlowDetail('') }, '关闭详情'),
              h('button', { className: 'ad-btn ad-sm', onClick: () => loadFlow(openTitle), disabled: flowBusy }, flowBusy ? '刷新中…' : '刷新流程状态'))))
        }
      }

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
            onClick: () => { setError(''); setErrorInfo(null); setRetryAction(null); setPhase('ready'); setTree(null); loadList() },
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
          h('div', { className: 'ad-skeleton-line w40' })))
      } else if (phase === 'error') {
        body.push(h('button', { className: 'ad-btn', key: 'retry', onClick: loadList }, '重试'))
      } else if (phase === 'ready') {
        // P2-1 多数据源：数据源选择器（B 阶段：宿主 sources-list；旧宿主降级 A：工作区枚举）
        body.push(
          h('div', { className: 'ad-row', key: 'source', style: { marginBottom: 12, flexWrap: 'wrap' } },
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
            h('button', { className: 'ad-btn ad-sm', onClick: () => refreshSources(), disabled: busy || sourceBusy }, sourceBusy ? '刷新中…' : '刷新数据源'),
            sourcesMode === 'legacy' ? h('span', { className: 'ad-count' }, '旧宿主降级：仅工作区') : null,
            sourcesMode === 'host' ? h('span', { className: 'ad-count' }, `共 ${sources.length} 个源`) : null,
            sourcesDegraded ? h('span', { className: 'ad-count', style: { color: 'var(--dsw-alias-label-warning,#ad6800)' } }, '部分数据源不可用') : null,
            sourcePath ? h('span', { className: 'ad-count' }, `当前：${shortSourcePath(sourcePath)}`) : null,
            !sources.length && sourcesMode !== 'loading'
              ? h('span', { className: 'ad-hint-next' }, '未枚举到数据源：将使用宿主默认源；切到含短剧项目的目录后可点「刷新数据源」')
              : null),
        )

        body.push(
          h('div', { className: 'ad-row', key: 'new', style: { marginBottom: 14 } },
            h('input', {
              className: 'ad-input',
              'aria-label': '新建短剧名称',
              placeholder: '新建短剧，例如：万界倒爷：先发育再屠神',
              value: draftTitle,
              onChange: (e) => setDraftTitle(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') createProject() },
            }),
            h('button', { className: 'ad-btn ad-primary', onClick: createProject, disabled: busy || !draftTitle.trim() }, '新建短剧')),
        )

        body.push(
          h('div', { className: 'ad-row', key: 'search', style: { marginBottom: 16 } },
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
                : h('div', { className: 'ad-empty' }, '没有命中')),
          )
        }

        body.push(h('div', { className: 'ad-sec', key: 'sec' }, `我的短剧 · ${projects.length}`))
        if (!projects.length) {
          body.push(emptyState({
            key: 'empty',
            title: '还没有短剧项目',
            description: '新建后会在工作区下生成 AI短剧/<短剧名>/ 及固定创作目录（项目 / 大纲 / 人物 / 分集剧本 / 分镜 / 导出）。',
            next: '在上方输入短剧名并点「新建短剧」；若短剧在别的目录，先切换数据源',
          }))
        }
        for (const project of projects) {
          body.push(
            h('div', { className: 'ad-card', key: project.path },
              h('div', { className: 'ad-card-main' },
                h('div', { className: 'ad-card-title' }, project.title),
                h('div', { className: 'ad-card-meta' }, `分集剧本 ${project.episodeCount || 0} 集 · ${project.path}`)),
              h('button', { className: 'ad-btn', onClick: () => openProject(project.title), disabled: busy }, '打开'),
              h('button', { className: 'ad-btn ad-sm', onClick: () => renameProject(project.title), disabled: busy }, '重命名'),
              h('button', { className: 'ad-btn ad-sm', onClick: () => deleteProject(project.title), disabled: busy }, '删除')),
          )
        }

        // 共享资料（跨项目复用，FR-A05）
        body.push(
          h('div', { key: 'shared' },
            h('div', { className: 'ad-row', style: { margin: '18px 0 8px' } },
              h('span', { className: 'ad-sec', style: { margin: 0 } }, '共享资料'),
              h('div', { style: { flex: 1 } }),
              h('button', { className: 'ad-btn ad-sm', onClick: () => loadList(), disabled: busy }, '刷新')),
            shared && shared.entries && shared.entries.length
              ? h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 6 } },
                  shared.entries.map((entry) =>
                    h('button', {
                      key: entry.name,
                      className: 'ad-btn ad-sm',
                      onClick: () => (entry.kind === 'dir' ? null : openShared(entry.name)),
                    }, (entry.kind === 'dir' ? '📁 ' : '📄 ') + entry.name)))
              : h('div', { className: 'ad-empty' }, '共享资料是跨项目复用的空间（题材库、平台规范、参考桥段），当前为空。'),
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

        // 设置（FR-F01）
        body.push(
          h('div', { key: 'settings' },
            h('div', { className: 'ad-row', style: { margin: '18px 0 8px' } },
              h('span', { className: 'ad-sec', style: { margin: 0 } }, '设置'),
              h('div', { style: { flex: 1 } }),
              h('button', { className: 'ad-btn ad-sm', onClick: () => setShowSettings((v) => !v) }, showSettings ? '收起' : '展开')),
            showSettings && settings
              ? h('div', null,
                  h(Field, { label: '默认平台', value: settings.defaultPlatform, placeholder: '抖音 / 快手 / 红果', onChange: (v) => setSettings({ ...settings, defaultPlatform: v }) }),
                  h('div', { className: 'ad-field' },
                    h('label', null, '默认单集时长'),
                    h('input', { className: 'ad-input', type: 'number', value: settings.defaultEpisodeDurationSec[0], onChange: (e) => setSettings({ ...settings, defaultEpisodeDurationSec: [Number(e.target.value), settings.defaultEpisodeDurationSec[1]] }) }),
                    h('span', null, '~'),
                    h('input', { className: 'ad-input', type: 'number', value: settings.defaultEpisodeDurationSec[1], onChange: (e) => setSettings({ ...settings, defaultEpisodeDurationSec: [settings.defaultEpisodeDurationSec[0], Number(e.target.value)] }) })),
                  h(Field, { label: '默认目标集数', value: settings.defaultTargetEpisodes, onChange: (v) => setSettings({ ...settings, defaultTargetEpisodes: Number(v) || 0 }) }),
                  h(Field, { label: '检索条数', value: settings.retrievalTopK, onChange: (v) => setSettings({ ...settings, retrievalTopK: Number(v) || 5 }) }),
                  h(Field, { label: '默认模型', value: settings.defaultModel, placeholder: '留空 = 跟随会话当前模型', onChange: (v) => setSettings({ ...settings, defaultModel: v }) }),
                  (() => {
                    // P2-6（Q5）：设置页内「任务模型」区块（不新增页签/slot；v0.6.1 仅渲染 audit）
                    // 注意：此处用原始 settings.taskModels 判断「已配置/跟随默认」（空 model 的草稿也保留输入态），
                    // 持久化前再经 normalizeTaskModels 归一化。
                    const rawModels = settings && settings.taskModels && typeof settings.taskModels === 'object' ? settings.taskModels : {}
                    const rawAudit = rawModels.audit && typeof rawModels.audit === 'object' && !Array.isArray(rawModels.audit) ? rawModels.audit : null
                    const useDefault = !rawAudit
                    const audit = rawAudit || {}
                    return h('div', { className: 'ad-box', style: { marginBottom: 10 } },
                      h('div', { className: 'ad-row', style: { marginBottom: 6, flexWrap: 'wrap' } },
                        h('span', { className: 'ad-sec', style: { margin: 0 } }, '任务模型'),
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
                        : h('div', { className: 'ad-grid', style: { marginBottom: 8 } },
                            h(Field, { label: 'Provider', value: audit.provider || '', placeholder: '留空 = 宿主默认 provider', onChange: (v) => setAuditTaskModelField('provider', v) }),
                            h(Field, { label: '审读模型', value: audit.model || '', placeholder: '必填，例如 deepseek-reasoner', onChange: (v) => setAuditTaskModelField('model', v) }),
                            h(Field, { label: 'Temperature', value: audit.temperature == null ? '' : audit.temperature, placeholder: '0~2，留空 = 宿主默认', onChange: (v) => setAuditTaskModelField('temperature', v) }),
                            h(Field, { label: 'MaxTokens', value: audit.maxTokens == null ? '' : audit.maxTokens, placeholder: '≤60000，留空 = 宿主默认 60k', onChange: (v) => setAuditTaskModelField('maxTokens', v) }),
                            h(Field, { label: '超时(ms)', value: audit.timeoutMs == null ? '' : audit.timeoutMs, placeholder: '1000~60000，留空 = 宿主默认 45s', onChange: (v) => setAuditTaskModelField('timeoutMs', v) })),
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
                      h('div', { className: 'ad-path' }, '回退链：任务模型 → 默认模型 → 宿主默认（agentDefaultModel）。模型运行时不可用时宿主降级并标记，不阻断审读。其他任务键（review/outline/characters/episode/storyboard）已预留，v0.6.1 暂不渲染。快捷键：Ctrl/⌘+S 保存当前页 / 文档，Enter 执行搜索。'))
                  })(),
                  h(Field, { label: '存储位置', value: settings.storageLocation, placeholder: '留空 = 默认位置（P1 仅持久化预留，切换存储根在 P2 生效）', onChange: (v) => setSettings({ ...settings, storageLocation: v }) }),
                  h('div', { className: 'ad-field' },
                    h('label', null, '检索增强'),
                    h('select', { className: 'ad-select', value: settings.retrievalEnabled ? 'on' : 'off', onChange: (e) => setSettings({ ...settings, retrievalEnabled: e.target.value === 'on' }) },
                      h('option', { value: 'on' }, '开启（生成前召回设定 / 伏笔）'), h('option', { value: 'off' }, '关闭'))),
                  h('div', { className: 'ad-field' },
                    h('label', null, '流程模式'),
                    h('select', {
                      className: 'ad-select',
                      value: flowStrictActive() ? 'on' : 'off',
                      onChange: (e) => toggleFlowStrict(e.target.value === 'on'),
                      disabled: busy || flowBusy,
                      'aria-label': '流程模式（宽松 / 强制门禁）',
                    },
                      h('option', { value: 'off' }, '宽松（默认，只提示不强制）'),
                      h('option', { value: 'on' }, '强制（未确认上一阶段时禁止越步写入/确认）')),
                    h('span', { className: 'ad-sub' }, '由宿主 settings.strictMode 生效')),
                  h('div', { className: 'ad-path' }, '流程状态存于 <项目>/.aidrama/flow-state.json（不随导出；回退只标「待重做」，不删除文件）'),
                  h('div', { className: 'ad-field' },
                    h('label', null, '默认画幅'),
                    h('select', { className: 'ad-select', value: settings.defaultOrientation, onChange: (e) => setSettings({ ...settings, defaultOrientation: e.target.value }) },
                      h('option', { value: 'portrait' }, '竖屏'), h('option', { value: 'landscape' }, '横屏'))),
                  h('div', { className: 'ad-sec', style: { margin: '6px 0 8px' } }, `提示词模板（${PROMPT_TEMPLATE_KEYS.length} 个环节，留空 = 内置默认）`),
                  h('div', { className: 'ad-grid', style: { marginBottom: 10 } },
                    PROMPT_TEMPLATE_KEYS.map(([key, label]) =>
                      h(TextField, {
                        key,
                        label,
                        rows: 2,
                        placeholder: `${label}环节的自定义提示词前缀（可选）`,
                        value: settings.promptTemplates[key] || '',
                        onChange: (v) => setSettings({ ...settings, promptTemplates: { ...settings.promptTemplates, [key]: v } }),
                      }))),
                  h('button', { className: 'ad-btn ad-primary', onClick: saveSettings, disabled: busy }, '保存设置'),
                  h('div', { className: 'ad-path' }, '新建短剧时会用这些默认值预填剧集契约；默认模型 / 检索开关 / 提示词模板由宿主 v0.4.0+ 校验并实际生效。存储位置 P1 只做持久化与展示（不会立即迁移已有项目目录，切换存储根在 P2 生效）。'))
              : h('div', { className: 'ad-empty' }, '这里配置新建短剧时的默认契约（平台 / 单集时长 / 目标集数 / 画幅）、默认模型、检索开关、存储位置与提示词模板。'),
          ),
        )

        body.push(
          h('div', { className: 'ad-path', key: 'path' },
            `数据源：${sourcePath || '（宿主回退默认源）'}${
              sources.some((item) => item.path === sourcePath)
                ? '（' + sourceTypeLabel((sources.find((item) => item.path === sourcePath) || {}).sourceType) + '）'
                : ''
            }${sourcesMode === 'legacy' ? '（旧宿主降级）' : ''}`,
            h('br'),
            `工作区：${(status && status.workspace) || '（未解析）'}（来源：${(status && status.workspaceSource) || '-'}）`,
            h('br'),
            `数据目录：${(status && status.root) || '-'}${status && status.exists ? '' : '（尚未创建）'}`,
            h('br'),
            `宿主版本：v${(status && status.version) || '?'}`),
        )
      } else if (phase === 'project') {
        const tabs = [
          ['contract', '剧集契约'],
          ['outline', '总纲'],
          ['characters', '人物'],
          ['world', '世界观'],
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
        body.push(
          h('div', { className: 'ad-tabs', key: 'tabs', role: 'tablist', 'aria-label': '短剧工作区页签' },
            tabs.map(([key, label]) =>
              h('button', {
                key,
                className: 'ad-tab',
                role: 'tab',
                'aria-selected': tab === key ? 'true' : 'false',
                'data-on': tab === key ? '1' : '0',
                onClick: () => switchTab(key),
              }, label))),
        )

        // P2-2：当前页签对应步骤的 stale 黄色提示（不阻止编辑）
        const tabStaleKey = flowState && FLOW_TAB_STEP[tab] ? FLOW_TAB_STEP[tab] : ''
        if (tabStaleKey && flowState && flowState.steps[tabStaleKey] === 'stale') {
          body.push(h('div', {
            className: 'ad-flow-stale',
            key: 'flow-stale',
            role: 'status',
          }, `上游已变更，建议重做「${flowStepLabel(tabStaleKey)}」（不阻止编辑，可先继续编辑后再回来确认）`))
        }

        // P2-3：审读定位横幅（跨页签可见，跳转后仍显示目标位置，可一键清除）
        if (reviewJump) {
          body.push(h('div', { className: 'ad-flow-stale', key: 'rv-jump-global', role: 'status' },
            `审读定位：${reviewLocationText(reviewJump)}（已切换到对应页签；镜号可在分镜表查看，场次可在剧本正文查看）`,
            h('button', { className: 'ad-btn ad-sm', style: { marginLeft: 10 }, onClick: () => setReviewJump(null) }, '清除定位')))
        }

        if (tab === 'contract' && contract) {
          body.push(
            h('div', { key: 'c' },
              h(Field, { label: '平台', value: contract.platform, placeholder: '抖音 / 快手 / 红果 / 微信小程序', onChange: (v) => setContract({ ...contract, platform: v }) }),
              h(Field, { label: '受众', value: contract.audience, onChange: (v) => setContract({ ...contract, audience: v }) }),
              h('div', { className: 'ad-field' },
                h('label', null, '单集时长(秒)'),
                h('input', { className: 'ad-input', type: 'number', value: contract.episodeDurationSec[0], onChange: (e) => setContract({ ...contract, episodeDurationSec: [Number(e.target.value), contract.episodeDurationSec[1]] }) }),
                h('span', null, '~'),
                h('input', { className: 'ad-input', type: 'number', value: contract.episodeDurationSec[1], onChange: (e) => setContract({ ...contract, episodeDurationSec: [contract.episodeDurationSec[0], Number(e.target.value)] }) })),
              h(Field, { label: '目标集数', value: contract.targetEpisodes, onChange: (v) => setContract({ ...contract, targetEpisodes: Number(v) || 0 }) }),
              h('div', { className: 'ad-field' },
                h('label', null, '画幅'),
                h('select', { className: 'ad-select', value: contract.orientation, onChange: (e) => setContract({ ...contract, orientation: e.target.value }) },
                  h('option', { value: 'portrait' }, '竖屏'), h('option', { value: 'landscape' }, '横屏'))),
              h(Field, { label: '钩子密度', value: contract.hookDensity, placeholder: '例如：每 30 秒一个钩子', onChange: (v) => setContract({ ...contract, hookDensity: v }) }),
              h(TextField, { label: '审核红线', rows: 3, value: contract.redlines, onChange: (v) => setContract({ ...contract, redlines: v }) }),
              h('button', { className: 'ad-btn ad-primary', onClick: saveContract, disabled: busy }, '保存契约'),
              h('div', { className: 'ad-path' }, '剧集契约是后续 AI 生成时的强约束输入（FR-B01），同时会渲染到 剧集契约.md。'),
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
              h('div', { className: 'ad-row', style: { marginBottom: 10 } },
                h('button', { className: 'ad-btn ad-sm', onClick: addRow, disabled: busy }, '+ 增加一集'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveOutline, disabled: busy }, '保存总纲')),
              h('table', { className: 'ad-table' },
                h('thead', null, h('tr', null,
                  ['集数', '标题', '一句话梗概', '开场钩子', '中段反转', '结尾悬念', '时长(秒)', ''].map((t, i) => h('th', { key: i }, t)))),
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
                          h('td', null, h('button', { className: 'ad-btn ad-sm', onClick: () => removeRow(i) }, '删'))))
                    : h('tr', null, h('td', { colSpan: 8, className: 'ad-empty' }, '还没有分集，点「增加一集」开始'))),
              ),
              rows.length ? h('div', { className: 'ad-path' }, `合计 ${rows.reduce((s, r) => s + (Number(r.estDurationSec) || 0), 0)} 秒`) : null,
            ),
          )
        }

        if (tab === 'characters') {
          body.push(
            h('div', { key: 'ch' },
              h('div', { className: 'ad-row', style: { marginBottom: 10 } },
                h('button', { className: 'ad-btn ad-sm', onClick: addCard, disabled: busy }, '+ 增加角色'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveCharacters, disabled: busy }, '保存人物卡')),
              h('div', { className: 'ad-grid' },
                characters.length
                  ? characters.map((card, i) =>
                      h('div', { className: 'ad-box', key: i },
                        h('div', { className: 'ad-row', style: { marginBottom: 8 } },
                          h('input', { className: 'ad-input', placeholder: '角色姓名', value: card.name, onChange: (e) => setCard(i, 'name', e.target.value) }),
                          h('select', { className: 'ad-select', value: card.role, onChange: (e) => setCard(i, 'role', e.target.value) },
                            ROLES.map((r) => h('option', { key: r, value: r }, r))),
                          h('button', { className: 'ad-btn ad-sm', onClick: () => removeCard(i) }, '删')),
                        h(Field, { label: '性格', value: (card.personality || []).join('、'), placeholder: '冷静、护短', onChange: (v) => setCard(i, 'personality', v) }),
                        h(Field, { label: '形象提示词', value: card.appearancePrompt, onChange: (v) => setCard(i, 'appearancePrompt', v) }),
                        h(Field, { label: '音色', value: card.voiceHint, onChange: (v) => setCard(i, 'voiceHint', v) }),
                        h(TextField, { label: '小传', rows: 3, value: card.bio, onChange: (v) => setCard(i, 'bio', v) })))
                  : h('div', { className: 'ad-empty' }, '还没有角色，点「增加角色」开始')),
            ),
          )
        }

        if (tab === 'episode') {
          const scenes = parseEpisodeScenes(episodeText)
          body.push(
            h('div', { key: 'ep' },
              h('div', { className: 'ad-row', style: { marginBottom: 10 } },
                h('label', { className: 'ad-sub' }, '集数'),
                h('input', { className: 'ad-input', style: { maxWidth: 100 }, type: 'number', value: episodeOrder, onChange: (e) => setEpisodeOrder(Number(e.target.value) || 1) }),
                h('button', { className: 'ad-btn ad-sm', onClick: () => loadEpisode(episodeOrder), disabled: busy }, '载入'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveEpisode, disabled: busy }, '保存本集'),
                dirty.episode ? dirtyMark('episode') : null,
                h('span', { className: 'ad-sub' }, 'Ctrl/⌘+S 保存'),
                episodes.length ? h('span', { className: 'ad-sub' }, `已有：${episodes.map((e) => '第' + e.order + '集').join('、')}`) : null),
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
                h('button', { className: 'ad-btn ad-sm', onClick: loadFinalized, disabled: busy }, '刷新定稿记录'),
                h('span', { className: 'ad-sub' }, '定稿会把当前剧本与分镜冻结成带版本号的快照，随时可回滚')),
              finalized.length
                ? h('table', { className: 'ad-table' },
                    h('thead', null, h('tr', null, ['集数', '最新版本', '定稿时间', '行数', '镜头数', '快照文件', '操作'].map((t, i) => h('th', { key: i }, t)))),
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
                              h('button', { className: 'ad-btn ad-sm', onClick: () => restoreFinalized(f.order, f.version), disabled: busy }, `回滚最新 v${f.version}`),
                              f.version > 1
                                ? h('button', { className: 'ad-btn ad-sm', onClick: () => restoreFinalizedVersion(f), disabled: busy }, '指定版本…')
                                : null))))))
                : h('div', { className: 'ad-empty' }, '还没有定稿记录。剧本满意后点「定稿」，形成可回滚的版本。'),
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
                            h('thead', null, h('tr', null, ['集数', '标题', '场次', '行数', '角色'].map((t, i) => h('th', { key: i }, t)))),
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

        if (tab === 'storyboard') {
          const total = shots.reduce((s, x) => s + (Number(x.durationSec) || 0), 0)
          body.push(
            h('div', { key: 'sb' },
              h('div', { className: 'ad-row', style: { marginBottom: 10 } },
                h('label', { className: 'ad-sub' }, '集数'),
                h('input', { className: 'ad-input', style: { maxWidth: 100 }, type: 'number', value: episodeOrder, onChange: (e) => setEpisodeOrder(Number(e.target.value) || 1) }),
                h('button', { className: 'ad-btn ad-sm', onClick: () => loadShots(episodeOrder), disabled: busy }, '载入'),
                h('button', { className: 'ad-btn ad-sm', onClick: addShot, disabled: busy }, '+ 增加镜头'),
                h('button', { className: 'ad-btn ad-sm', onClick: renumberShots, disabled: busy || !shots.length }, '自动重编号'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveShots, disabled: busy }, '保存分镜'),
                dirty.storyboard ? dirtyMark('storyboard') : null,
                h('span', { className: 'ad-sub' }, '↑↓ 调整顺序；保存后写入 分镜/第' + String(episodeOrder).padStart(3, '0') + '集.分镜')),
              h('table', { className: 'ad-table' },
                h('thead', null, h('tr', null,
                  ['镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长(秒)', '提示词', '视频提示词', '操作'].map((t, i) => h('th', { key: i }, t)))),
                h('tbody', null,
                  shots.length
                    ? shots.map((shot, i) =>
                        h('tr', { key: i },
                          h('td', null, h('input', { value: shot.shotNumber, onChange: (e) => setShot(i, 'shotNumber', e.target.value) })),
                          h('td', null, h('select', { value: shot.shotSize, onChange: (e) => setShot(i, 'shotSize', e.target.value) }, SHOT_SIZES.map((s) => h('option', { key: s, value: s }, s)))),
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
                              h('button', { className: 'ad-btn ad-sm', onClick: () => removeShot(i), disabled: busy }, '删')))))
                    : h('tr', null, h('td', { colSpan: 10, className: 'ad-empty' }, '本集还没有镜头，点「增加镜头」或先载入已有分镜'))),
              ),
              !hostFlags.p1
                ? h('div', { className: 'ad-warn' }, '当前宿主版本 < 0.4.0：「视频提示词」列只读展示（宿主 v0.4.0+ 才持久化；升级插件后自动可编辑）。')
                : null,
              shots.length ? h('div', { className: 'ad-path' }, `共 ${shots.length} 个镜头，合计 ${total} 秒`) : null,
            ),
          )
        }

        if (tab === 'dialogue') {
          body.push(
            h('div', { key: 'dl' },
              h('div', { className: 'ad-row', style: { marginBottom: 10 } },
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: loadDialogue, disabled: busy }, '汇总台词'),
                h('button', { className: 'ad-btn ad-sm', onClick: exportVoiceScript, disabled: busy }, '导出配音稿'),
                h('span', { className: 'ad-sub' }, '从分集剧本自动抽取「角色：台词」，音效取自分镜表')),
              dialogue
                ? h('div', null,
                    h('div', { className: 'ad-sec', style: { marginTop: 4 } }, `角色戏份 · ${dialogue.byCharacter.length} 人 / ${dialogue.lines.length} 句`),
                    h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 6, marginBottom: 12 } },
                      dialogue.byCharacter.map((c) =>
                        h('span', { className: 'ad-count', key: c.character },
                          `${c.character} ${c.count} 句（第 ${c.episodes.join('、')} 集）`))),
                    h('div', { className: 'ad-sec' }, '逐句台词'),
                    h('div', { className: 'ad-hits', style: { maxHeight: 320, overflow: 'auto' } },
                      dialogue.lines.slice(0, 200).map((l, i) =>
                        h('div', { className: 'ad-hit', key: i },
                          h('div', { className: 'ad-hit-path' }, `第 ${l.episode} 集 · ${l.scene || '—'}`),
                          h('div', null, h('strong', null, l.character + '：'), l.text)))),
                    dialogue.lines.length > 200 ? h('div', { className: 'ad-count' }, `（仅显示前 200 句，共 ${dialogue.lines.length} 句）`) : null,
                    dialogue.sfx.length
                      ? h('div', null,
                          h('div', { className: 'ad-sec' }, `音效 · ${dialogue.sfx.length} 条`),
                          h('div', { className: 'ad-hits' },
                            dialogue.sfx.slice(0, 100).map((s, i) =>
                              h('div', { className: 'ad-hit', key: i },
                                h('div', { className: 'ad-hit-path' }, `第 ${s.episode} 集 · ${s.shotNumber}`),
                                h('div', null, s.sfx)))))
                      : null)
                : h('div', { className: 'ad-empty' }, '点「汇总台词」把全剧对白按角色归集，并生成可交付的配音稿。')),
          )
        }

        if (tab === 'assets') {
          body.push(
            h('div', { key: 'as' },
              h('div', { className: 'ad-row', style: { marginBottom: 6 } },
                h('input', { className: 'ad-input', placeholder: '素材文件绝对路径，例如 D:\\素材\\shot-1-1.png', value: assetSource, onChange: (e) => setAssetSource(e.target.value) }),
                h('input', { className: 'ad-input', style: { maxWidth: 160 }, placeholder: '关联镜号 1-1、1-2', value: assetShots, onChange: (e) => setAssetShots(e.target.value) }),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: addAsset, disabled: busy || !assetSource.trim() }, '登记'),
                h('button', { className: 'ad-btn ad-sm', onClick: loadAssets, disabled: busy }, '刷新')),
              h('div', { className: 'ad-sub', style: { marginBottom: 10 } }, '只登记路径与校验信息，**不复制原始文件**（大文件不会塞进项目目录）'),
              h('table', { className: 'ad-table' },
                h('thead', null, h('tr', null, ['名称', '类型', '大小', '关联镜头', '校验', '路径', ''].map((t, i) => h('th', { key: i }, t)))),
                h('tbody', null,
                  assets.length
                    ? assets.map((a) =>
                        h('tr', { key: a.id },
                          h('td', null, a.name),
                          h('td', null, a.kind),
                          h('td', null, (a.bytes / 1024).toFixed(1) + ' KB'),
                          h('td', null, (a.linkedShots || []).join('、') || '—'),
                          h('td', { title: a.sha256 || '未计算' }, a.sha256 ? a.sha256.slice(0, 8) : '—'),
                          h('td', { style: { maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }, title: a.source }, a.source),
                          h('td', null, h('button', { className: 'ad-btn ad-sm', onClick: () => removeAsset(a.id) }, '移除'))))
                    : h('tr', null, h('td', { colSpan: 7, className: 'ad-empty' }, '还没有登记素材。出图/出片后把文件路径登记进来，就能和镜号对上。')))),
          ))
        }

        if (tab === 'memory') {
          body.push(
            h('div', { key: 'mem' },
              h('div', { className: 'ad-row', style: { marginBottom: 10 } },
                h('button', { className: 'ad-btn ad-sm', onClick: addMem, disabled: busy }, '+ 增加条目'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveMemory, disabled: busy }, '保存本剧记忆'),
                h('span', { className: 'ad-sub' }, '伏笔 / 已用桥段 / 时间线 / 待回收 —— 生成前先读这里可避免重复与冲突')),
              h('table', { className: 'ad-table' },
                h('thead', null, h('tr', null, ['类型', '内容', '集数', '状态', ''].map((t, i) => h('th', { key: i }, t)))),
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
                          h('td', null, h('button', { className: 'ad-btn ad-sm', onClick: () => removeMem(i) }, '删'))))
                    : h('tr', null, h('td', { colSpan: 5, className: 'ad-empty' }, '还没有记忆条目。记下伏笔和已用桥段，后续生成才不会撞车。')))),
              h('div', { className: 'ad-path' }, '保存后会同时渲染到 本剧记忆/本剧记忆.md'),
            ),
          )
        }

        if (tab === 'world') {
          body.push(
            h('div', { key: 'wd' },
              h('div', { className: 'ad-row', style: { marginBottom: 10 } },
                h('button', { className: 'ad-btn ad-sm', onClick: addWorldEntry, disabled: busy }, '+ 增加设定'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: saveWorld, disabled: busy }, '保存世界观'),
                h('span', { className: 'ad-sub' }, '地点 / 组织 / 规则 / 道具 / 时间线 —— 分集剧本与分镜会引用这些设定')),
              h('table', { className: 'ad-table' },
                h('thead', null, h('tr', null, ['类型', '名称', '说明', ''].map((t, i) => h('th', { key: i }, t)))),
                h('tbody', null,
                  world.length
                    ? world.map((entry, i) =>
                        h('tr', { key: i },
                          h('td', null, h('select', { value: entry.kind, onChange: (e) => setWorldEntry(i, 'kind', e.target.value) },
                            ['地点', '组织', '规则', '道具', '时间线'].map((k) => h('option', { key: k, value: k }, k)))),
                          h('td', null, h('input', { value: entry.name, onChange: (e) => setWorldEntry(i, 'name', e.target.value) })),
                          h('td', null, h('textarea', { rows: 2, value: entry.detail, onChange: (e) => setWorldEntry(i, 'detail', e.target.value) })),
                          h('td', null, h('button', { className: 'ad-btn ad-sm', onClick: () => removeWorldEntry(i) }, '删'))))
                    : h('tr', null, h('td', { colSpan: 4, className: 'ad-empty' }, '还没有世界观设定。先把地点与规则定下来，后面写剧本才不会自相矛盾。')))),
              h('div', { className: 'ad-path' }, '保存后会同时渲染到 世界观/世界观.md'),
            ),
          )
        }

        if (tab === 'drafts') {
          const allSelected = pendingDrafts.length > 0 && selectedDraftIds.length === pendingDrafts.length
          body.push(
            h('div', { key: 'dr' },
              h('div', { className: 'ad-row', style: { marginBottom: 8, flexWrap: 'wrap' } },
                h('button', { className: 'ad-btn ad-sm', onClick: () => loadDrafts(false), disabled: busy }, '刷新待处理'),
                h('button', { className: 'ad-btn ad-sm', onClick: () => loadDrafts(true), disabled: busy }, '含已处理'),
                hostFlags.p1 && pendingDrafts.length
                  ? h('button', { className: 'ad-btn ad-sm', onClick: toggleSelectAllDrafts, disabled: busy }, allSelected ? '取消全选' : `全选待处理（${pendingDrafts.length}）`)
                  : null,
                hostFlags.p1
                  ? h('button', { className: 'ad-btn ad-primary ad-sm', onClick: () => batchResolveDrafts('accept'), disabled: busy || !selectedDraftIds.length }, `批量采纳（${selectedDraftIds.length}）`)
                  : null,
                hostFlags.p1
                  ? h('button', { className: 'ad-btn ad-sm', onClick: () => batchResolveDrafts('discard'), disabled: busy || !selectedDraftIds.length }, `批量丢弃（${selectedDraftIds.length}）`)
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
                          ? h('button', { className: 'ad-btn ad-sm', onClick: () => resolveDraft(draft.id, 'discard'), disabled: busy }, '丢弃')
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
                : h('div', { className: 'ad-empty' }, '草稿区是空的。在「短剧模式」会话里让 Agent 生成内容后，会出现在这里等你采纳。')),
          )
        }

        if (tab === 'ledger') {
          body.push(
            h('div', { key: 'lg' },
              h('div', { className: 'ad-row', style: { marginBottom: 10 } },
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: loadLedger, disabled: busy }, '生成账本'),
                h('span', { className: 'ad-sub' }, '从剧本与分镜推导：场景 / 内外景 / 镜头 / 时长 / 角色 / 地点 + 成本提示')),
              ledger
                ? h('div', null,
                    h('div', { className: 'ad-sec', style: { marginTop: 4 } }, '合计'),
                    h('div', { className: 'ad-count', style: { marginBottom: 10 } },
                      `集数 ${ledger.totals.episodes} · 场景 ${ledger.totals.scenes} · 镜头 ${ledger.totals.shots} · 总时长 ${ledger.totals.durationSec}s（约 ${(ledger.totals.durationSec / 60).toFixed(1)} 分钟）· 角色 ${ledger.totals.characters.length} 人 · 地点 ${ledger.totals.locations.length} 处`),
                    h('table', { className: 'ad-table' },
                      h('thead', null, h('tr', null, ['集数', '场景', '内景', '外景', '镜头', '时长(秒)', '出场角色', '地点'].map((t, i) => h('th', { key: i }, t)))),
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
                      : h('div', { className: 'ad-empty' }, '未发现明显成本风险。'),
                    h('div', { className: 'ad-path' }, '同时渲染到 账本/账本.md'))
                : h('div', { className: 'ad-empty' }, '点「生成账本」看全剧的场景、镜头、时长与成本结构。')),
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
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: loadGenerate, disabled: busy }, '刷新状态'),
                h('span', { className: 'ad-sub' }, '主选 LibTV（画布 CLI），备选 NeoWoW（CLI）')),

              h('div', { className: 'ad-sec' }, '① 画布绑定'),
              binding
                ? (binding.ok
                    ? h('div', { className: 'ad-count' }, `已绑定：${binding.uuid}`)
                    : h('div', null,
                        h('div', { className: 'ad-empty' }, binding.detail),
                        h('div', { className: 'ad-path' }, binding.fix || '')))
                : h('div', { className: 'ad-empty' }, '点「刷新状态」查看绑定情况。'),
              canvases.length
                ? h('div', { className: 'ad-hits', style: { maxHeight: 180, overflow: 'auto', marginTop: 6 } },
                    canvases.slice(0, 30).map((c) =>
                      h('div', { className: 'ad-hit', key: c.uuid, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                        h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, `${c.name} · ${c.uuid.slice(0, 8)}`),
                        h('button', { className: 'ad-btn ad-sm', onClick: () => bindCanvas(c.uuid), disabled: busy }, '绑定'))))
                : h('div', { className: 'ad-empty' }, '没读到候选画布（LibTV CLI 不可用时为空）。'),

              h('div', { className: 'ad-sec' }, '② 预算护栏'),
              genBudget
                ? h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 8, marginBottom: 8 } },
                    h('span', { className: 'ad-count' },
                      `上限 ${genBudget.limitPoints == null ? '未设' : genBudget.limitPoints} · 已消耗 ${genBudget.spentPoints} · 剩余 ${genBudget.remainingPoints == null ? '—' : genBudget.remainingPoints}`),
                    h('input', { className: 'ad-input ad-sm', style: { width: 110 }, placeholder: '上限（空=取消）', value: genLimit, onChange: (e) => setGenLimit(e.target.value) }),
                    h('button', { className: 'ad-btn ad-sm', onClick: saveBudget, disabled: busy }, '保存'))
                : h('div', { className: 'ad-empty' }, '点「刷新状态」读取预算。'),

              h('div', { className: 'ad-sec' }, `③ 任务（${genTasks.length}）`),
              genTasks.length
                ? h('table', { className: 'ad-table' },
                    h('thead', null, h('tr', null, ['集', '类型', '模型', '状态', '预估', '实际', '产物'].map((t, i) => h('th', { key: i }, t)))),
                    h('tbody', null,
                      genTasks.slice(0, 30).map((t) =>
                        h('tr', { key: t.id },
                          h('td', null, t.episode == null ? '—' : t.episode),
                          h('td', null, t.kind),
                          h('td', null, t.model || '—'),
                          h('td', null, t.status),
                          h('td', null, t.estimatePoints == null ? '—' : t.estimatePoints),
                          h('td', null, t.actualPoints == null ? '—' : t.actualPoints),
                          h('td', null, String((t.artifacts || []).length))))))
                : h('div', { className: 'ad-empty' }, '还没有生成任务。'),

              h('div', { className: 'ad-sec' }, `④ 批次（当前集 第 ${episodeOrder} 集）`),
              h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 8, marginBottom: 8 } },
                h('select', { className: 'ad-input ad-sm', value: genKind, onChange: (e) => setGenKind(e.target.value) },
                  h('option', { value: 'image' }, '分镜图'),
                  h('option', { value: 'video' }, '分镜视频'),
                  h('option', { value: 'audio' }, '配音')),
                h('input', { className: 'ad-input ad-sm', style: { width: 200 }, placeholder: '模型名（可留空）', value: genModel, onChange: (e) => setGenModel(e.target.value) }),
                h('button', { className: 'ad-btn ad-sm', onClick: planBatch, disabled: busy }, '规划（不触发）'),
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: submitBatch, disabled: busy || !genPlan }, '提交'),
                h('button', { className: 'ad-btn ad-sm', onClick: collectBatch, disabled: busy }, '收敛取产物')),
              genPlan
                ? h('div', null,
                    h('div', { className: 'ad-count', style: { marginBottom: 6 } },
                      `已规划 ${genPlan.count} 项 · 预估 ${genPlan.estimatePoints || 0} 积分 · 预算闸门 ${genPlan.quota.ok ? '通过' : '拦截'}`),
                    genPlan.quota.detail ? h('div', { className: 'ad-empty' }, genPlan.quota.detail) : null,
                    h('div', { className: 'ad-hits', style: { maxHeight: 200, overflow: 'auto' } },
                      genPlan.items.map((it) =>
                        h('div', { className: 'ad-hit', key: it.shotNumber },
                          h('div', { className: 'ad-hit-path' }, `${it.name} · ${it.params.ratio}`),
                          h('div', null, it.prompt)))))
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
          const reviewFindings = (reviewReport && reviewReport.findings) || []
          const reviewFilterKey = reviewDimensionFilter || ''
          const reviewFiltered = reviewFindings.filter((finding) => !reviewFilterKey || finding.dimension === reviewFilterKey)
          const reviewSorted = sortReviewFindings(reviewFiltered, reviewSort)
          const reviewGroups = REVIEW_SEVERITY_ORDER
            .map((sevKey) => ({ sev: sevKey, items: reviewSorted.filter((finding) => finding.severity === sevKey) }))
            .filter((group) => group.items.length)
          const reviewDimensionOptions = Object.entries(REVIEW_DIMENSION_LABELS)
            .map(([key, label]) => ({ key, label, count: reviewFindings.filter((finding) => finding.dimension === key).length }))
            .filter((option) => option.count > 0)
          const reviewSeverityCounts = REVIEW_SEVERITY_ORDER.reduce((counts, sevKey) => {
            counts[sevKey] = reviewFindings.filter((finding) => finding.severity === sevKey).length
            return counts
          }, {})
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
              h('div', { className: 'ad-row', style: { marginBottom: 10 } },
                h('button', { className: 'ad-btn ad-primary ad-sm', onClick: runCheck, disabled: busy }, '运行一致性检查'),
                h('span', { className: 'ad-sub' }, '契约完整性 / 集数一致性 / 说话人 / 分镜时长 / 镜号 / 缺口 / 重复桥段')),
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
                      : h('div', { className: 'ad-empty' }, '未发现问题。'))
                : h('div', { className: 'ad-empty' }, '点上面的按钮开始检查。'),

              h('div', { className: 'ad-sec', key: 'rv-sec' }, '最新审读报告（AI 深度审读 · 面板只展示，触发由 Agent 完成）'),
              h('div', { className: 'ad-row', key: 'rv-bar', style: { marginBottom: 8, flexWrap: 'wrap' } },
                h('button', { className: 'ad-btn ad-sm', onClick: () => loadReview({ notice: true }), disabled: busy || reviewBusy }, reviewBusy ? '读取中…' : '刷新审读报告'),
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
                    h('div', { className: 'ad-hint-next' }, '快捷键：Ctrl/⌘+S 保存当前页 / 文档；Enter 执行搜索；点「跳转定位」可跳到对应集/场/镜'))
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
                h('button', { className: 'ad-btn ad-sm', onClick: () => runExport('csv'), disabled: busy }, 'CSV 分镜表')),
              h('div', { className: 'ad-path', key: 'exn' },
                'CSV 分镜表含镜号 / 景别 / 运镜 / 画面 / 台词 / 音效 / 时长（宿主 v0.4.0+ 追加「视频提示词」列）。'),
              exported.length
                ? h('div', { className: 'ad-path', key: 'exl' },
                    exported.map((item) => h('div', { key: item.format }, `${item.format} · ${item.relative} · ${item.bytes} 字节`)))
                : null,
            ),
          )
        }

        if (tab === 'toolcards') {
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
          body.push(
            h('div', { key: 'tc' },
              h('div', { className: 'ad-sec', style: { marginTop: 0 } }, '创作流水线（数据源 progress-get，与 drama_get_progress 一致）'),
              renderPipelineBar(progress, refreshProgress),
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
                h('button', { className: 'ad-btn ad-sm', onClick: refreshTree, disabled: busy }, '刷新')),
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
                        ? h('button', { className: 'ad-btn ad-sm', onClick: () => renameEntry(node.name), disabled: busy, title: '重命名一级节点' }, '重命名')
                        : null,
                      !required
                        ? h('button', { className: 'ad-btn ad-sm', onClick: () => deleteEntry(node.name), disabled: busy, title: '删除一级节点' }, '删除')
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
            h('div', { className: 'ad-body', key: 'body' }, body)),
          docPane,
        ),
      )
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
      },
    }
  },
})
