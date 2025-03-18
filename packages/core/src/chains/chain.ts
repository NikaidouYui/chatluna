import { EventEmitter } from 'events'
import { Context, h, Logger, Session } from 'koishi'
import {
    ChatLunaError,
    ChatLunaErrorCode,
    setErrorFormatTemplate
} from 'koishi-plugin-chatluna/utils/error'
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
import { Config } from '../config'
import { lifecycleNames } from '../middlewares/lifecycle'

let logger: Logger

/**
 * ChatChain 核心类 - 实现基于中间件的消息处理链
 * 
 * 主要职责：
 * 1. 管理中间件依赖关系图
 * 2. 处理消息接收和命令执行
 * 3. 协调中间件的执行顺序
 * 4. 统一处理错误和消息发送
 * 
 * 功能特性：
 * - 支持拓扑排序确定中间件执行顺序
 * - 提供消息发送的多种模式（普通/合并转发）
 * - 内置超时处理和消息撤回机制
 * - 完善的错误处理和日志记录
 */
export class ChatChain {
    public readonly _graph: ChatChainDependencyGraph
    private readonly _senders: ChatChainSender[]
    private isSetErrorMessage = false

    /**
     * 初始化聊天链实例
     * @param ctx Koishi 上下文对象
     * @param config 插件配置
     * 
     * 初始化流程：
     * 1. 创建日志记录器
     * 2. 初始化依赖关系图
     * 3. 注册默认消息发送器
     */
    constructor(
        private readonly ctx: Context,
        private readonly config: Config
    ) {
        logger = createLogger(ctx)
        this._graph = new ChatChainDependencyGraph()
        this._senders = []

        const defaultChatChainSender = new DefaultChatChainSender(config)

        this._senders.push((session, messages) =>
            defaultChatChainSender.send(session, messages)
        )
    }

    /**
     * 处理接收到的消息
     * @param session 会话对象
     * @param ctx 可选上下文对象（默认使用实例上下文）
     * @returns 处理结果（是否成功）
     * 
     * 处理流程：
     * 1. 初始化中间件上下文
     * 2. 设置消息撤回处理逻辑
     * 3. 执行中间件链
     * 4. 清理超时处理
     */
    async receiveMessage(session: Session, ctx?: Context) {
        const context: ChainMiddlewareContext = {
            config: this.config,
            message: session.content,
            ctx: ctx ?? this.ctx,
            session,
            options: {},
            send: (message) => this.sendMessage(session, message),
            recallThinkingMessage: async () => {}
        }

        context.recallThinkingMessage = async () => {
            if (!context.options?.thinkingTimeoutObject) return

            const timeoutObj = context.options.thinkingTimeoutObject

            // 清理所有定时器
            clearTimeout(timeoutObj.timeout!) // 清理主超时定时器
            timeoutObj.autoRecallTimeout && 
                clearTimeout(timeoutObj.autoRecallTimeout) // 清理自动撤回定时器

            // 执行撤回回调函数（如果存在）
            timeoutObj.recallFunc && (await timeoutObj.recallFunc())

            // 清理状态
            timeoutObj.timeout = null // 释放定时器引用
            context.options.thinkingTimeoutObject = undefined // 移除超时对象
        }

        const result = await this._runMiddleware(session, context)

        await context.recallThinkingMessage()

        return result
    }

    /**
     * 处理接收到的命令
     * @param session 会话对象
     * @param command 命令名称
     * @param options 命令选项
     * @returns 处理结果（是否成功）
     * 
     * 与普通消息处理的区别：
     * - 包含特定命令处理逻辑
     * - 支持额外的命令选项参数
     * - 执行命令特定的中间件流程
     */
    async receiveCommand(
        session: Session,
        command: string,
        options: ChainMiddlewareContextOptions = {}
    ) {
        const context: ChainMiddlewareContext = {
            config: this.config,
            message: options?.message ?? session.content,
            ctx: this.ctx,
            session,
            command,
            send: (message) => this.sendMessage(session, message),
            recallThinkingMessage: async () => {},
            options
        }

        context.recallThinkingMessage = async () => {
            if (!context.options?.thinkingTimeoutObject) return

            const timeoutObj = context.options.thinkingTimeoutObject

            // 清理所有定时器
            clearTimeout(timeoutObj.timeout!) // 清理主超时定时器
            timeoutObj.autoRecallTimeout && 
                clearTimeout(timeoutObj.autoRecallTimeout) // 清理自动撤回定时器

            // 执行撤回回调函数（如果存在）
            timeoutObj.recallFunc && (await timeoutObj.recallFunc())

            // 清理状态
            timeoutObj.timeout = null // 释放定时器引用
            context.options.thinkingTimeoutObject = undefined // 移除超时对象
        }

        const result = await this._runMiddleware(session, context)

        await context.recallThinkingMessage()

        return result
    }

