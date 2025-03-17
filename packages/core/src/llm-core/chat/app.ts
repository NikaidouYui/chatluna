import { BaseChatMessageHistory } from '@langchain/core/chat_history'
import { Embeddings } from '@langchain/core/embeddings'
import { ChainValues } from '@langchain/core/utils/types'
import { Context } from 'koishi'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { BufferMemory } from 'koishi-plugin-chatluna/llm-core/memory/langchain'
import { logger } from 'koishi-plugin-chatluna'
import { ConversationRoom } from '../../types'
import {
    ChatLunaError,
    ChatLunaErrorCode
} from 'koishi-plugin-chatluna/utils/error'
import { ChatLunaLLMCallArg, ChatLunaLLMChainWrapper } from '../chain/base'
import { KoishiChatMessageHistory } from 'koishi-plugin-chatluna/llm-core/memory/message'
import { emptyEmbeddings } from 'koishi-plugin-chatluna/llm-core/model/in_memory'
import {
    PlatformEmbeddingsClient,
    PlatformModelAndEmbeddingsClient,
    PlatformModelClient
} from 'koishi-plugin-chatluna/llm-core/platform/client'
import {
    ClientConfig,
    ClientConfigWrapper
} from 'koishi-plugin-chatluna/llm-core/platform/config'
import {
    ChatHubBaseEmbeddings,
    ChatLunaChatModel
} from 'koishi-plugin-chatluna/llm-core/platform/model'
import { PlatformService } from 'koishi-plugin-chatluna/llm-core/platform/service'
import { ModelInfo } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { PresetTemplate } from 'koishi-plugin-chatluna/llm-core/prompt'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import type { HandlerResult } from '../../utils/types'

/**
 * ChatInterface 类
 * 负责管理聊天接口的核心功能，包括模型初始化、聊天历史管理、错误处理等
 */
export class ChatInterface {
    // 私有成员变量，存储聊天接口的配置和状态
    private _input: ChatInterfaceInput
    private _chatHistory: KoishiChatMessageHistory
    private _chains: Record<string, ChatLunaLLMChainWrapper> = {}
    private _embeddings: Embeddings
    private _errorCountsMap: Record<string, number[]> = {}
    private _chatCount = 0

    /**
     * 初始化聊天接口
     * @param ctx Koishi上下文
     * @param input 聊天接口配置
     */
    constructor(
        public ctx: Context,
        input: ChatInterfaceInput
    ) {
        this._input = input 
    }

    /**
     * 处理聊天过程中的错误
     * @param error 错误对象
     * @param config 客户端配置
     * 步骤:
     * 1. 获取配置MD5值作为唯一标识
     * 2. 特殊处理不安全内容错误
     * 3. 记录错误发生时间
     * 4. 检查是否需要禁用配置
     * 5. 转换错误类型并抛出
     */
    private async handleChatError(error: unknown, config: ClientConfigWrapper): Promise<never> {
        const configMD5 = config.md5()

        if (
            error instanceof ChatLunaError &&
            error.errorCode === ChatLunaErrorCode.API_UNSAFE_CONTENT
        ) {
            throw error
        }

        this._errorCountsMap[configMD5] = this._errorCountsMap[configMD5] ?? []
        const errorTimes = this._errorCountsMap[configMD5]

        // Add current error timestamp
        errorTimes.push(Date.now())

        // Keep only recent errors
        if (errorTimes.length > config.value.maxRetries * 3) {
            this._errorCountsMap[configMD5] = errorTimes.slice(
                -config.value.maxRetries * 3
            )
        }

        // Check if we need to disable the config
        const recentErrors = errorTimes.slice(-config.value.maxRetries)
        if (
            recentErrors.length >= config.value.maxRetries &&
            checkRange(recentErrors, 1000 * 60 * 20)
        ) {
            await this.disableConfig(config)
        }

        if (error instanceof ChatLunaError) {
            throw error
        }

        throw new ChatLunaError(ChatLunaErrorCode.UNKNOWN_ERROR, error as Error)
    }

