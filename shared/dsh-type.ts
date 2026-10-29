/**
 * dsh 的 `server-response` 信封里 `result` 字段。
 * 完整线上报文是 `{ type:'server-response', rpcId, result }`，rpcId 由 Host 原样带回。
 * 业务失败同样是 HTTP 200，只是 `ok:false`，要看 `error.code`（如 session/not-found）而不是状态码。
 */
export interface RpcBody<T> {
    /** ok:true 时承载业务返回值；ok:false 时为空 */
    result?: {
        /** 业务是否成功；传输层的 401/403/415/404 与它无关 */
        ok?: boolean;
        /** 成功时的返回值，即 Host 方法的业务结果 */
        value?: T;
        /** 失败时的结构化错误：code 稳定可判别，details 由 code 决定形状 */
        error?: { message?: string; code?: string; details?: unknown };
    };
}

/** session/create 的返回值：新会话（或复用）的 id 与实际采用的 agent 预设。 */
export interface sessionCreateValue {
    /** 会话 id，形如 session-0199...；指定 sessionId 不可复用时 Host 可能返回另一个 id */
    sessionId: string;
    /** 本次采用的 agent 预设；省略则用 dsh 配置默认值，可能不等于请求里传的值 */
    agentPreset?: string;
}

/**
 * 前端调`POST /api/createSession` 拿到的宽松响应形状。
 * 后端可能扁平返回 `{sessionId}`，也可能返回带 result 信封的形式，前端两种都兼容。
 */
export interface createResponse {
    /** 扁平形式：会话 id */
    sessionId?: string;
    /** 扁平形式：agent 预设 */
    agentPreset?: string;
    /** 信封形式：dsh 原始 result */
    result?: { ok?: boolean; value?: { sessionId?: string } };
    /** 信封形式：错误信息 */
    error?: string;
}

/** 前端聊天列表里的一条消息（纯 UI 模型，不来自 dsh）。 */
export interface chatMessage {
    /** 本地生成的渲染 key，通常用 crypto.randomUUID() */
    id: string;
    /** user=用户输入；assistant=dsh 回复；command=斜杠命令的执行结果；error=请求/解析失败 */
    role: 'user' | 'assistant' | 'command' | 'error';
    /** 气泡正文 */
    text: string;
}

/**
 * `POST /api/command` 的响应。
 * 成功时是 commands/execute 的 result；后端判为未知命令时返回 400 + error。
 */
export interface commandResponse {
    /** success=命令执行成功；error=命令 handler 返回失败 */
    kind?: 'success' | 'error';
    /** 可直接展示给用户的结果文本，例如 "preset danger-full-access" */
    text?: string;
    /** 更丰富的领域事件 seq，供客户端自己渲染卡片 */
    sourceEventSeq?: number;
    /** HTTP 层错误（参数缺失、命令不存在、dsh 调用失败） */
    error?: string;
}

/**
 * `POST /api/sendmessage` 的响应。
 * 只表示消息已进入 dsh 收件箱；正文由前端轮询 `GET /api/reply` 获取。
 */
export interface sendResponse {
    /** accepted=true 表示 session/prompt 已接收 */
    accepted?: true;
    /** 本次消息的客户端 id，轮询 /api/reply 时原样带回 */
    requestId?: string;
    /** 失败时的错误信息 */
    error?: string;
}

/**
 * `GET /api/reply` 的响应：对某一轮回复的单次查询结果。
 * 后端每次只查一次，不在请求里等待。
 */
export interface replyResponse {
    /** true=本轮已结束，text/reason 可用；false 或缺失=还在跑，继续轮询 */
    done?: boolean;
    /** 本轮 assistant 文本（按 assistant/message 拼接） */
    text?: string;
    /** turn/end 的结束原因：completed / aborted / blocked / error / max-tokens ... */
    reason?: string;
    /** 失败时的错误信息 */
    error?: string;
}

/**
 * session/prompt 的请求参数（args.request）。
 * 只是把消息放进收件箱，Host 立即回执，AI 正文不在这里。
 */
export interface sessionPromptRequest {
    /** 客户端生成的唯一 id；持久化在 user/message.source.rpcId 上，重试复用同一个是幂等的 */
    requestId: string;
    /** 目标会话 id */
    sessionId: string;
    /** queue=排队等当前轮结束；steer=尝试改变当前执行方向 */
    mode: 'queue' | 'steer';
    /** 至少一个非空白 text 块或附件；全空白会被拒（gateway/bad-request） */
    content: Array<{ type: 'text'; text: string }>;
    /** 客户端时区，如 Asia/Shanghai、UTC；可选 */
    clientTimeZone?: string;
}

/** session/prompt 的返回值：只表示消息已入收件箱，没有正文。 */
export interface sessionPromptValue {
    /** 已接收回执 */
    accepted: true;
}

/**
 * 会话投影（session/projections 与 session/list 里的 values）：
 * 已折叠的状态快照，不是完整历史。未出现的 key 表示该能力未装配或未知。
 */