    /**
     * 注册中间件
     * @param name 中间件名称
     * @param middleware 中间件处理函数
     * @param ctx 上下文对象（默认使用实例上下文）
     * @returns 中间件实例
     * 
     * 注册流程：
     * 1. 创建中间件实例
     * 2. 添加到依赖关系图
     * 3. 注册销毁时的清理逻辑
     */
    middleware<T extends keyof ChainMiddlewareName>(
        name: T,
        middleware: ChainMiddlewareFunction,
        ctx: Context = this.ctx
    ): ChainMiddleware {
        const result = new ChainMiddleware(name, middleware, this._graph)

        this._graph.addNode(result)

        ctx.on('dispose', () => {
            this._graph.removeNode(name)
        })

        return result
    }

    /**
     * 注册消息发送器
     * @param sender 发送器函数
     * 
     * 说明：
     * - 支持多个发送器并行发送
     * - 发送器按注册顺序执行
     * - 可用于实现消息的多渠道分发
     */
    sender(sender: ChatChainSender) {
        this._senders.push(sender)
    }

    /**
     * 执行中间件链
     * @param session 会话对象
     * @param context 中间件上下文
     * @returns 处理结果
     * 
     * 执行流程：
     * 1. 初始化错误消息模板
     * 2. 构建中间件执行列表
     * 3. 遍历执行中间件
     * 4. 记录执行时间
     * 5. 处理中间件返回结果
     * 6. 捕获并处理异常
     */
    private async _runMiddleware(
        session: Session,
        context: ChainMiddlewareContext
    ) {
        if (!this.isSetErrorMessage) {
            setErrorFormatTemplate(session.text('chatluna.error_message'))
            this.isSetErrorMessage = true
        }

        const originMessage = context.message

        const runList = this._graph.build()

        if (runList.length === 0) {
            return false
        }

        let isOutputLog = false

        for (const middleware of runList) {
            let result: ChainMiddlewareRunStatus | h[] | h | h[][] | string
            const startTime = Date.now()

            try {
                result = await middleware.run(session, context)

                // Log execution time if needed
                const shouldLogTime =
                    !middleware.name.startsWith('lifecycle-') &&
                    result !== ChainMiddlewareRunStatus.SKIPPED &&
                    middleware.name !== 'allow_reply' &&
                    Date.now() - startTime > 10

                if (shouldLogTime) {
                    logger.debug(
                        `middleware %c executed in %d ms`,
                        middleware.name,
                        Date.now() - startTime
                    )
                    isOutputLog = true
                }

                // Handle middleware result
                if (result === ChainMiddlewareRunStatus.STOP) {
                    await this.handleStopStatus(
                        session,
                        context,
                        originMessage,
                        isOutputLog
                    )
                    return false
                }

                if (result instanceof Array || typeof result === 'string') {
                    context.message = result
                }
            } catch (error) {
                await this.handleMiddlewareError(
                    session,
                    middleware.name,
                    error
                )
                return false
            }
        }

        if (isOutputLog) {
            logger.debug('-'.repeat(40) + '\n')
        }

        if (context.message != null && context.message !== originMessage) {
            // 消息被修改了
            await this.sendMessage(session, context.message)
        }

        return true
    }

    /**
     * 发送消息到所有注册的发送器
     * @param session 会话对象
     * @param message 要发送的消息内容
     * 
     * 消息处理逻辑：
     * 1. 标准化消息格式为数组
     * 2. 遍历所有发送器进行发送
     * 3. 支持多种消息格式（字符串/h对象/数组）
     */
    private async sendMessage(
        session: Session,
        message: h[] | h[][] | h | string
    ) {
        // check if message is a two-dimensional array

        const messages: (h[] | h | string)[] =
            message instanceof Array ? message : [message]

        for (const sender of this._senders) {
            await sender(session, messages)
        }
    }