    private async disableConfig(config: ClientConfigWrapper): Promise<void> {
        const configMD5 = config.md5()
        delete this._chains[configMD5]
        delete this._errorCountsMap[configMD5]

        const service = this.ctx.chatluna.platform
        await service.makeConfigStatus(config.value, false)
    }

    async chat(arg: ChatLunaLLMCallArg): Promise<ChainValues> {
        const [wrapper, config] = await this.createChatLunaLLMChainWrapper()

        try {
            await this.ctx.parallel(
                'chatluna/before-chat',
                arg.conversationId,
                arg.message,
                arg.variables,
                this,
                wrapper
            )
        } catch (error) {
            logger.error('Something went wrong when calling before-chat hook:')
            logger.error(error)
        }

        const additionalArgs = await this._chatHistory.getAdditionalArgs()
        arg.variables = { ...additionalArgs, ...arg.variables }

        try {
            const response = await this.processChat(arg, wrapper)

            delete this._errorCountsMap[config.md5()]
            return response
        } catch (error) {
            await this.handleChatError(error, config)
        }
    }

    private async processChat(
        arg: ChatLunaLLMCallArg,
        wrapper: ChatLunaLLMChainWrapper
    ): Promise<ChainValues> {
        const response = (
            (await wrapper.call({
                ...arg,
                maxToken: (await this.preset)?.config?.maxOutputToken
            })) as {
                message: AIMessage
            } & ChainValues
        ).message

        const displayRespose = new AIMessage(response)

        displayRespose.additional_kwargs = response.additional_kwargs

        this._chatCount++

        // Handle post-processing if needed
        if (arg.postHandler) {
            const handlerResult = await this.handlePostProcessing(
                arg,
                displayRespose
            )
            displayRespose.content = handlerResult.displayContent
            await this._chatHistory.overrideAdditionalArgs(
                handlerResult.variables
            )
        }

        const messageContent = getMessageContent(displayRespose.content)

        // Update chat history
        if (messageContent.trim().length > 0) {
            await this.chatHistory.addMessage(arg.message)
            let saveMessage = response
            if (!this.ctx.chatluna.config.rawOnCensor) {
                saveMessage = displayRespose
            }
            await this.chatHistory.addMessage(saveMessage)
        }

        // Process response
        this.ctx.parallel(
            'chatluna/after-chat',
            arg.conversationId,
            arg.message,
            displayRespose as AIMessage,
            { ...arg.variables, chatCount: this._chatCount },
            this,
            wrapper
        )

        return { message: displayRespose }
    }

    private async handlePostProcessing(
        arg: ChatLunaLLMCallArg,
        message: AIMessage
    ): Promise<HandlerResult> {
        logger.debug(`original content: %c`, message.content)

        return await arg.postHandler.handler(
            arg.session,
            getMessageContent(message.content)
        )
    }