export interface sessionProjectionView {
    /** 权限投影：currentValue 是当前预设，如 workspace-write、danger-full-access、auto、custom */
    permissions?: { currentValue?: string };
    /** 最近几轮的摘要，按轮次顺序；prompt 是用户输入，response 是助手回复 */
    turnOutline?: Array<{ turn: number; seq: number; prompt?: string; response?: string }>;
    /** 会话标题 */
    title?: string;
    /** 其余投影 key：goal、todos、plan、inbox、modelSelection、tokenUsage、sessionStats、workingDirectory 等 */
    [key: string]: unknown;
}

/**
 * session/projections 的返回值（源码 SessionProjectionsValue）：
 * - sequenced：正常结果，asOfSeq 是精确日志游标，可直接当 session/page 的 throughSeq
 * - migration-required：旧格式会话，需要先打开/迁移，没有 asOfSeq，不能拿去分页
 * - null：会话不存在
 */
export type sessionProjectionsValue =
    | { asOfSeq: number; values: sessionProjectionView }
    | null;

/** session/list 里的一行会话摘要（源码 SessionSummary），列出时不会启动或恢复 agent。 */
export interface sessionSummary {
    /** 会话 id */
    sessionId: string;
    /** 当前是否有 agent 正在跑这一轮 */
    running: boolean;
    /** 是否还是没开始过的空会话（折叠前缀里没有任何 turn） */
    blank: boolean;
    /** 最后一条人写消息的时间，毫秒时间戳，列表按它排序 */
    updatedAt: number;
    /** 会话工作目录；创建时未指定则是 dsh 默认工作区 */
    cwd?: string;
    /** 当前是否持有活着的 agent；冷会话也可能为 true */
    agentAvailable?: boolean;
    /** 子会话才会出现：父会话 id */
    parentSessionId?: string;
    /** 子会话来源标记，普通会话为空 */
    origin?: 'subagent';
    /** 投影提示：只是可能过期的快照，精确读取请用 session/projections */
    projections?: {
        /** sequenced=来自当前 Host 实时注册表；cached=来自持久化缓存，asOfSeq 水位不可与实时连接比较 */
        kind?: 'cached' | 'sequenced';
        /** 该块的日志水位；kind 决定它属于哪个序列空间 */
        asOfSeq?: number;
        /** 已有的投影值；缺的 key 表示未知 */
        values?: sessionProjectionView;
    };
}

/** session/list 的返回值。注意该方法的 args 形参名是 `_request`（可带 cursor，当前实现未使用）。 */
export interface sessionListValue {
    /** 会话摘要数组 */
    items: sessionSummary[];
}

/**
 * session/page 返回的一条原始日志记录（源码 SessionHistoryRecord = SessionEventEntry）。
 * records 里是所有事件，不只是消息：还有 step/start、tool/call、turn/end 等。
 */
export interface PageRecord {
    /** 固定为 'event'，目前只有这一种记录 */
    type: 'event';
    /** 一条原始会话事件 */
    event: {
        /** 事件名：turn/start、step/start、step/end、user/message、assistant/message、tool/call、tool/result、turn/end、command/run、command/done ... */
        type: string;
        /** 会话内连续递增的序号，用于排序、切片（user.seq < assistant.seq < end.seq） */
        seq: number;
        /** 事件写入时间，毫秒时间戳 */
        time?: number;
        /** 事件负载，形状由 type 决定 */
        data?: {
            /** 消息来源；user/message 是 {kind:'user', rpcId}，assistant 是 {kind:'model'} */
            source?: { kind?: string; rpcId?: string; provider?: string; model?: string };
            /** user/message 的正文直接挂在 data.content 上 */
            content?: Array<{ type: string; text?: string }>;
            /** assistant/message、tool/result 的正文在 data.message.content 上 */
            message?: { content?: Array<{ type: string; text?: string }> };
            /** turn/end 的结束原因 */
            reason?: { kind?: string };
            /** command/run */
            commandId?: string;
            name?: string;
            args?: string;
            /** command/done：kind=success|error，text 是可展示结果 */
            kind?: string;
            text?: string;
            /** session/title */
            title?: string;
            turn?: number;
            step?: number;
        };
        /** 消息事件在压缩/替换时可能不是 append，先按未知处理 */
        surfaceOp?: string;
    };
}

/** session/page 的返回值：一页（从后往前）的历史事件。 */
export interface sessionPageValue {
    /** 本页事件，按 seq 升序 */
    records: PageRecord[];
    /** 为 true 时，用本页第一条的 seq 作为下一次的 beforeSeq 继续往前翻 */
    hasMore: boolean;
}

/**
 * commands/execute 的返回值（源码 CommandExecution）。
 * 语法错误或命令不存在时返回 undefined（不抛错）；每次执行会在日志写一对 command/run + command/done。
 */
export interface commandExecution {
    /** 与 command/run、command/done 配对的生命周期 id */
    commandId: string;
    result: {
        /** success=命令执行成功；error=handler 抛错或被中断 */
        kind: 'success' | 'error';
        /** 直接展示给用户的文本；error 时必有 */
        text?: string;
        /** 更丰富的领域事件 seq，供客户端自己渲染卡片 */
        sourceEventSeq?: number
    };
}