    /**
     * 处理中间件链终止状态
     * @param session 会话对象
     * @param context 中间件上下文
     * @param originMessage 原始消息内容
     * @param isOutputLog 是否输出日志
     * 
     * 终止处理逻辑：
     * 1. 发送最终修改后的消息
     * 2. 清理日志分隔线
     */
    private async handleStopStatus(
        session: Session,
        context: ChainMiddlewareContext,
        originMessage: string | h[] | h[][],
        isOutputLog: boolean
    ) {
        if (context.message != null && context.message !== originMessage) {
            await this.sendMessage(session, context.message)
        }

        if (isOutputLog) {
            logger.debug('-'.repeat(40) + '\n')
        }
    }

    /**
     * 处理中间件执行错误
     * @param session 会话对象
     * @param middlewareName 中间件名称
     * @param error 错误对象
     * 
     * 错误处理流程：
     * 1. 识别特定ChatLuna错误类型
     * 2. 发送友好错误信息给用户
     * 3. 记录详细错误日志
     * 4. 清理错误处理状态
     */
    private async handleMiddlewareError(
        session: Session,
        middlewareName: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        error: any
    ) {
        if (error instanceof ChatLunaError) {
            const message =
                error.errorCode === ChatLunaErrorCode.ABORTED
                    ? session.text('chatluna.aborted')
                    : error.message
            await this.sendMessage(session, message)
            return
        }

        logger.error(`chat-chain: ${middlewareName} error ${error}`)
        logger.error(error)
        error.cause && logger.error(error.cause)
        logger.debug('-'.repeat(40) + '\n')

        await this.sendMessage(
            session,
            session.text('chatluna.middleware_error', [
                middlewareName,
                error.message
            ])
        )
    }
}

/**
 * 中间件依赖关系图
 * 
 * 功能：
 * - 管理中间件的依赖关系
 * - 检测循环依赖
 * - 生成拓扑排序执行顺序
 * - 缓存执行顺序优化性能
 * 
 * 实现特性：
 * - 使用Map结构存储节点和依赖关系
 * - 事件驱动依赖关系更新
 * - 支持动态添加/移除节点
 */
class ChatChainDependencyGraph {
    private _tasks = new Map<string, ChainDependencyGraphNode>()
    private _dependencies = new Map<string, Set<string>>()
    private _eventEmitter = new EventEmitter()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _listeners = new Map<string, Set<(...args: any[]) => void>>()
    private _cachedOrder: ChainMiddleware[] | null = null

    constructor() {
        this._eventEmitter.on('build_node', () => {
            for (const [name, listeners] of this._listeners) {
                for (const listener of listeners) {
                    listener(name)
                }
                listeners.clear()
            }
            // Invalidate cache when nodes change
            this._cachedOrder = null
        })
    }

    // Add a task to the DAG.
    public addNode(middleware: ChainMiddleware): void {
        this._tasks.set(middleware.name, {
            name: middleware.name,
            middleware
        })
        this._cachedOrder = null // Invalidate cache
    }