    async createChatLunaLLMChainWrapper(): Promise<
        [ChatLunaLLMChainWrapper, ClientConfigWrapper]
    > {
        const service = this.ctx.chatluna.platform
        const [llmPlatform, llmModelName] = parseRawModelName(this._input.model)
        const currentLLMConfig = await service.randomConfig(llmPlatform)

        if (this._chains[currentLLMConfig.md5()]) {
            return [this._chains[currentLLMConfig.md5()], currentLLMConfig]
        }

        let embeddings: Embeddings

        let llm: ChatLunaChatModel
        let modelInfo: ModelInfo
        let historyMemory: BufferMemory

        try {
            embeddings = await this._initEmbeddings(service)
        } catch (error) {
            if (error instanceof ChatLunaError) {
                throw error
            }
            throw new ChatLunaError(
                ChatLunaErrorCode.EMBEDDINGS_INIT_ERROR,
                error
            )
        }

        try {
            ;[llm, modelInfo] = await this._initModel(
                service,
                currentLLMConfig.value,
                llmModelName
            )
        } catch (error) {
            if (error instanceof ChatLunaError) {
                throw error
            }
            throw new ChatLunaError(ChatLunaErrorCode.MODEL_INIT_ERROR, error)
        }

        try {
            await this._createChatHistory()
        } catch (error) {
            if (error instanceof ChatLunaError) {
                throw error
            }
            throw new ChatLunaError(
                ChatLunaErrorCode.CHAT_HISTORY_INIT_ERROR,
                error
            )
        }

        try {
            historyMemory = this._createHistoryMemory()
        } catch (error) {
            if (error instanceof ChatLunaError) {
                throw error
            }
            throw new ChatLunaError(ChatLunaErrorCode.UNKNOWN_ERROR, error)
        }

        const chatChain = await service.createChatChain(this._input.chatMode, {
            botName: this._input.botName,
            model: llm,
            embeddings,
            historyMemory,
            preset: this._input.preset,
            vectorStoreName: this._input.vectorStoreName,
            supportChatChain: this._supportChatMode(modelInfo)
        })

        this._chains[currentLLMConfig.md5()] = chatChain
        this._embeddings = embeddings

        return [chatChain, currentLLMConfig]
    }

    get chatHistory(): BaseChatMessageHistory {
        return this._chatHistory
    }

    get chatMode(): string {
        return this._input.chatMode
    }

    get embeddings(): Embeddings {
        return this._embeddings
    }

    get preset(): Promise<PresetTemplate> {
        return this._input.preset()
    }

    async delete(ctx: Context, room: ConversationRoom): Promise<void> {
        await this.clearChatHistory()

        for (const chain of Object.values(this._chains)) {
            await chain.model.clearContext(room.conversationId)
        }

        this._chains = {}

        await ctx.database.remove('chathub_conversation', {
            id: room.conversationId
        })

        await ctx.database.remove('chathub_room', {
            roomId: room.roomId
        })
        await ctx.database.remove('chathub_room_member', {
            roomId: room.roomId
        })
        await ctx.database.remove('chathub_room_group_member', {
            roomId: room.roomId
        })

        await ctx.database.remove('chathub_user', {
            defaultRoomId: room.roomId
        })

        await ctx.database.remove('chathub_message', {
            conversation: room.conversationId
        })
    }

    async clearChatHistory(): Promise<void> {
        if (this._chatHistory == null) {
            await this._createChatHistory()
        }

        await this.ctx.root.parallel(
            'chatluna/clear-chat-history',
            this._input.conversationId,
            this
        )

        await this._chatHistory.clear()

        for (const chain of Object.values(this._chains)) {
            await chain.model.clearContext(this._input.conversationId)
        }
    }

    /**
     * 初始化Embeddings模型
     * @param service 平台服务实例
     * 步骤:
     * 1. 检查embeddings配置是否为空
     * 2. 解析模型名称获取平台和模型信息
     * 3. 获取随机可用客户端
     * 4. 根据客户端类型创建对应的embeddings模型
     * 5. 处理不支持的情况，返回空embeddings
     */
    private async _initEmbeddings(service: PlatformService): Promise<ChatHubBaseEmbeddings> {
        // 检查embeddings配置
        if (this._input.embeddings == null || 
            this._input.embeddings.length < 1 || 
            this._input.embeddings === '无') {
            // 处理空配置情况
            if (this._input.vectorStoreName != null && 
                this._input.vectorStoreName?.length > 0 && 
                this._input.vectorStoreName !== '无') {
                logger.warn('Embeddings配置为空，使用空embeddings。请检查配置。')
            }
            return emptyEmbeddings
        }

        // 解析模型名称
        const [platform, modelName] = parseRawModelName(this._input.embeddings)

        logger.info(`初始化embeddings: ${this._input.embeddings}`)

        // 获取随机客户端
        const client = await service.randomClient(platform)

        // 处理不支持的平台
        if (client == null || client instanceof PlatformModelClient) {
            logger.warn(`平台 ${platform} 不支持，使用空embeddings`)
            return emptyEmbeddings
        }

        // 根据客户端类型创建模型
        if (client instanceof PlatformEmbeddingsClient) {
            return client.createModel(modelName)
        } else if (client instanceof PlatformModelAndEmbeddingsClient) {
            const model = client.createModel(modelName)

            if (model instanceof ChatLunaChatModel) {
                logger.warn(`模型 ${modelName} 不是embeddings模型，使用空embeddings`)
                return emptyEmbeddings
            }

            return model
        }
    }