/** 权限预设目录里的一项（源码 PresetOption）。 */
export interface permissionOption {
    /** 稳定取值：配置的预设 key、live 的 auto，或推导出的 custom */
    value: string;
    /** 展示名称 */
    name: string;
    /** 一句话说明；未配置时省略 */
    description?: string;
}

/** permissionPresets/catalog 的返回值。该方法是进程级的，会随实时装配变化，与会话历史无关。 */
export interface permissionCatalog {
    /** 当前所有可选项，按注册顺序 */
    options: permissionOption[];
    /** 可作为“未来会话默认值”的配置项 */
    defaultOptions: permissionOption[];
    /** 配置缺省时实际生效的默认预设 */
    defaultPreset: string;
}

/** commands/list 返回的一条斜杠命令描述（源码 CommandDescriptor）。 */
export interface commandDescriptor {
    /** 插件自有的稳定标识；没有基于身份的客户端行为时可省略 */
    definitionId?: string;
    /** 小写命令名，不带前导斜杠（调用时自己拼 `/name`） */
    name: string;
    /** 供发现界面使用的说明 */
    description: string;
    /** 可选自由输入的元信息 */
    input?: {
        /** 用户输入前的占位提示 */
        hint: string;
        /** 是否允许携带附件；缺省/false 表示执行器会拒绝带附件的调用 */
        attachments?: boolean
    }
}

/** 审批决定 */
export type approvalDecision = 'allowed-once' | 'rejected';

/** dsh 人工审核的接口信息 */
export interface approvalRequest {
    /** Host 生成的事件 ID */
    eventId: string;
    /** 发起审批的对话ID */
    sessionId: string;
    /** 需要审批的工具名 */
    toolName: string;
    /** 具体的工具调用的id */
    callId?: string;
    /** 给出的可读的原因 */
    reason?: string;
    /** 收到的请求的时间 */
    receivedAt: number;
}

/** POST /api/approvals/:eventId 的响应 */
export interface approvalResponse {
    accepted?: true;
    error?: string
};

/** ask_user_question 的一个选项 */
export interface questionOption {
    label: string;
    description?: string;
}

/** 一个待回答的问题 */
export interface questionItem {
    id: string;
    question: string;
    header?: string;
    detail?: string;
    /** 没有options时前端则显示自由输入 */
    options?: questionOption[];
    /** 是否允许多选 */
    multiSelect?: boolean;
}

/** 用户选择的一条回答。selected 里放的是 option 的 label。 */
export interface questionAnswerItem {
    id: string;
    selected: string[];
    custom?: string;
}

/** 一条待回答的问题 来自user-questions/request */
export interface pendingQuestion {
    eventId: string;
    sessionId: string;
    questions: questionItem[];
    receivedAt: number;
}

/** 请求回复 */
export interface questionResponse {
    accepted?: true;
    error?: string;
}

// ============================ 历史会话 ============================

/** GET /api/sessions 的一行：清洗过的会话摘要（已滤掉子会话和空会话）。 */
export interface sessionListItem {
    sessionId: string;
    /** 展示标题：title 投影 → 首轮 prompt 截断 → sessionId 尾号 */
    title: string;
    /** 最后一条人写消息的时间，毫秒 */
    updatedAt: number;
    /** 会话工作目录；resume 时要原样带回去 */
    cwd?: string;
    /** 当前是否有轮次正在跑 */
    running: boolean;
}

/** GET /api/sessions 的响应 */
export interface sessionsResponse {
    items?: sessionListItem[];
    error?: string;
}

/** POST /api/resume 的响应：adopt 之后以返回的 sessionId 为准 */
export interface resumeResponse {
    sessionId?: string;
    agentPreset?: string;
    error?: string;
}

/** GET /api/history 的一页历史消息（升序） */
export interface historyResponse {
    sessionId?: string;
    messages?: chatMessage[];
    /** 还有更早的消息没翻出来 */
    hasMore?: boolean;
    /** 本页最早一条的日志 seq，加载更早时作为 beforeSeq 回传 */
    oldestSeq?: number;
    error?: string;
}

// ============================ 需求清单 ============================

/** 一条需求：来自 REQUIREMENTS_JSON_PATH 指向的 JSON*/
export interface requirementItem {
    /** Key 字段；缺失时用 work itemID 或 R-序号兜底 */
    key: string;
    /** 源 JSON 的 work item ID 字段 */
    workItemID?: string;
    /** summary 字段 */
    summary: string;
    /** prd 字段：文本、文档路径或 URL 都按原值展示 */
    prd?: string;
    /** 模块字段，前端按它分组 */
    module?: string;
    /** 后端按 work item ID（其次 Key）匹配到的 HTML 文件路径：相对 JSON 所在目录 */
    requirement_content_path?: string;
}

/** GET /api/requirements 的响应。 */
export interface requirementsResponse {
    items?: requirementItem[];
    error?: string;
}