    removeNode(name: string): void {
        this._tasks.delete(name)

        // Efficiently remove dependencies
        this._dependencies.delete(name)
        for (const deps of this._dependencies.values()) {
            deps.delete(name)
        }

        this._cachedOrder = null // Invalidate cache
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    once(name: string, listener: (...args: any[]) => void) {
        const listeners = this._listeners.get(name) ?? new Set()
        listeners.add(listener)
        this._listeners.set(name, listeners)
    }

    // Set a dependency between two tasks
    before(
        taskA: ChainMiddleware | string,
        taskB: ChainMiddleware | string
    ): void {
        if (taskA instanceof ChainMiddleware) {
            taskA = taskA.name
        }
        if (taskB instanceof ChainMiddleware) {
            taskB = taskB.name
        }
        if (taskA && taskB) {
            // Add taskB to the dependencies of taskA
            const dependencies = this._dependencies.get(taskA) ?? new Set()
            dependencies.add(taskB)
            this._dependencies.set(taskA, dependencies)
        } else {
            throw new Error('Invalid tasks')
        }
    }

    // Set a reverse dependency between two tasks
    after(
        taskA: ChainMiddleware | string,
        taskB: ChainMiddleware | string
    ): void {
        if (taskA instanceof ChainMiddleware) {
            taskA = taskA.name
        }
        if (taskB instanceof ChainMiddleware) {
            taskB = taskB.name
        }
        if (taskA && taskB) {
            // Add taskB to the dependencies of taskA
            const dependencies = this._dependencies.get(taskB) ?? new Set()
            dependencies.add(taskA)
            this._dependencies.set(taskB, dependencies)
        } else {
            throw new Error('Invalid tasks')
        }
    }

    // Get dependencies of a task
    getDependencies(task: string) {
        return this._dependencies.get(task)
    }

    // Get dependents of a task
    getDependents(task: string): string[] {
        const dependents: string[] = []
        for (const [key, value] of this._dependencies.entries()) {
            if ([...value].includes(task)) {
                dependents.push(key)
            }
        }
        return dependents
    }

    // Build a two-dimensional array of tasks based on their dependencies
    build(): ChainMiddleware[] {
        // Return cached order if available
        if (this._cachedOrder) {
            return this._cachedOrder
        }

        this._eventEmitter.emit('build_node')
        // Create in-degree table and temporary graph
        const indegree = new Map<string, number>()
        const tempGraph = new Map<string, Set<string>>()

        // Initialize in-degree and temporary graph
        for (const taskName of this._tasks.keys()) {
            indegree.set(taskName, 0)
            tempGraph.set(taskName, new Set())
        }

        // Build temporary graph and calculate in-degree
        for (const [from, deps] of this._dependencies.entries()) {
            const depsSet = tempGraph.get(from) || new Set()
            for (const to of deps) {
                depsSet.add(to)
                indegree.set(to, (indegree.get(to) || 0) + 1)
            }
            tempGraph.set(from, depsSet)
        }

        const queue: string[] = []
        const result: ChainMiddleware[] = []
        const visited = new Set<string>()

        // Find nodes with in-degree of 0
        for (const [task, degree] of indegree.entries()) {
            if (degree === 0) {
                queue.push(task)
            }
        }

        // Topological sorting
        while (queue.length > 0) {
            const current = queue.shift()!

            if (visited.has(current)) {
                continue
            }
            visited.add(current)

            const node = this._tasks.get(current)
            if (node?.middleware) {
                result.push(node.middleware)
            }

            // Process all successors of the current node
            const successors = tempGraph.get(current) || new Set()
            for (const next of successors) {
                const newDegree = indegree.get(next)! - 1
                indegree.set(next, newDegree)

                if (newDegree === 0) {
                    queue.push(next)
                }
            }
        }

        // Check for circular dependencies
        for (const [node, degree] of indegree.entries()) {
            if (degree > 0) {
                throw new Error(
                    `Circular dependency detected involving node: ${node}`
                )
            }
        }

        // Check if all nodes have been visited
        if (visited.size !== this._tasks.size) {
            throw new Error(
                'Some nodes are unreachable in the dependency graph'
            )
        }

        this._cachedOrder = result
        return result
    }
}

/**
 * 依赖图节点接口
 * 
 * 属性说明：
 * - middleware: 关联的中间件实例
 * - name: 中间件名称
 */
interface ChainDependencyGraphNode {
    middleware?: ChainMiddleware
    name: string
}

/**
 * 中间件包装类
 * 
 * 职责：
 * - 管理中间件的依赖关系
 * - 提供before/after语法糖
 * - 连接中间件与依赖关系图
 * 
 * 生命周期管理：
 * - 自动处理生命周期中间件的顺序
 * - 支持非生命周期中间件的依赖锚定
 */
export class ChainMiddleware {
    constructor(
        readonly name: string,
        private readonly execute: ChainMiddlewareFunction,
        private readonly graph: ChatChainDependencyGraph
    ) {}

    before<T extends keyof ChainMiddlewareName>(name: T) {
        this.graph.before(this.name, name)

        if (this.name.startsWith('lifecycle-')) {
            return this
        }

        const lifecycleName = lifecycleNames

        // 现在我们需要基于当前添加的依赖，去寻找这个依赖锚定的生命周期

        // 如果当前添加的依赖是生命周期，那么我们需要找到这个生命周期的下一个生命周期
        if (lifecycleName.includes(name)) {
            const lastLifecycleName =
                lifecycleName[lifecycleName.indexOf(name) - 1]

            if (lastLifecycleName) {
                this.graph.after(this.name, lastLifecycleName)
            }

            return this
        }

        // 如果不是的话，我们就需要寻找依赖锚定的生命周期

        this.graph.once('build_node', () => {
            const beforeMiddlewares = [
                ...this.graph.getDependencies(name)
            ].filter((name) => name.startsWith('lifecycle-'))

            const afterMiddlewares = this.graph
                .getDependents(name)
                .filter((name) => name.startsWith('lifecycle-'))

            for (const before of beforeMiddlewares) {
                this.graph.before(this.name, before)
            }

            for (const after of afterMiddlewares) {
                this.graph.after(this.name, after)
            }
        })

        return this
    }