    /**
     * 初始化LLM模型
     * @param service 平台服务
     * @param config 客户端配置
     * @param llmModelName 模型名称
     * 步骤:
     * 1. 获取平台客户端
     * 2. 获取模型信息
     * 3. 创建模型实例
     * 4. 验证模型类型并返回
     */
    private async _initModel(
        service: PlatformService,
        config: ClientConfig,
        llmModelName: string
    ): Promise<[ChatLunaChatModel, ModelInfo]> {
        // 获取平台客户端
        const platform = await service.getClient(config)

        // 查找模型信息
        const llmInfo = (await platform.getModels())
            .find(model => model.name === llmModelName)

        // 创建模型实例
        const llmModel = platform.createModel(llmModelName)

        // 验证模型类型
        if (llmModel instanceof ChatLunaChatModel) {
            return [llmModel, llmInfo]
        }
    }

    private _supportChatMode(modelInfo: ModelInfo) {
        if (
            // default check
            (!modelInfo.supportMode?.includes(this._input.chatMode) &&
                // all
                !modelInfo.supportMode?.includes('all')) ||
            // func call with plugin
            (!modelInfo.functionCall && this._input.chatMode === 'plugin')
        ) {
            logger.warn(
                `Chat mode ${this._input.chatMode} is not supported by model ${this._input.model}`
            )

            return false
        }

        return true
    }

    private async _createChatHistory(): Promise<BaseChatMessageHistory> {
        if (this._chatHistory != null) {
            return this._chatHistory
        }

        this._chatHistory = new KoishiChatMessageHistory(
            this.ctx,
            this._input.conversationId,
            this._input.maxMessagesCount
        )

        await this._chatHistory.loadConversation()

        return this._chatHistory
    }

    private _createHistoryMemory() {
        return new BufferMemory({
            returnMessages: true,
            inputKey: 'input',
            outputKey: 'output',
            chatHistory: this._chatHistory,
            humanPrefix: 'user',
            aiPrefix: this._input.botName
        })
    }
}

/**
 * 聊天接口输入参数接口
 */
export interface ChatInterfaceInput {
    chatMode: string             // 聊天模式
    botName?: string            // 机器人名称
    preset?: () => Promise<PresetTemplate>  // 预设模板
    model: string               // 模型名称
    embeddings?: string        // 向量嵌入模型
    vectorStoreName?: string   // 向量存储名称
    conversationId: string     // 会话ID
    maxMessagesCount: number   // 最大消息数量
}

function checkRange(times: number[], delayTime: number) {
    const first = times[0]
    const last = times[times.length - 1]

    return last - first < delayTime
}

declare module 'koishi' {
    interface Events {
        'chatluna/before-chat': (
            conversationId: string,
            message: HumanMessage,
            promptVariables: ChainValues,
            chatInterface: ChatInterface,
            chain: ChatLunaLLMChainWrapper
        ) => Promise<void>
        'chatluna/after-chat': (
            conversationId: string,
            sourceMessage: HumanMessage,
            responseMessage: AIMessage,
            promptVariables: ChainValues,
            chatInterface: ChatInterface,
            chain: ChatLunaLLMChainWrapper
        ) => Promise<void>
        'chatluna/clear-chat-history': (
            conversationId: string,
            chatInterface: ChatInterface
        ) => Promise<void>
    }
}