    after<T extends keyof ChainMiddlewareName>(name: T) {
        this.graph.after(this.name, name)

        if (this.name.startsWith('lifecycle-')) {
            return this
        }

        const lifecycleName = lifecycleNames

        // 现在我们需要基于当前添加的依赖，去寻找这个依赖锚定的生命周期

        // 如果当前添加的依赖是生命周期，那么我们需要找到这个生命周期的下一个生命周期
        if (lifecycleName.includes(name)) {
            const nextLifecycleName =
                lifecycleName[lifecycleName.indexOf(name) + 1]

            if (nextLifecycleName) {
                this.graph.before(this.name, nextLifecycleName)
            }

            return this
        }

        // 如果不是的话，我们就需要寻找依赖锚定的生命周期
        this.graph.once('build_node', () => {
            const beforeMiddlewares = [
                ...this.graph.getDependencies(name)
            ].filter((name) => name.startsWith('lifecycle-'))

            const afterMiddlewares = this.graph
                .getDependents(name)
                .filter((name) => name.startsWith('lifecycle-'))

            for (const before of beforeMiddlewares) {
                this.graph.before(this.name, before)
            }

            for (const after of afterMiddlewares) {
                this.graph.after(this.name, after)
            }
        })

        return this
    }

    run(session: Session, options: ChainMiddlewareContext) {
        return this.execute(session, options)
    }
}

/**
 * 默认消息发送器
 * 
 * 功能：
 * - 实现消息的两种发送模式：
 *   1. 普通模式（逐条发送）
 *   2. 转发模式（合并转发）
 * - 处理消息内容过滤
 * - 自动添加引用回复
 * 
 * 消息处理流程：
 * 1. 转换消息格式
 * 2. 过滤无效元素
 * 3. 添加会话上下文
 * 4. 选择发送模式
 */
class DefaultChatChainSender {
    constructor(private readonly config: Config) {}

    /**
     * 处理消息元素
     * @param elements 原始消息元素数组
     * @returns 处理后的消息元素数组
     * 
     * 处理步骤：
     * 1. 过滤无效元素：
     *    - 移除空元素
     *    - 过滤掉附件图片（src以attachment开头的img元素）
     * 2. 递归处理子元素：
     *    - 对每个元素的children属性进行相同处理
     * 3. 返回新处理后的元素数组
     * 
     * 过滤规则说明：
     * - 保留除附件图片外的所有有效元素
     * - 保持原有元素树形结构
     */
    private processElements(elements: h[]): h[] {
        return elements
            .filter((element): element is h => {
                if (!element) return false

                if (element.type === 'img') {
                    const src = element.attrs?.['src']
                    return !(
                        typeof src === 'string' && src.startsWith('attachment')
                    )
                }
                return true
            })
            .map((element) => {
                if (element.children?.length) {
                    element.children = this.processElements(element.children)
                }
                return element
            })
    }

    async send(
        session: Session,
        messages: (h[] | h | string)[]
    ): Promise<void> {
        if (!messages?.length) return

        if (this.config.isForwardMsg) {
            await this.sendAsForward(session, messages)
            return
        }

        await this.sendAsNormal(session, messages)
    }

    private async sendAsForward(
        session: Session,
        messages: (h[] | h | string)[]
    ): Promise<void> {
        const sendMessages = this.convertToForwardMessages(messages)

        if (
            sendMessages.length < 1 ||
            (sendMessages.length === 1 && sendMessages.join().length === 0)
        ) {
            return
        }

        await session.sendQueued(
            h('message', { forward: true }, ...sendMessages)
        )
    }

    private convertToForwardMessages(messages: (h[] | h | string)[]): h[] {
        const firstMsg = messages[0]

        if (Array.isArray(firstMsg)) {
            // h[][]
            return messages.map((msg) => h('message', ...(msg as h[])))
        }

        if (typeof firstMsg === 'object') {
            // h | h[]
            return [h('message', ...(messages as h[]))]
        }

        if (typeof firstMsg === 'string') {
            // string
            return [h.text(firstMsg)]
        }

        throw new Error(`Unsupported message type: ${typeof firstMsg}`)
    }

    /**
     * 普通模式发送消息
     * @param session 会话对象
     * @param messages 消息内容数组
     * 
     * 处理流程：
     * 1. 遍历所有消息
     * 2. 为每条消息构建消息片段
     * 3. 过滤无效元素
     * 4. 逐条发送处理后的消息
     * 5. 支持的消息类型：
     *    - 字符串文本
     *    - h对象
     *    - h对象数组
     */
    private async sendAsNormal(
        session: Session,
        messages: (h[] | h | string)[]
    ): Promise<void> {
        for (const message of messages) {
            const messageFragment = await this.buildMessageFragment(
                session,
                message
            )

            if (!messageFragment?.length) continue

            const processedFragment = this.processElements(messageFragment)
            await session.sendQueued(processedFragment)
        }
    }

    /**
     * 构建消息片段
     * @param session 会话对象
     * @param message 原始消息内容
     * @returns 处理后的消息元素数组
     * 
     * 处理流程：
     * 1. 判断是否需要添加引用回复：
     *    - 配置启用回复@
     *    - 非私聊会话
     *    - 存在消息ID
     * 2. 标准化消息格式为h数组
     * 3. 验证消息有效性：
     *    - 非空检查
     *    - 非空白内容检查
     * 4. 添加引用回复（如果兼容）：
     *    - 生成引用元素
     *    - 检查不兼容类型（音频/嵌套消息）
     *    - 返回组合后的消息片段
     * 5. 返回最终处理结果
     */
    private async buildMessageFragment(
        session: Session,
        message: h[] | h | string
    ): Promise<h[]> {
        const shouldAddQuote =
            this.config.isReplyWithAt &&
            session.isDirect === false &&
            session.messageId

        const messageContent = this.convertMessageToArray(message)

        if (
            messageContent == null ||
            messageContent.length < 1 ||
            (messageContent.length === 1 && messageContent.join().length === 0)
        ) {
            return
        }

        if (!shouldAddQuote) {
            return messageContent
        }

        // Check if quote should be removed (for audio or message types)
        const quote = h('quote', { id: session.messageId })
        const hasIncompatibleType = messageContent.some(
            (element) => element.type === 'audio' || element.type === 'message'
        )

        return hasIncompatibleType ? messageContent : [quote, ...messageContent]
    }

    /**
     * 标准化消息格式
     * @param message 原始消息内容
     * @returns 标准化后的h数组
     * 
     * 转换规则：
     * 1. 数组类型直接返回
     * 2. 字符串转换为包含h.text的数组
     * 3. 单个h对象包装为数组
     * 
     * 保证输出始终为h[]类型
     */
    private convertMessageToArray(message: h[] | h | string): h[] {
        if (Array.isArray(message)) {
            return message
        }
        if (typeof message === 'string') {
            return [h.text(message)]
        }
        return [message]
    }
}

/**
 * 中间件上下文接口
 * 
 * 包含属性：
 * - config: 插件配置
 * - ctx: Koishi上下文
 * - session: 当前会话
 * - message: 处理中的消息内容
 * - options: 中间件选项
 * - command: 当前命令（可选）
 * - recallThinkingMessage: 消息撤回方法
 * - send: 消息发送方法
 * 
 * 使用场景：
 * 中间件之间通过此上下文共享数据和状态
 */
export interface ChainMiddlewareContext {
    config: Config
    ctx: Context
    session: Session
    message: string | h[] | h[][]
    options?: ChainMiddlewareContextOptions
    command?: string
    recallThinkingMessage?: () => Promise<void>
    send: (message: h[][] | h[] | h | string) => Promise<void>
}

/**
 * 中间件上下文选项接口
 * 
 * 说明：
 * - 使用索引签名支持任意扩展属性
 * - 用于在中间件之间传递自定义参数
 */
export interface ChainMiddlewareContextOptions {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any
}

export interface ChainMiddlewareName {}

export type ChainMiddlewareFunction = (
    session: Session,
    context: ChainMiddlewareContext
) => Promise<string | h[] | h[][] | ChainMiddlewareRunStatus | null>

export type ChatChainSender = (
    session: Session,
    message: (h[] | h | string)[]
) => Promise<void>

/**
 * 中间件执行状态枚举
 * 
 * 状态说明：
 * - SKIPPED: 跳过后续处理
 * - STOP: 终止处理链
 * - CONTINUE: 继续执行（默认）
 * 
 * 使用规范：
 * 中间件应根据处理结果返回适当的状态码
 */
export enum ChainMiddlewareRunStatus {
    SKIPPED = 0,
    STOP = 1,
    CONTINUE = 2
}
